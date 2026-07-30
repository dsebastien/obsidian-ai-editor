import { describe, expect, it } from 'bun:test'
import {
    beginCommentJob,
    canCancelCommentJob,
    canDismissCommentJob,
    canRetryCommentJob,
    commentJobAccessibleName,
    commentJobView,
    completeCommentJob,
    dismissCommentJob,
    failCommentJob,
    formatElapsed,
    interruptCommentJob,
    isCommentInFlight,
    restartCommentJob,
    summarizeCommentJobs
} from './comment-job'
import { rawFindingSchema } from '../operations/contract'
import type { RawFinding } from '../operations/contract'
import { loadCommentStore, marginCommentSchema } from './margin-comment'
import type { MarginComment, MarginCommentStatus } from './margin-comment'

function finding(overrides: Partial<RawFinding> = {}): RawFinding {
    return rawFindingSchema.parse({ quote: 'q', critique: 'c', severity: 'info', ...overrides })
}

function comment(overrides: Partial<MarginComment> = {}): MarginComment {
    return marginCommentSchema.parse({
        id: 'c1',
        quote: 'the quick brown fox',
        instruction: 'Is this cliché?',
        editorId: 'editor-1',
        editorName: 'Concision Editor',
        status: 'submitted',
        createdAt: 1_000,
        updatedAt: 1_000,
        ...overrides
    })
}

const ALL_STATUSES: readonly MarginCommentStatus[] = [
    'submitted',
    'running',
    'interrupted',
    'done',
    'failed',
    'dismissed'
]

describe('comment job status predicates', () => {
    it('counts only submitted and running as in flight', () => {
        expect(ALL_STATUSES.filter(isCommentInFlight)).toEqual(['submitted', 'running'])
    })

    it('offers retry for the two statuses that ended without an answer', () => {
        expect(ALL_STATUSES.filter(canRetryCommentJob)).toEqual(['interrupted', 'failed'])
    })

    it('never offers retry on a done job — that would destroy the answer', () => {
        expect(canRetryCommentJob('done')).toBe(false)
    })

    it('offers cancel only while something is queued or in flight', () => {
        expect(ALL_STATUSES.filter(canCancelCommentJob)).toEqual(['submitted', 'running'])
    })

    it('offers dismiss everywhere except on an already-dismissed comment', () => {
        expect(ALL_STATUSES.filter(canDismissCommentJob)).not.toContain('dismissed')
        expect(canDismissCommentJob('interrupted')).toBe(true)
    })
})

describe('comment job transitions', () => {
    it('begins a submitted job and stamps the change', () => {
        const next = beginCommentJob(comment(), 5_000)
        expect(next?.status).toEqual('running')
        expect(next?.updatedAt).toEqual(5_000)
    })

    it('refuses to begin anything that is not submitted', () => {
        for (const status of ALL_STATUSES.filter((value) => value !== 'submitted')) {
            expect(beginCommentJob(comment({ status }), 5_000)).toBeNull()
        }
    })

    it('completes from either in-flight status (a fast backend may beat the running write)', () => {
        for (const status of ['submitted', 'running'] as const) {
            const next = completeCommentJob(
                comment({ status }),
                { findings: [], reply: 'Reads fine.' },
                7_000
            )
            expect(next?.status).toEqual('done')
            expect(next?.reply).toEqual('Reads fine.')
        }
    })

    it('carries the findings onto the completed comment', () => {
        const reported = finding({ quote: 'the quick brown fox', critique: 'Cliché opener.' })
        const next = completeCommentJob(comment(), { findings: [reported], reply: null }, 7_000)
        expect(next?.findings).toHaveLength(1)
        expect(next?.findings[0]?.critique).toEqual('Cliché opener.')
        // No reply key at all rather than an empty string: the schema makes it
        // optional and a blank answer is an absent one.
        expect(next?.reply).toBeUndefined()
    })

    it('drops a previous error when the job completes', () => {
        const next = completeCommentJob(
            comment({ status: 'running', error: 'stale failure' }),
            { findings: [], reply: null },
            7_000
        )
        expect(next?.error).toBeUndefined()
    })

    it('refuses to complete a job that already ended', () => {
        for (const status of ['done', 'failed', 'dismissed', 'interrupted'] as const) {
            expect(
                completeCommentJob(comment({ status }), { findings: [], reply: 'late' }, 9_000)
            ).toBeNull()
        }
    })

    it('fails with the message it was given (redaction happens upstream)', () => {
        const next = failCommentJob(comment({ status: 'running' }), 'HTTP 401', 8_000)
        expect(next?.status).toEqual('failed')
        expect(next?.error).toEqual('HTTP 401')
    })

    it('interrupts only what is in flight, so unload never rewrites a settled job', () => {
        expect(interruptCommentJob(comment({ status: 'running' }), 9_000)?.status).toEqual(
            'interrupted'
        )
        expect(interruptCommentJob(comment({ status: 'done' }), 9_000)).toBeNull()
        expect(interruptCommentJob(comment({ status: 'failed' }), 9_000)).toBeNull()
    })

    it('dismisses from any other status and refuses a second time', () => {
        expect(dismissCommentJob(comment({ status: 'interrupted' }), 9_000)?.status).toEqual(
            'dismissed'
        )
        expect(dismissCommentJob(comment({ status: 'dismissed' }), 9_000)).toBeNull()
    })

    it('restarts an interrupted job as a fresh request, clearing the last round', () => {
        const stale = comment({
            status: 'interrupted',
            error: 'previous failure',
            reply: 'previous answer',
            findings: [finding()]
        })
        const next = restartCommentJob(stale, 10_000)
        expect(next?.status).toEqual('submitted')
        expect(next?.error).toBeUndefined()
        expect(next?.reply).toBeUndefined()
        expect(next?.findings).toEqual([])
        // Never a resumption: retry starts the lifecycle over from `submitted`.
        expect(next?.updatedAt).toEqual(10_000)
    })

    it('restarts a failed job and refuses everything else', () => {
        expect(restartCommentJob(comment({ status: 'failed' }), 10_000)?.status).toEqual(
            'submitted'
        )
        for (const status of ['submitted', 'running', 'done', 'dismissed'] as const) {
            expect(restartCommentJob(comment({ status }), 10_000)).toBeNull()
        }
    })

    it('never mutates the comment it was given', () => {
        const original = comment({ status: 'running' })
        failCommentJob(original, 'boom', 11_000)
        expect(original.status).toEqual('running')
        expect(original.error).toBeUndefined()
    })
})

describe('interrupted-job semantics across a restart', () => {
    it('loads an in-flight job back as interrupted, and it offers retry', () => {
        const loaded = loadCommentStore({
            schemaVersion: 1,
            notes: {
                'Note.md': [comment({ id: 'a', status: 'running' }), comment({ id: 'b' })]
            }
        })
        const restored = loaded.store.notes['Note.md'] ?? []
        expect(restored.map((entry) => entry.status)).toEqual(['interrupted', 'interrupted'])
        expect(loaded.interrupted).toEqual(['a', 'b'])
        expect(restored.every((entry) => canRetryCommentJob(entry.status))).toBe(true)
    })

    it('leaves a failed job failed across a restart — its reason survives', () => {
        const loaded = loadCommentStore({
            schemaVersion: 1,
            notes: { 'Note.md': [comment({ status: 'failed', error: 'HTTP 500' })] }
        })
        const restored = loaded.store.notes['Note.md']?.[0]
        expect(restored?.status).toEqual('failed')
        expect(restored?.error).toEqual('HTTP 500')
        expect(loaded.interrupted).toEqual([])
    })
})

describe('formatElapsed', () => {
    it('renders m:ss under an hour', () => {
        expect(formatElapsed(0)).toEqual('0:00')
        expect(formatElapsed(7_000)).toEqual('0:07')
        expect(formatElapsed(27_400)).toEqual('0:27')
        expect(formatElapsed(64_000)).toEqual('1:04')
        expect(formatElapsed(59 * 60_000 + 59_000)).toEqual('59:59')
    })

    it('renders h:mm:ss past the hour', () => {
        expect(formatElapsed(3_600_000)).toEqual('1:00:00')
        expect(formatElapsed(3_723_000)).toEqual('1:02:03')
    })

    it('clamps a clock that moved backwards instead of showing negative time', () => {
        expect(formatElapsed(-5_000)).toEqual('0:00')
        expect(formatElapsed(Number.NaN)).toEqual('0:00')
    })
})

describe('commentJobView', () => {
    it('times a running job from its start, not from the store timestamp', () => {
        const view = commentJobView({
            comment: comment({ status: 'running', updatedAt: 1_000 }),
            startedAt: 100_000,
            now: 127_000
        })
        expect(view.statusLabel).toEqual('Reviewing')
        expect(view.timer).toEqual('0:27')
    })

    it('shows no timer for a job the registry is not tracking', () => {
        const view = commentJobView({
            comment: comment({ status: 'running' }),
            startedAt: null,
            now: 500_000
        })
        expect(view.timer).toBeNull()
    })

    it('never times a restored interrupted job — the elapsed time is unknowable', () => {
        const view = commentJobView({
            comment: comment({ status: 'interrupted', updatedAt: 1_000 }),
            startedAt: 1_000,
            now: 9_999_000
        })
        expect(view.timer).toBeNull()
        expect(view.statusLabel).toEqual('Interrupted')
        expect(view.canRetry).toBe(true)
        expect(view.canCancel).toBe(false)
    })

    it('says nothing was resumed, in the one place the user meets the state', () => {
        const view = commentJobView({
            comment: comment({ status: 'interrupted' }),
            startedAt: null,
            now: 0
        })
        expect(view.detail).toContain('Nothing was resumed')
    })

    it('surfaces the failure message and offers retry', () => {
        const view = commentJobView({
            comment: comment({ status: 'failed', error: 'HTTP 401 Unauthorized' }),
            startedAt: null,
            now: 0
        })
        expect(view.detail).toEqual('HTTP 401 Unauthorized')
        expect(view.canRetry).toBe(true)
    })

    it('counts findings on a done job and offers no retry', () => {
        const one = commentJobView({
            comment: comment({ status: 'done', findings: [finding()] }),
            startedAt: null,
            now: 0
        })
        expect(one.statusLabel).toEqual('1 finding')
        expect(one.canRetry).toBe(false)
        const two = commentJobView({
            comment: comment({ status: 'done', findings: [finding(), finding()] }),
            startedAt: null,
            now: 0
        })
        expect(two.statusLabel).toEqual('2 findings')
    })

    it('distinguishes a note-level answer from a silent one', () => {
        expect(
            commentJobView({
                comment: comment({ status: 'done', reply: 'Looks good to me.' }),
                startedAt: null,
                now: 0
            })
        ).toMatchObject({ statusLabel: 'Answered', detail: 'Looks good to me.' })
        expect(
            commentJobView({
                comment: comment({ status: 'done' }),
                startedAt: null,
                now: 0
            }).statusLabel
        ).toEqual('Nothing to report')
    })

    it('collapses and clips a long detail so a row cannot become a wall of text', () => {
        const view = commentJobView({
            comment: comment({ status: 'failed', error: `a\n\nb${'x'.repeat(300)}` }),
            startedAt: null,
            now: 0
        })
        expect(view.detail).toContain('a b')
        expect(view.detail?.endsWith('…')).toBe(true)
        expect((view.detail ?? '').length).toBeLessThanOrEqual(161)
    })
})

describe('accessible name and tally', () => {
    it('folds the label and the live timer into one announced sentence', () => {
        const view = commentJobView({
            comment: comment({ status: 'running' }),
            startedAt: 0,
            now: 27_000
        })
        expect(commentJobAccessibleName(view, 'Fact Checker')).toEqual(
            'Fact Checker — Reviewing — for 0:27'
        )
    })

    it('drops the timer from the name when there is none', () => {
        const view = commentJobView({
            comment: comment({ status: 'interrupted' }),
            startedAt: null,
            now: 0
        })
        expect(commentJobAccessibleName(view, 'Fact Checker')).toEqual('Fact Checker — Interrupted')
    })

    it('tallies only the states worth announcing', () => {
        const views = (
            ['running', 'submitted', 'interrupted', 'failed', 'done', 'dismissed'] as const
        ).map((status) => commentJobView({ comment: comment({ status }), startedAt: null, now: 0 }))
        expect(summarizeCommentJobs(views)).toEqual('2 running, 1 interrupted, 1 failed')
    })

    it('says nothing at all when nothing is happening', () => {
        const views = [
            commentJobView({ comment: comment({ status: 'done' }), startedAt: null, now: 0 })
        ]
        expect(summarizeCommentJobs(views)).toEqual('')
        expect(summarizeCommentJobs([])).toEqual('')
    })
})
