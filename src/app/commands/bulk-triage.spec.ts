import { describe, expect, it } from 'bun:test'
import { asFindingId, asRunId } from '../domain/ids'
import { FindingStore } from '../services/orchestration/finding-store'
import type { RawFinding } from '../domain/operations/contract'
import type { TrackedEdit } from '../domain/operations/edit-apply'
import {
    bulkAcceptNotice,
    bulkDismissNotice,
    dismissableFindingIds,
    globalDismissView,
    isBulkAcceptable,
    planBulkAccept
} from './bulk-triage'
import type { BulkCandidateFinding, GlobalDismissCandidate } from './bulk-triage'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

interface EditOptions {
    readonly op?: TrackedEdit['op']
    readonly from?: number
    readonly to?: number
    readonly state?: 'anchored' | 'stale'
    readonly anchoredText?: string | null
    readonly text?: string
    readonly unanchored?: boolean
}

function edit(options: EditOptions = {}): TrackedEdit {
    const from = options.from ?? 0
    const to = options.to ?? from + 3
    return {
        op: options.op ?? 'replace',
        text: options.text ?? 'ABC',
        anchor: options.unanchored ? null : { from, to, state: options.state ?? 'anchored' },
        anchoredText: options.anchoredText === undefined ? 'abc' : options.anchoredText,
        matchStrategy: options.unanchored ? null : 'exact'
    }
}

interface CandidateOptions extends EditOptions {
    readonly id: string
    readonly status?: BulkCandidateFinding['status']
    readonly edits?: readonly TrackedEdit[]
}

function candidate(options: CandidateOptions): BulkCandidateFinding {
    return {
        id: options.id,
        status: options.status ?? 'open',
        edits: options.edits ?? [edit(options)]
    }
}

// ---------------------------------------------------------------------------
// isBulkAcceptable
// ---------------------------------------------------------------------------

describe('isBulkAcceptable', () => {
    it('accepts an open finding whose every edit is anchored', () => {
        expect(isBulkAcceptable(candidate({ id: 'a' }))).toBe(true)
    })

    it('refuses terminal, stale, unanchored and proposal-less findings', () => {
        expect(isBulkAcceptable(candidate({ id: 'a', status: 'dismissed' }))).toBe(false)
        expect(isBulkAcceptable(candidate({ id: 'b', state: 'stale' }))).toBe(false)
        expect(isBulkAcceptable(candidate({ id: 'c', unanchored: true }))).toBe(false)
        expect(isBulkAcceptable(candidate({ id: 'd', edits: [] }))).toBe(false)
        expect(isBulkAcceptable(candidate({ id: 'e', anchoredText: null }))).toBe(false)
    })

    it('refuses a finding whose own edits conflict (all-or-nothing)', () => {
        expect(
            isBulkAcceptable(
                candidate({
                    id: 'conflicted',
                    edits: [edit({ from: 0, to: 5 }), edit({ from: 3, to: 8 })]
                })
            )
        ).toBe(false)
    })

    it('agrees with FindingStore.isActionable (the count the UI advertises)', () => {
        const store = new FindingStore()
        const raw: RawFinding = {
            quote: 'abc',
            critique: 'too long',
            edits: [{ op: 'replace', text: 'ABC' }],
            invalidProposal: false,
            severity: 'suggestion',
            evidence: []
        }
        const runId = asRunId('run-1')
        const inputs: { id: string; edits: readonly TrackedEdit[] }[] = [
            { id: 'ok', edits: [edit({ from: 0, to: 3 })] },
            { id: 'stale', edits: [edit({ from: 4, to: 7, state: 'stale' })] },
            { id: 'orphan', edits: [edit({ unanchored: true })] },
            { id: 'no-proposal', edits: [] },
            // Anchored but with no anchored text: `accept()` refuses
            // ('unanchored'), so neither predicate may advertise it.
            { id: 'no-anchored-text', edits: [edit({ from: 0, to: 3, anchoredText: null })] },
            {
                id: 'self-conflicting',
                edits: [edit({ from: 0, to: 5 }), edit({ from: 3, to: 8 })]
            }
        ]
        const candidates: BulkCandidateFinding[] = []
        for (const input of inputs) {
            const finding = store.add({
                id: asFindingId(input.id),
                runId,
                editorId: 'editor-1',
                raw,
                anchor: { from: 0, to: 3, state: 'anchored' },
                anchoredText: 'abc',
                matchStrategy: 'exact',
                edits: input.edits
            })
            candidates.push(finding)
        }
        for (const finding of candidates) {
            const actionable = store.isActionable(asFindingId(finding.id))
            expect(isBulkAcceptable(finding)).toBe(actionable)
            // …and neither may advertise something `accept()` would refuse
            // for a reason other than the live-text precondition.
            if (!actionable) {
                const outcome = store.accept(asFindingId(finding.id), 'abc def ghi')
                expect(outcome.ok).toBe(false)
            }
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
                candidate({ id: 'later', from: 8, to: 11, anchoredText: 'ghi', text: 'GHI' }),
                candidate({ id: 'first', from: 0, to: 3, anchoredText: 'abc', text: 'ABC' }),
                candidate({ id: 'mid', from: 4, to: 7, anchoredText: 'def', text: 'DEF' })
            ],
            text
        )
        expect(plan.findings).toEqual([
            { findingId: 'first', changes: [{ from: 0, to: 3, insert: 'ABC' }] },
            { findingId: 'mid', changes: [{ from: 4, to: 7, insert: 'DEF' }] },
            { findingId: 'later', changes: [{ from: 8, to: 11, insert: 'GHI' }] }
        ])
        expect(plan.skippedOverlapping).toBe(0)
        expect(plan.skippedChanged).toBe(0)
    })

    it('keeps the earlier finding and skips the overlapping later one WHOLE', () => {
        const plan = planBulkAccept(
            [
                candidate({ id: 'wide', from: 0, to: 7, anchoredText: 'abc def', text: 'X' }),
                // Two edits; only the first overlaps 'wide' — the finding is
                // still skipped whole (all-or-nothing).
                candidate({
                    id: 'inner',
                    edits: [
                        edit({ from: 4, to: 7, anchoredText: 'def', text: 'Y' }),
                        edit({ from: 8, to: 11, anchoredText: 'ghi', text: 'Z' })
                    ]
                })
            ],
            text
        )
        expect(plan.findings.map((finding) => finding.findingId)).toEqual(['wide'])
        expect(plan.skippedOverlapping).toBe(1)
    })

    it('treats adjacent spans as non-conflicting', () => {
        const plan = planBulkAccept(
            [
                candidate({ id: 'a', from: 0, to: 4, anchoredText: 'abc ', text: 'ABC ' }),
                candidate({ id: 'b', from: 4, to: 7, anchoredText: 'def', text: 'DEF' })
            ],
            text
        )
        expect(plan.findings).toHaveLength(2)
        expect(plan.skippedOverlapping).toBe(0)
    })

    it('skips findings whose text changed since the run (BR #3, never relocated)', () => {
        const plan = planBulkAccept(
            [
                candidate({ id: 'moved', from: 0, to: 3, anchoredText: 'xyz', text: 'X' }),
                candidate({ id: 'ok', from: 4, to: 7, anchoredText: 'def', text: 'DEF' })
            ],
            text
        )
        expect(plan.findings.map((finding) => finding.findingId)).toEqual(['ok'])
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
        expect(plan.findings).toEqual([])
        // The stale one is not acceptable by shape (silent); the out-of-bounds
        // one is acceptable but fails the precondition.
        expect(plan.skippedChanged).toBe(1)
    })

    it('ignores non-acceptable findings silently (never offered, never counted)', () => {
        const plan = planBulkAccept(
            [
                candidate({ id: 'terminal', status: 'accepted' }),
                candidate({ id: 'orphan', unanchored: true }),
                candidate({ id: 'no-proposal', edits: [] })
            ],
            text
        )
        expect(plan).toEqual({ findings: [], skippedOverlapping: 0, skippedChanged: 0 })
    })

    it('a multi-edit finding contributes ALL its changes as one group', () => {
        const plan = planBulkAccept(
            [
                candidate({
                    id: 'multi',
                    edits: [
                        edit({
                            op: 'insert-before',
                            from: 4,
                            to: 7,
                            anchoredText: 'def',
                            text: 'X '
                        }),
                        edit({ op: 'delete', from: 8, to: 11, anchoredText: 'ghi', text: '' })
                    ]
                })
            ],
            text
        )
        expect(plan.findings).toEqual([
            {
                findingId: 'multi',
                changes: [
                    { from: 4, to: 4, insert: 'X ' },
                    { from: 8, to: 11, insert: '' }
                ]
            }
        ])
    })

    it('produces changes that apply as one non-overlapping sorted set', () => {
        const plan = planBulkAccept(
            [
                candidate({ id: 'a', from: 0, to: 3, anchoredText: 'abc', text: 'A' }),
                candidate({ id: 'b', from: 2, to: 5, anchoredText: 'c d', text: 'B' }),
                candidate({ id: 'c', from: 8, to: 11, anchoredText: 'ghi', text: 'C' })
            ],
            text
        )
        let previousTo = -1
        for (const change of plan.findings.flatMap((finding) => finding.changes)) {
            expect(change.from).toBeGreaterThanOrEqual(previousTo)
            previousTo = change.to
        }
        expect(plan.findings).toHaveLength(2)
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
// globalDismissView
// ---------------------------------------------------------------------------

describe('globalDismissView', () => {
    const owned = (
        editorId: string,
        options: Parameters<typeof candidate>[0]
    ): GlobalDismissCandidate => ({ ...candidate(options), editorId })

    it('counts every non-terminal finding across editors', () => {
        const view = globalDismissView([
            owned('editor-1', { id: 'a' }),
            owned('editor-1', { id: 'b', status: 'preview' }),
            owned('editor-2', { id: 'c', state: 'stale' }),
            owned('editor-2', { id: 'd', unanchored: true })
        ])
        expect(view).toEqual({
            visible: true,
            count: 4,
            text: 'Dismiss all findings (4)',
            // WCAG 2.5.3 Label in Name: the accessible name must contain the
            // visible label verbatim as a prefix.
            ariaLabel: 'Dismiss all findings (4) from every editor of this note'
        })
        expect(view.ariaLabel.startsWith(view.text)).toBe(true)
    })

    it('advertises the same set dismissableFindingIds sweeps', () => {
        const candidates = [
            owned('editor-1', { id: 'open' }),
            owned('editor-2', { id: 'preview', status: 'preview' }),
            owned('editor-2', { id: 'gone', status: 'dismissed' })
        ]
        expect(globalDismissView(candidates).count).toBe(dismissableFindingIds(candidates).length)
    })

    it('hides when there is nothing to dismiss (no dead UI)', () => {
        expect(globalDismissView([])).toEqual({
            visible: false,
            count: 0,
            text: '',
            ariaLabel: ''
        })
        expect(
            globalDismissView([
                owned('editor-1', { id: 'a', status: 'accepted' }),
                owned('editor-2', { id: 'b', status: 'dismissed' })
            ]).visible
        ).toBe(false)
    })

    it('hides when a single editor owns every dismissable finding (its own row is the identical control)', () => {
        const view = globalDismissView([
            owned('editor-1', { id: 'a' }),
            owned('editor-1', { id: 'b', status: 'preview' })
        ])
        expect(view.visible).toBe(false)
        expect(view.count).toBe(2)
    })

    it('ignores terminal findings when counting contributing editors', () => {
        // editor-2 only has terminal findings left, so the run is effectively
        // single-editor and the per-editor row already covers it.
        expect(
            globalDismissView([
                owned('editor-1', { id: 'a' }),
                owned('editor-1', { id: 'b' }),
                owned('editor-2', { id: 'c', status: 'accepted' })
            ]).visible
        ).toBe(false)
    })
})

// ---------------------------------------------------------------------------
// Notices
// ---------------------------------------------------------------------------

describe('bulkAcceptNotice', () => {
    const plan = (
        findings: number,
        skippedOverlapping = 0,
        skippedChanged = 0
    ): Parameters<typeof bulkAcceptNotice>[1] => ({
        findings: Array.from({ length: findings }, (_unused, index) => ({
            findingId: `f-${index}`,
            changes: [{ from: index, to: index + 1, insert: 'x' }]
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

    it('counts planned findings the store refused as no longer matching', () => {
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
