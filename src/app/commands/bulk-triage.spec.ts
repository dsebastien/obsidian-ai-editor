import { describe, expect, it } from 'bun:test'
import { asFindingId, asRunId } from '../domain/ids'
import { FindingStore } from '../services/orchestration/finding-store'
import type { RawFinding } from '../domain/operations/contract'
import {
    bulkAcceptNotice,
    bulkDismissNotice,
    dismissableFindingIds,
    isBulkAcceptable,
    planBulkAccept
} from './bulk-triage'
import type { BulkCandidateFinding } from './bulk-triage'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

interface CandidateOptions {
    readonly id: string
    readonly from?: number
    readonly to?: number
    readonly state?: 'anchored' | 'stale'
    readonly anchoredText?: string | null
    readonly suggestion?: string | undefined
    readonly status?: BulkCandidateFinding['status']
    readonly unanchored?: boolean
}

function candidate(options: CandidateOptions): BulkCandidateFinding {
    const from = options.from ?? 0
    const to = options.to ?? from + 3
    return {
        id: options.id,
        status: options.status ?? 'open',
        anchor: options.unanchored ? null : { from, to, state: options.state ?? 'anchored' },
        anchoredText: options.anchoredText === undefined ? 'abc' : options.anchoredText,
        raw: { suggestion: options.suggestion === undefined ? 'ABC' : options.suggestion }
    }
}

// ---------------------------------------------------------------------------
// isBulkAcceptable
// ---------------------------------------------------------------------------

describe('isBulkAcceptable', () => {
    it('accepts an open, anchored finding carrying a suggestion', () => {
        expect(isBulkAcceptable(candidate({ id: 'a' }))).toBe(true)
    })

    it('refuses terminal, stale, unanchored and suggestion-less findings', () => {
        expect(isBulkAcceptable(candidate({ id: 'a', status: 'dismissed' }))).toBe(false)
        expect(isBulkAcceptable(candidate({ id: 'b', state: 'stale' }))).toBe(false)
        expect(isBulkAcceptable(candidate({ id: 'c', unanchored: true }))).toBe(false)
        expect(isBulkAcceptable(candidate({ id: 'd', suggestion: '' }))).toBe(false)
        expect(isBulkAcceptable(candidate({ id: 'e', anchoredText: null }))).toBe(false)
    })

    it('agrees with FindingStore.isActionable (the count the UI advertises)', () => {
        const store = new FindingStore()
        const raw = (suggestion?: string): RawFinding => ({
            quote: 'abc',
            critique: 'too long',
            severity: 'suggestion',
            evidence: [],
            ...(suggestion === undefined ? {} : { suggestion })
        })
        const runId = asRunId('run-1')
        const inputs = [
            { id: 'ok', anchor: { from: 0, to: 3, state: 'anchored' as const }, suggestion: 'ABC' },
            { id: 'stale', anchor: { from: 4, to: 7, state: 'stale' as const }, suggestion: 'DEF' },
            { id: 'orphan', anchor: null, suggestion: 'GHI' },
            { id: 'no-sug', anchor: { from: 8, to: 9, state: 'anchored' as const } }
        ]
        const candidates: BulkCandidateFinding[] = []
        for (const input of inputs) {
            const finding = store.add({
                id: asFindingId(input.id),
                runId,
                editorId: 'editor-1',
                raw: raw(input.suggestion),
                anchor: input.anchor,
                anchoredText: input.anchor ? 'abc' : null,
                matchStrategy: 'exact'
            })
            candidates.push(finding)
        }
        for (const finding of candidates) {
            expect(isBulkAcceptable(finding)).toBe(store.isActionable(asFindingId(finding.id)))
        }
    })
})

// ---------------------------------------------------------------------------
// planBulkAccept
// ---------------------------------------------------------------------------

describe('planBulkAccept', () => {
    const text = 'abc def ghi'

    it('plans every acceptable finding in document order', () => {
        const plan = planBulkAccept(
            [
                candidate({ id: 'later', from: 8, to: 11, anchoredText: 'ghi', suggestion: 'GHI' }),
                candidate({ id: 'first', from: 0, to: 3, anchoredText: 'abc', suggestion: 'ABC' }),
                candidate({ id: 'mid', from: 4, to: 7, anchoredText: 'def', suggestion: 'DEF' })
            ],
            text
        )
        expect(plan.edits).toEqual([
            { findingId: 'first', from: 0, to: 3, insert: 'ABC' },
            { findingId: 'mid', from: 4, to: 7, insert: 'DEF' },
            { findingId: 'later', from: 8, to: 11, insert: 'GHI' }
        ])
        expect(plan.skippedOverlapping).toBe(0)
        expect(plan.skippedChanged).toBe(0)
    })

    it('keeps the earlier anchor and skips the overlapping later one', () => {
        const plan = planBulkAccept(
            [
                candidate({ id: 'wide', from: 0, to: 7, anchoredText: 'abc def', suggestion: 'X' }),
                candidate({ id: 'inner', from: 4, to: 7, anchoredText: 'def', suggestion: 'Y' })
            ],
            text
        )
        expect(plan.edits.map((edit) => edit.findingId)).toEqual(['wide'])
        expect(plan.skippedOverlapping).toBe(1)
    })

    it('treats adjacent spans as non-conflicting', () => {
        const plan = planBulkAccept(
            [
                candidate({ id: 'a', from: 0, to: 4, anchoredText: 'abc ', suggestion: 'ABC ' }),
                candidate({ id: 'b', from: 4, to: 7, anchoredText: 'def', suggestion: 'DEF' })
            ],
            text
        )
        expect(plan.edits).toHaveLength(2)
        expect(plan.skippedOverlapping).toBe(0)
    })

    it('skips findings whose text changed since the run (BR #3, never relocated)', () => {
        const plan = planBulkAccept(
            [
                candidate({ id: 'moved', from: 0, to: 3, anchoredText: 'xyz', suggestion: 'X' }),
                candidate({ id: 'ok', from: 4, to: 7, anchoredText: 'def', suggestion: 'DEF' })
            ],
            text
        )
        expect(plan.edits.map((edit) => edit.findingId)).toEqual(['ok'])
        expect(plan.skippedChanged).toBe(1)
    })

    it('skips a stale anchor as changed, and out-of-bounds anchors too', () => {
        const plan = planBulkAccept(
            [
                candidate({ id: 'stale', from: 0, to: 3, state: 'stale' }),
                candidate({ id: 'beyond', from: 90, to: 99, anchoredText: 'abc' })
            ],
            text
        )
        expect(plan.edits).toEqual([])
        // The stale one is not acceptable by shape (silent); the out-of-bounds
        // one is acceptable but fails the precondition.
        expect(plan.skippedChanged).toBe(1)
    })

    it('ignores non-acceptable findings silently (never offered, never counted)', () => {
        const plan = planBulkAccept(
            [
                candidate({ id: 'terminal', status: 'accepted' }),
                candidate({ id: 'orphan', unanchored: true }),
                candidate({ id: 'no-sug', suggestion: '' })
            ],
            text
        )
        expect(plan).toEqual({ edits: [], skippedOverlapping: 0, skippedChanged: 0 })
    })

    it('produces edits that apply as one non-overlapping sorted change set', () => {
        const plan = planBulkAccept(
            [
                candidate({ id: 'a', from: 0, to: 3, anchoredText: 'abc', suggestion: 'A' }),
                candidate({ id: 'b', from: 2, to: 5, anchoredText: 'c d', suggestion: 'B' }),
                candidate({ id: 'c', from: 8, to: 11, anchoredText: 'ghi', suggestion: 'C' })
            ],
            text
        )
        let previousTo = -1
        for (const edit of plan.edits) {
            expect(edit.from).toBeGreaterThanOrEqual(previousTo)
            previousTo = edit.to
        }
        expect(plan.edits).toHaveLength(2)
    })
})

// ---------------------------------------------------------------------------
// dismissableFindingIds
// ---------------------------------------------------------------------------

describe('dismissableFindingIds', () => {
    it('includes stale and unanchored findings but never terminal ones', () => {
        expect(
            dismissableFindingIds([
                candidate({ id: 'open' }),
                candidate({ id: 'preview', status: 'preview' }),
                candidate({ id: 'stale', state: 'stale' }),
                candidate({ id: 'orphan', unanchored: true }),
                candidate({ id: 'gone', status: 'dismissed' }),
                candidate({ id: 'done', status: 'accepted' })
            ])
        ).toEqual(['open', 'preview', 'stale', 'orphan'])
    })
})

// ---------------------------------------------------------------------------
// Notices
// ---------------------------------------------------------------------------

describe('bulkAcceptNotice', () => {
    const plan = (
        edits: number,
        skippedOverlapping = 0,
        skippedChanged = 0
    ): Parameters<typeof bulkAcceptNotice>[1] => ({
        edits: Array.from({ length: edits }, (_unused, index) => ({
            findingId: `f-${index}`,
            from: index,
            to: index + 1,
            insert: 'x'
        })),
        skippedOverlapping,
        skippedChanged
    })

    it('reports what was applied', () => {
        expect(bulkAcceptNotice(1, plan(1))).toBe('Applied 1 finding.')
        expect(bulkAcceptNotice(3, plan(3))).toBe('Applied 3 findings.')
    })

    it('reports skipped overlapping and changed findings', () => {
        expect(bulkAcceptNotice(2, plan(2, 1, 1))).toBe(
            'Applied 2 findings. Skipped 1 overlapping and 1 no longer matching the text.'
        )
    })

    it('counts planned edits the store refused as no longer matching', () => {
        expect(bulkAcceptNotice(1, plan(2))).toBe(
            'Applied 1 finding. Skipped 1 no longer matching the text.'
        )
    })

    it('says nothing was applied when every candidate was skipped', () => {
        expect(bulkAcceptNotice(0, plan(0, 0, 2))).toBe(
            'Nothing to apply. Skipped 2 no longer matching the text.'
        )
    })
})

describe('bulkDismissNotice', () => {
    it('reports the dismissed count', () => {
        expect(bulkDismissNotice(0)).toBe('Nothing to dismiss.')
        expect(bulkDismissNotice(1)).toBe('Dismissed 1 finding.')
        expect(bulkDismissNotice(4)).toBe('Dismissed 4 findings.')
    })
})
