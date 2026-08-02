import { describe, expect, it } from 'bun:test'
import { createAnchor, type TextChange } from '../../domain/anchoring/anchor'
import { asFindingId, asRunId, generateId } from '../../domain/ids'
import type { RawFinding } from '../../domain/operations/contract'
import type { TrackedEdit } from '../../domain/operations/edit-apply'
import { THREAD_MAX_TURNS } from '../../domain/operations/thread'
import { FindingStore, type CarryoverFinding, type NewFinding } from './finding-store'

const DOC = 'The quick brown fox jumps over the lazy dog'

function makeRaw(overrides: Partial<RawFinding> = {}): RawFinding {
    return {
        quote: 'quick brown',
        critique: 'Too generic',
        edits: [{ op: 'replace', text: 'swift auburn' }],
        invalidProposal: false,
        severity: 'suggestion',
        evidence: [],
        ...overrides
    }
}

/** The tracked form of the default raw edit: an anchored span replace. */
function anchoredEdit(text = 'swift auburn'): TrackedEdit {
    return {
        op: 'replace',
        text,
        anchor: createAnchor(4, 15),
        anchoredText: 'quick brown',
        matchStrategy: 'exact'
    }
}

/** A display-only tracked edit (target never located). */
function unanchoredEdit(text = 'swift auburn'): TrackedEdit {
    return { op: 'replace', text, anchor: null, anchoredText: null, matchStrategy: null }
}

function makeInput(overrides: Partial<NewFinding> = {}): NewFinding {
    // Anchor on "quick brown" → [4, 15)
    return {
        id: asFindingId(generateId()),
        runId: asRunId(generateId()),
        editorId: 'editor-1',
        raw: makeRaw(),
        anchor: createAnchor(4, 15),
        anchoredText: 'quick brown',
        matchStrategy: 'exact',
        edits: [anchoredEdit()],
        ...overrides
    }
}

describe('FindingStore.add', () => {
    it('registers findings as open and notifies', () => {
        let notifications = 0
        const store = new FindingStore(() => notifications++)
        const finding = store.add(makeInput())
        expect(finding.status).toEqual('open')
        expect(finding.supersededBy).toBeNull()
        expect(store.get(finding.id)).toEqual(finding)
        expect(store.list()).toHaveLength(1)
        expect(notifications).toEqual(1)
    })

    it('lists findings per editor', () => {
        const store = new FindingStore()
        store.add(makeInput({ editorId: 'a' }))
        store.add(makeInput({ editorId: 'b' }))
        store.add(makeInput({ editorId: 'a' }))
        expect(store.listByEditor('a')).toHaveLength(2)
        expect(store.listByEditor('b')).toHaveLength(1)
        expect(store.listByEditor('missing')).toHaveLength(0)
    })
})

describe('FindingStore.preview', () => {
    it('moves an actionable open finding to preview', () => {
        const store = new FindingStore()
        const finding = store.add(makeInput())
        expect(store.preview(finding.id)?.status).toEqual('preview')
    })

    it('rejects preview for unanchored findings', () => {
        const store = new FindingStore()
        const finding = store.add(
            makeInput({
                anchor: null,
                anchoredText: null,
                matchStrategy: null,
                edits: [unanchoredEdit()]
            })
        )
        expect(store.preview(finding.id)).toBeNull()
        expect(store.isActionable(finding.id)).toBeFalse()
    })

    it('rejects preview when the finding proposes nothing', () => {
        const store = new FindingStore()
        const finding = store.add(makeInput({ raw: makeRaw({ edits: [] }), edits: [] }))
        expect(store.preview(finding.id)).toBeNull()
    })

    it('rejects preview from a non-open status', () => {
        const store = new FindingStore()
        const finding = store.add(makeInput())
        store.preview(finding.id)
        expect(store.preview(finding.id)).toBeNull()
    })

    it('closePreview returns to open, but only from preview', () => {
        const store = new FindingStore()
        const finding = store.add(makeInput())
        expect(store.closePreview(finding.id)).toBeNull()
        store.preview(finding.id)
        expect(store.closePreview(finding.id)?.status).toEqual('open')
    })
})

describe('FindingStore.accept', () => {
    it('accepts from open when the precondition holds', () => {
        const store = new FindingStore()
        const finding = store.add(makeInput())
        const result = store.accept(finding.id, DOC)
        expect(result.ok).toBeTrue()
        if (result.ok) {
            // The full change set, verified and sorted — one transaction.
            expect(result.changes).toEqual([{ from: 4, to: 15, insert: 'swift auburn' }])
        }
        expect(store.get(finding.id)?.status).toEqual('accepted')
    })

    it('accepts from preview', () => {
        const store = new FindingStore()
        const finding = store.add(makeInput())
        store.preview(finding.id)
        expect(store.accept(finding.id, DOC).ok).toBeTrue()
    })

    it('fails with not-found for unknown ids', () => {
        const store = new FindingStore()
        const result = store.accept(asFindingId('nope'), DOC)
        expect(result).toEqual({ ok: false, reason: 'not-found' })
    })

    it('fails with invalid-status for terminal findings', () => {
        const store = new FindingStore()
        const finding = store.add(makeInput())
        store.dismiss(finding.id)
        expect(store.accept(finding.id, DOC)).toEqual({ ok: false, reason: 'invalid-status' })
    })

    it('fails with unanchored for display-only findings', () => {
        const store = new FindingStore()
        const finding = store.add(
            makeInput({
                anchor: null,
                anchoredText: null,
                matchStrategy: null,
                edits: [unanchoredEdit()]
            })
        )
        expect(store.accept(finding.id, DOC)).toEqual({ ok: false, reason: 'unanchored' })
    })

    it('fails with stale after an overlapping edit', () => {
        const store = new FindingStore()
        const finding = store.add(makeInput())
        store.applyTextChanges([{ from: 5, to: 7, insertedLength: 1 }])
        expect(store.accept(finding.id, DOC).ok).toBeFalse()
        expect(store.accept(finding.id, DOC)).toEqual({ ok: false, reason: 'stale' })
    })

    it('fails with no-proposal when there is nothing to apply', () => {
        const store = new FindingStore()
        const finding = store.add(makeInput({ raw: makeRaw({ edits: [] }), edits: [] }))
        expect(store.accept(finding.id, DOC)).toEqual({ ok: false, reason: 'no-proposal' })
    })

    it('a multi-edit proposal applies all-or-nothing: one bad edit blocks the set', () => {
        const store = new FindingStore()
        const finding = store.add(makeInput({ edits: [anchoredEdit(), unanchoredEdit('extra')] }))
        expect(store.isActionable(finding.id)).toBeFalse()
        expect(store.accept(finding.id, DOC)).toEqual({ ok: false, reason: 'unanchored' })
    })

    it('an insert edit leaves the quoted text intact (the #17 fix)', () => {
        const store = new FindingStore()
        const insert: TrackedEdit = { ...anchoredEdit('NEW LINE\n'), op: 'insert-before' }
        const finding = store.add(makeInput({ edits: [insert] }))
        const result = store.accept(finding.id, DOC)
        expect(result.ok).toBeTrue()
        if (result.ok) {
            expect(result.changes).toEqual([{ from: 4, to: 4, insert: 'NEW LINE\n' }])
        }
    })

    it('fails with precondition-failed when the text drifted without remapping', () => {
        const store = new FindingStore()
        const finding = store.add(makeInput())
        const drifted = 'The QUICK brown fox jumps over the lazy dog'
        expect(store.accept(finding.id, drifted)).toEqual({
            ok: false,
            reason: 'precondition-failed'
        })
        // The finding stays open — the user can regenerate, never auto-apply.
        expect(store.get(finding.id)?.status).toEqual('open')
    })
})

describe('FindingStore.reject / dismiss', () => {
    it('closes open findings', () => {
        const store = new FindingStore()
        const a = store.add(makeInput())
        const b = store.add(makeInput())
        expect(store.reject(a.id)?.status).toEqual('rejected')
        expect(store.dismiss(b.id)?.status).toEqual('dismissed')
    })

    it('closes preview findings', () => {
        const store = new FindingStore()
        const finding = store.add(makeInput())
        store.preview(finding.id)
        expect(store.reject(finding.id)?.status).toEqual('rejected')
    })

    it('allows dismissing stale and unanchored findings', () => {
        const store = new FindingStore()
        const unanchored = store.add(
            makeInput({
                anchor: null,
                anchoredText: null,
                matchStrategy: null,
                edits: [unanchoredEdit()]
            })
        )
        const anchored = store.add(makeInput())
        store.applyTextChanges([{ from: 5, to: 7, insertedLength: 0 }])
        expect(store.dismiss(unanchored.id)?.status).toEqual('dismissed')
        expect(store.dismiss(anchored.id)?.status).toEqual('dismissed')
    })

    it('rejects transitions out of terminal statuses', () => {
        const store = new FindingStore()
        const finding = store.add(makeInput())
        store.accept(finding.id, DOC)
        expect(store.reject(finding.id)).toBeNull()
        expect(store.dismiss(finding.id)).toBeNull()
        expect(store.get(finding.id)?.status).toEqual('accepted')
    })
})

describe('FindingStore.supersede', () => {
    it('marks a finding superseded by an existing successor', () => {
        const store = new FindingStore()
        const original = store.add(makeInput())
        const successor = store.add(
            makeInput({
                raw: makeRaw({ edits: [{ op: 'replace', text: 'nimble brown' }] }),
                edits: [anchoredEdit('nimble brown')]
            })
        )
        const updated = store.supersede(original.id, successor.id)
        expect(updated?.status).toEqual('superseded')
        expect(updated?.supersededBy).toEqual(successor.id)
    })

    it('refuses dangling or self supersession', () => {
        const store = new FindingStore()
        const finding = store.add(makeInput())
        expect(store.supersede(finding.id, asFindingId('missing'))).toBeNull()
        expect(store.supersede(finding.id, finding.id)).toBeNull()
        expect(store.get(finding.id)?.status).toEqual('open')
    })

    it('refuses superseding terminal findings', () => {
        const store = new FindingStore()
        const a = store.add(makeInput())
        const b = store.add(makeInput())
        store.dismiss(a.id)
        expect(store.supersede(a.id, b.id)).toBeNull()
    })
})

describe('FindingStore.applyTextChanges', () => {
    it('shifts anchors for edits before the range and keeps accept working', () => {
        const store = new FindingStore()
        const finding = store.add(makeInput())
        // Insert "A " at position 0: DOC → "A The quick brown fox…"
        const changes: TextChange[] = [{ from: 0, to: 0, insertedLength: 2 }]
        store.applyTextChanges(changes)
        const mapped = store.get(finding.id)
        expect(mapped?.anchor).toEqual({ from: 6, to: 17, state: 'anchored' })
        expect(store.accept(finding.id, `A ${DOC}`).ok).toBeTrue()
    })

    it('marks findings stale on overlapping edits', () => {
        const store = new FindingStore()
        const finding = store.add(makeInput())
        store.applyTextChanges([{ from: 10, to: 12, insertedLength: 4 }])
        expect(store.get(finding.id)?.anchor?.state).toEqual('stale')
    })

    it('drops a preview back to open when its anchor goes stale', () => {
        const store = new FindingStore()
        const finding = store.add(makeInput())
        store.preview(finding.id)
        store.applyTextChanges([{ from: 10, to: 12, insertedLength: 0 }])
        expect(store.get(finding.id)?.status).toEqual('open')
        expect(store.get(finding.id)?.anchor?.state).toEqual('stale')
    })

    it('ignores unanchored findings and empty change lists', () => {
        let notifications = 0
        const store = new FindingStore(() => notifications++)
        store.add(
            makeInput({
                anchor: null,
                anchoredText: null,
                matchStrategy: null,
                edits: [unanchoredEdit()]
            })
        )
        const before = notifications
        store.applyTextChanges([])
        store.applyTextChanges([{ from: 0, to: 1, insertedLength: 0 }])
        expect(notifications).toEqual(before)
    })

    it('notifies once per batch that changed something', () => {
        let notifications = 0
        const store = new FindingStore(() => notifications++)
        store.add(makeInput())
        store.add(makeInput())
        const before = notifications
        store.applyTextChanges([{ from: 0, to: 0, insertedLength: 3 }])
        expect(notifications).toEqual(before + 1)
    })
})

describe('FindingStore.removeMany', () => {
    it('removes findings of any status and notifies exactly once', () => {
        const store = new FindingStore()
        const open = store.add(makeInput())
        const accepted = store.add(makeInput())
        expect(store.accept(accepted.id, DOC).ok).toBeTrue()
        const kept = store.add(makeInput({ editorId: 'other' }))

        let acts = 0
        const acting = new FindingStore(() => acts++)
        const a = acting.add(makeInput())
        const b = acting.add(makeInput())
        acts = 0
        acting.removeMany([a.id, b.id])
        expect(acts).toEqual(1)
        expect(acting.list()).toHaveLength(0)

        // Terminal findings are removed too (retry replaces the attempt).
        store.removeMany([open.id, accepted.id])
        expect(store.get(open.id)).toBeNull()
        expect(store.get(accepted.id)).toBeNull()
        expect(store.list()).toEqual([kept])
    })

    it('ignores unknown ids without notifying', () => {
        let notifications = 0
        const store = new FindingStore(() => notifications++)
        store.removeMany([asFindingId('missing')])
        expect(notifications).toEqual(0)
    })
})

// ---------------------------------------------------------------------------
// Push-back threads
// ---------------------------------------------------------------------------

describe('FindingStore.beginThreadTurn', () => {
    it('records the push-back as the pending turn without touching the thread', () => {
        let notifications = 0
        const store = new FindingStore(() => notifications++)
        const finding = store.add(makeInput())
        notifications = 0

        const begun = store.beginThreadTurn(finding.id, '  I disagree — this is intentional  ')
        expect(begun.ok).toBeTrue()
        const tracked = store.get(finding.id)
        expect(tracked?.threadTurn).toEqual({
            status: 'pending',
            message: 'I disagree — this is intentional'
        })
        expect(tracked?.thread).toEqual([])
        expect(notifications).toEqual(1)
    })

    it('refuses blank messages, unknown ids, terminal findings and double turns', () => {
        const store = new FindingStore()
        const finding = store.add(makeInput())
        expect(store.beginThreadTurn(finding.id, '   ')).toEqual({
            ok: false,
            reason: 'blank-message'
        })
        expect(store.beginThreadTurn(asFindingId('missing'), 'hi')).toEqual({
            ok: false,
            reason: 'not-found'
        })
        expect(store.beginThreadTurn(finding.id, 'first').ok).toBeTrue()
        expect(store.beginThreadTurn(finding.id, 'second')).toEqual({
            ok: false,
            reason: 'in-flight'
        })

        const dismissed = store.add(makeInput())
        store.dismiss(dismissed.id)
        expect(store.beginThreadTurn(dismissed.id, 'hi')).toEqual({
            ok: false,
            reason: 'invalid-status'
        })
    })

    it('allows a retry after a failed turn but stops at the cap', () => {
        const store = new FindingStore()
        const finding = store.add(makeInput())
        expect(store.beginThreadTurn(finding.id, 'first').ok).toBeTrue()
        store.failThreadTurn(finding.id, 'Network error')
        // A failed turn is replaced, not counted.
        expect(store.beginThreadTurn(finding.id, 'again').ok).toBeTrue()

        for (let turn = 0; turn < THREAD_MAX_TURNS; turn++) {
            store.completeThreadTurn(finding.id, {
                kind: 'hold',
                reply: `reply ${turn}`,
                revisedCritique: null,
                revisedEdits: null
            })
            if (turn < THREAD_MAX_TURNS - 1) {
                expect(store.beginThreadTurn(finding.id, `push ${turn}`).ok).toBeTrue()
            }
        }
        expect(store.get(finding.id)?.thread).toHaveLength(THREAD_MAX_TURNS * 2)
        expect(store.beginThreadTurn(finding.id, 'one more')).toEqual({
            ok: false,
            reason: 'cap-reached'
        })
    })
})

describe('FindingStore.completeThreadTurn', () => {
    it('appends the exchange in order and keeps the finding open on a hold', () => {
        const store = new FindingStore()
        const finding = store.add(makeInput())
        store.beginThreadTurn(finding.id, 'I disagree')
        const held = store.completeThreadTurn(finding.id, {
            kind: 'hold',
            reply: 'Still reads as an accident',
            revisedCritique: null,
            revisedEdits: null
        })
        expect(held?.thread).toEqual([
            { role: 'user', content: 'I disagree' },
            { role: 'editor', content: 'Still reads as an accident' }
        ])
        expect(held?.threadTurn).toBeNull()
        expect(held?.status).toEqual('open')
        expect(held?.conceded).toBeFalse()
    })

    it('updates critique and proposal in place, re-deriving actionability', () => {
        const store = new FindingStore()
        const finding = store.add(makeInput())
        store.beginThreadTurn(finding.id, 'give me something better')
        const held = store.completeThreadTurn(
            finding.id,
            {
                kind: 'hold',
                reply: 'Here is a tighter version',
                revisedCritique: 'The repetition buries the verb',
                revisedEdits: [{ op: 'replace', text: 'nimble auburn' }]
            },
            // The caller anchored the revision against the live text.
            [anchoredEdit('nimble auburn')]
        )
        expect(held?.raw.critique).toEqual('The repetition buries the verb')
        expect(held?.raw.edits).toEqual([{ op: 'replace', text: 'nimble auburn' }])
        // Anchor and precondition base untouched → still acceptable.
        expect(held?.anchor).toEqual(finding.anchor)
        expect(held?.anchoredText).toEqual(finding.anchoredText)
        expect(store.isActionable(finding.id)).toBeTrue()
        const accepted = store.accept(finding.id, DOC)
        expect(accepted.ok).toBeTrue()
        if (accepted.ok) {
            expect(accepted.changes).toEqual([{ from: 4, to: 15, insert: 'nimble auburn' }])
        }
    })

    it('degrades a revision to display-only when the caller could not anchor it', () => {
        const store = new FindingStore()
        const finding = store.add(makeInput())
        store.beginThreadTurn(finding.id, 'rework it')
        // No third argument: the note was closed when the turn landed.
        store.completeThreadTurn(finding.id, {
            kind: 'hold',
            reply: 'Revised',
            revisedCritique: null,
            revisedEdits: [{ op: 'replace', text: 'brand new text' }]
        })
        expect(store.get(finding.id)?.raw.edits).toEqual([
            { op: 'replace', text: 'brand new text' }
        ])
        expect(store.isActionable(finding.id)).toBeFalse()
        expect(store.accept(finding.id, DOC)).toEqual({ ok: false, reason: 'unanchored' })
    })

    it('drops a preview back to open when the proposal changed', () => {
        const store = new FindingStore()
        const finding = store.add(makeInput())
        store.preview(finding.id)
        store.beginThreadTurn(finding.id, 'rework it')
        expect(
            store.completeThreadTurn(
                finding.id,
                {
                    kind: 'hold',
                    reply: 'Revised',
                    revisedCritique: null,
                    revisedEdits: [{ op: 'replace', text: 'brand new text' }]
                },
                [anchoredEdit('brand new text')]
            )?.status
        ).toEqual('open')

        // An unchanged proposal leaves the preview alone.
        const other = store.add(makeInput())
        store.preview(other.id)
        store.beginThreadTurn(other.id, 'why?')
        expect(
            store.completeThreadTurn(other.id, {
                kind: 'hold',
                reply: 'Because.',
                revisedCritique: 'Sharper',
                revisedEdits: null
            })?.status
        ).toEqual('preview')
    })

    it('dismisses and flags the finding when the editor concedes', () => {
        const store = new FindingStore()
        const finding = store.add(makeInput())
        store.beginThreadTurn(finding.id, 'it is intentional')
        const conceded = store.completeThreadTurn(finding.id, {
            kind: 'concede',
            reply: 'Understood, withdrawing it'
        })
        expect(conceded?.status).toEqual('dismissed')
        expect(conceded?.conceded).toBeTrue()
        expect(conceded?.thread).toHaveLength(2)
        expect(store.isActionable(finding.id)).toBeFalse()
    })

    it('never undoes an accept that landed while the turn was in flight', () => {
        const store = new FindingStore()
        const finding = store.add(makeInput())
        store.beginThreadTurn(finding.id, 'it is intentional')
        expect(store.accept(finding.id, DOC).ok).toBeTrue()
        const conceded = store.completeThreadTurn(finding.id, {
            kind: 'concede',
            reply: 'Withdrawing it'
        })
        expect(conceded?.status).toEqual('accepted')
        expect(conceded?.conceded).toBeFalse()
        // The exchange is still recorded.
        expect(conceded?.thread).toHaveLength(2)
    })

    it('ignores late events with no pending turn or no finding', () => {
        const store = new FindingStore()
        const finding = store.add(makeInput())
        const outcome = { kind: 'concede', reply: 'late' } as const
        expect(store.completeThreadTurn(finding.id, outcome)).toBeNull()
        expect(store.completeThreadTurn(asFindingId('missing'), outcome)).toBeNull()
        store.beginThreadTurn(finding.id, 'push')
        store.failThreadTurn(finding.id, 'Cancelled')
        expect(store.completeThreadTurn(finding.id, outcome)).toBeNull()
    })
})

describe('FindingStore.failThreadTurn', () => {
    it('keeps the message with its reason and leaves the thread untouched', () => {
        const store = new FindingStore()
        const finding = store.add(makeInput())
        store.beginThreadTurn(finding.id, 'I disagree')
        const failed = store.failThreadTurn(finding.id, 'Request timed out')
        expect(failed?.threadTurn).toEqual({
            status: 'failed',
            message: 'I disagree',
            reason: 'Request timed out'
        })
        expect(failed?.thread).toEqual([])
        // Idempotent: no pending turn left to fail.
        expect(store.failThreadTurn(finding.id, 'again')).toBeNull()
    })
})

describe('FindingStore carryover (issue #19)', () => {
    function carryInput(overrides: Partial<CarryoverFinding> = {}): CarryoverFinding {
        return {
            ...makeInput(),
            status: 'open',
            thread: [],
            threadTurn: null,
            conceded: false,
            ...overrides
        }
    }

    it('registers a carried finding flagged carryover, preserving status and thread', () => {
        const store = new FindingStore()
        const thread = [
            { role: 'user' as const, content: 'Why?' },
            { role: 'editor' as const, content: 'Because.' }
        ]
        const finding = store.addCarryover(
            carryInput({ status: 'dismissed', thread, conceded: true })
        )
        expect(finding.carryover).toBeTrue()
        expect(finding.status).toEqual('dismissed')
        expect(finding.thread).toEqual(thread)
        expect(finding.conceded).toBeTrue()
    })

    it('fresh findings are never carryover', () => {
        const store = new FindingStore()
        expect(store.add(makeInput()).carryover).toBeFalse()
    })

    it('degrades preview to open — the previewed diff belonged to the replaced run', () => {
        const store = new FindingStore()
        expect(store.addCarryover(carryInput({ status: 'preview' })).status).toEqual('open')
    })

    it('degrades a pending push-back turn to failed — its completion can never land here', () => {
        const store = new FindingStore()
        const finding = store.addCarryover(
            carryInput({ threadTurn: { status: 'pending', message: 'Are you sure?' } })
        )
        expect(finding.threadTurn).toEqual({
            status: 'failed',
            message: 'Are you sure?',
            reason: 'The review was refreshed'
        })
    })

    it('adoptCarryover refreshes anchoring and proposal, keeps id/status/thread, clears the flag', () => {
        const store = new FindingStore()
        const thread = [
            { role: 'user' as const, content: 'Why?' },
            { role: 'editor' as const, content: 'Because.' }
        ]
        const carried = store.addCarryover(carryInput({ status: 'dismissed', thread }))
        const newRunId = asRunId(generateId())
        const newRaw = makeRaw({ critique: 'Sharper critique' })
        const adopted = store.adoptCarryover(carried.id, {
            runId: newRunId,
            raw: newRaw,
            anchor: createAnchor(4, 15),
            anchoredText: 'quick brown',
            matchStrategy: 'exact',
            edits: [anchoredEdit('sharper text')]
        })
        expect(adopted?.id).toEqual(carried.id)
        expect(adopted?.carryover).toBeFalse()
        expect(adopted?.status).toEqual('dismissed')
        expect(adopted?.thread).toEqual(thread)
        expect(adopted?.raw).toEqual(newRaw)
        expect(adopted?.runId).toEqual(newRunId)
    })

    it('adoptCarryover refuses non-carryover findings', () => {
        const store = new FindingStore()
        const fresh = store.add(makeInput())
        expect(
            store.adoptCarryover(fresh.id, {
                runId: asRunId(generateId()),
                raw: makeRaw(),
                anchor: null,
                anchoredText: null,
                matchStrategy: null,
                edits: []
            })
        ).toBeNull()
    })

    it('markCurrent clears the flag without touching anything else; markCarryover re-flags', () => {
        const store = new FindingStore()
        const carried = store.addCarryover(carryInput({ status: 'dismissed' }))
        const current = store.markCurrent(carried.id)
        expect(current?.carryover).toBeFalse()
        expect(current?.status).toEqual('dismissed')
        expect(store.markCurrent(carried.id)).toBeNull() // idempotence guard
        const reflagged = store.markCarryover(carried.id)
        expect(reflagged?.carryover).toBeTrue()
        expect(store.markCarryover(carried.id)).toBeNull()
    })

    it('a carried open finding stays fully actionable (preview, accept, dismiss)', () => {
        const store = new FindingStore()
        const carried = store.addCarryover(carryInput())
        expect(store.isActionable(carried.id)).toBeTrue()
        expect(store.preview(carried.id)?.status).toEqual('preview')
        expect(store.closePreview(carried.id)?.status).toEqual('open')
        const accepted = store.accept(carried.id, DOC)
        expect(accepted.ok).toBeTrue()
    })
})
