import { describe, expect, it } from 'bun:test'
import { commentJobView } from '../domain/comments/comment-job'
import { marginCommentSchema } from '../domain/comments/margin-comment'
import type { MarginComment, MarginCommentStatus } from '../domain/comments/margin-comment'
import { commentJobsSection, commentRetryNotice, commentStartNotice } from './comment-jobs-model'

function comment(overrides: Partial<MarginComment> = {}): MarginComment {
    return marginCommentSchema.parse({
        id: 'c1',
        quote: 'the claim',
        instruction: 'Is this supported?',
        editorId: 'editor-1',
        editorName: 'Fact Checker',
        status: 'submitted',
        createdAt: 1,
        updatedAt: 1,
        ...overrides
    })
}

function section(
    comments: readonly MarginComment[],
    options: { startedAt?: number | null; now?: number; names?: Record<string, string> } = {}
) {
    return commentJobsSection({
        comments,
        views: comments.map((entry) =>
            commentJobView({
                comment: entry,
                startedAt: options.startedAt ?? null,
                now: options.now ?? 0
            })
        ),
        editorName: (id) => options.names?.[id] ?? null
    })
}

describe('comment jobs section', () => {
    it('is absent entirely when there is nothing to show', () => {
        expect(section([])).toEqual({ heading: null, rows: [] })
    })

    it('lists one row per live comment with its question and editor', () => {
        const result = section([comment()])
        expect(result.rows).toHaveLength(1)
        expect(result.rows[0]?.question).toEqual('Is this supported?')
        expect(result.rows[0]?.editorName).toEqual('Fact Checker')
    })

    it('prefers the editor CURRENT name over the one denormalized at creation', () => {
        const result = section([comment()], { names: { 'editor-1': 'Fact Checker v2' } })
        expect(result.rows[0]?.editorName).toEqual('Fact Checker v2')
    })

    it('falls back to the denormalized name when the editor is gone', () => {
        expect(section([comment()]).rows[0]?.editorName).toEqual('Fact Checker')
        expect(section([comment({ editorName: '' })]).rows[0]?.editorName).toEqual('Unknown editor')
    })

    it('hides dismissed comments without deleting them', () => {
        const result = section([comment({ id: 'a', status: 'dismissed' }), comment({ id: 'b' })])
        expect(result.rows.map((row) => row.commentId)).toEqual(['b'])
    })

    it('is absent when every comment is dismissed', () => {
        expect(section([comment({ status: 'dismissed' })]).heading).toBeNull()
    })

    it('puts what needs attention first and keeps the rest in stored order', () => {
        const statuses: MarginCommentStatus[] = ['done', 'interrupted', 'done', 'running', 'failed']
        const comments = statuses.map((status, index) =>
            comment({ id: `c${index}`, status, ...(status === 'failed' ? { error: 'boom' } : {}) })
        )
        const result = section(comments)
        expect(result.rows.map((row) => row.commentId)).toEqual(['c1', 'c3', 'c4', 'c0', 'c2'])
    })

    it('heads with the live tally when something is happening', () => {
        const result = section([
            comment({ id: 'a', status: 'running' }),
            comment({ id: 'b', status: 'interrupted' }),
            comment({ id: 'c', status: 'done' })
        ])
        expect(result.heading).toEqual('Background comments — 1 running, 1 interrupted')
    })

    it('heads with a plain count when everything has settled', () => {
        expect(section([comment({ status: 'done' })]).heading).toEqual(
            'Background comments — 1 comment'
        )
        expect(
            section([comment({ id: 'a', status: 'done' }), comment({ id: 'b', status: 'done' })])
                .heading
        ).toEqual('Background comments — 2 comments')
    })

    it('carries the live timer and the actions each row offers', () => {
        const result = section([comment({ status: 'running' })], {
            startedAt: 1_000,
            now: 1_000 + 65_000
        })
        const row = result.rows[0]
        expect(row?.view.timer).toEqual('1:05')
        expect(row?.view.canCancel).toBe(true)
        expect(row?.view.canRetry).toBe(false)
        expect(row?.accessibleName).toEqual('Fact Checker — Reviewing — for 1:05')
    })

    it('offers retry on an interrupted row and says nothing was resumed', () => {
        const row = section([comment({ status: 'interrupted' })]).rows[0]
        expect(row?.view.canRetry).toBe(true)
        expect(row?.view.detail).toContain('Nothing was resumed')
    })

    it('clips a long question to one line', () => {
        const row = section([comment({ instruction: 'why '.repeat(80) })]).rows[0]
        expect(row?.question.endsWith('…')).toBe(true)
        expect((row?.question ?? '').length).toBeLessThanOrEqual(91)
    })
})

describe('retry notices', () => {
    it('says nothing when the retry actually started — the row says it', () => {
        expect(commentRetryNotice('started')).toBeNull()
    })

    it('explains every refusal, so a click never looks ignored', () => {
        const refusals = [
            'excluded',
            'rule-disabled',
            'no-editor',
            'needs-confirmation',
            'invalid-span',
            'note-full',
            'already-running',
            'unknown-comment',
            'not-retryable',
            'orphaned'
        ] as const
        for (const status of refusals) {
            const message = commentRetryNotice(status)
            expect(message).not.toBeNull()
            expect((message ?? '').length).toBeGreaterThan(0)
        }
    })

    it('tells the truth about an orphaned comment: kept, not deleted, not re-askable', () => {
        const message = commentRetryNotice('orphaned') ?? ''
        expect(message).toContain('no longer in the note')
        expect(message).not.toContain('deleted')
    })
})

describe('commentStartNotice', () => {
    it('stays silent on success — the margin card is the feedback', () => {
        expect(commentStartNotice('started')).toBeNull()
    })

    it('says something for every refusal a new comment can hit', () => {
        const refusals = [
            'excluded',
            'rule-disabled',
            'no-editor',
            'needs-confirmation',
            'invalid-span',
            'note-full',
            'already-running'
        ] as const
        for (const status of refusals) {
            const message = commentStartNotice(status)
            expect(message).not.toBeNull()
            expect((message ?? '').length).toBeGreaterThan(0)
        }
    })

    it('tells the user what to do when the note is at the comment limit', () => {
        const message = commentStartNotice('note-full') ?? ''
        expect(message).toContain('Resolve or delete')
    })

    it('asks for a selection rather than reporting an internal state', () => {
        expect(commentStartNotice('invalid-span')).toBe('Select the text to comment on first.')
    })
})
