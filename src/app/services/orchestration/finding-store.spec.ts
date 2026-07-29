import { describe, expect, it } from 'bun:test'
import { createAnchor, type TextChange } from '../../domain/anchoring/anchor'
import { asFindingId, asRunId, generateId } from '../../domain/ids'
import type { RawFinding } from '../../domain/operations/contract'
import { FindingStore, type NewFinding } from './finding-store'

const DOC = 'The quick brown fox jumps over the lazy dog'

function makeRaw(overrides: Partial<RawFinding> = {}): RawFinding {
    return {
        quote: 'quick brown',
        critique: 'Too generic',
        suggestion: 'swift auburn',
        severity: 'suggestion',
        evidence: [],
        ...overrides
    }
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
            makeInput({ anchor: null, anchoredText: null, matchStrategy: null })
        )
        expect(store.preview(finding.id)).toBeNull()
        expect(store.isActionable(finding.id)).toBeFalse()
    })

    it('rejects preview when there is no suggestion', () => {
        const store = new FindingStore()
        const finding = store.add(makeInput({ raw: makeRaw({ suggestion: undefined }) }))
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
            makeInput({ anchor: null, anchoredText: null, matchStrategy: null })
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

    it('fails with no-suggestion when there is nothing to apply', () => {
        const store = new FindingStore()
        const finding = store.add(makeInput({ raw: makeRaw({ suggestion: undefined }) }))
        expect(store.accept(finding.id, DOC)).toEqual({ ok: false, reason: 'no-suggestion' })
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
            makeInput({ anchor: null, anchoredText: null, matchStrategy: null })
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
        const successor = store.add(makeInput({ raw: makeRaw({ suggestion: 'nimble brown' }) }))
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
        store.add(makeInput({ anchor: null, anchoredText: null, matchStrategy: null }))
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
