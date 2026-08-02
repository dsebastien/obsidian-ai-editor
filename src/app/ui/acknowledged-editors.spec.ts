import { describe, expect, it } from 'bun:test'
import { createAnchor } from '../domain/anchoring/anchor'
import { asFindingId, asRunId, generateId } from '../domain/ids'
import type { RawFinding } from '../domain/operations/contract'
import { FindingStore } from '../services/orchestration/finding-store'
import type { EditorRunState } from '../services/orchestration/run-controller'
import { isSettledClean, pruneAcknowledged } from './acknowledged-editors'

function raw(): RawFinding {
    return {
        quote: 'quick brown',
        critique: 'Too generic',
        edits: [],
        invalidProposal: false,
        severity: 'suggestion',
        evidence: []
    }
}

function addFinding(store: FindingStore, editorId: string): string {
    const id = asFindingId(generateId())
    store.add({
        id,
        runId: asRunId(generateId()),
        editorId,
        raw: raw(),
        anchor: createAnchor(4, 15),
        anchoredText: 'quick brown',
        matchStrategy: 'exact',
        edits: []
    })
    return id
}

function editorState(overrides: Partial<EditorRunState> = {}): EditorRunState {
    return {
        editorId: 'e1',
        editorName: 'Editor',
        runId: asRunId(generateId()),
        status: 'done',
        findingIds: [],
        summary: null,
        verdict: null,
        lastProgress: null,
        error: null,
        continuing: false,
        continuationError: null,
        salvage: null,
        ...overrides
    } as EditorRunState
}

describe('isSettledClean (issue #24)', () => {
    it('a done editor with zero findings is acknowledgeable', () => {
        expect(isSettledClean(editorState(), new FindingStore())).toBeTrue()
    })

    it('all-triaged counts as clean — the user dealt with everything', () => {
        const store = new FindingStore()
        const id = addFinding(store, 'e1')
        const state = editorState({ findingIds: [asFindingId(id)] })
        expect(isSettledClean(state, store)).toBeFalse() // open finding: not clean
        store.dismiss(asFindingId(id))
        expect(isSettledClean(state, store)).toBeTrue()
    })

    it('never acknowledgeable while running, failed, cancelled or continuing', () => {
        const store = new FindingStore()
        expect(isSettledClean(editorState({ status: 'running' }), store)).toBeFalse()
        expect(isSettledClean(editorState({ status: 'error' }), store)).toBeFalse()
        expect(isSettledClean(editorState({ status: 'cancelled' }), store)).toBeFalse()
        expect(isSettledClean(editorState({ continuing: true }), store)).toBeFalse()
    })
})

describe('pruneAcknowledged (issue #24)', () => {
    it('drops an acknowledgement when the editor has live findings again', () => {
        const store = new FindingStore()
        const id = addFinding(store, 'e1')
        const acknowledged = new Set(['e1', 'e2'])
        pruneAcknowledged(
            acknowledged,
            [
                editorState({ editorId: 'e1', findingIds: [asFindingId(id)] }),
                editorState({ editorId: 'e2' })
            ],
            store
        )
        expect([...acknowledged]).toEqual(['e2'])
    })

    it('keeps the acknowledgement across a re-run that stays clean (no flicker)', () => {
        const store = new FindingStore()
        const id = addFinding(store, 'e1')
        store.dismiss(asFindingId(id))
        const acknowledged = new Set(['e1'])
        // Re-running: status irrelevant, only LIVE findings clear it —
        // dismissed carryover (#19) stays non-live.
        pruneAcknowledged(
            acknowledged,
            [editorState({ editorId: 'e1', status: 'running', findingIds: [asFindingId(id)] })],
            store
        )
        expect(acknowledged.has('e1')).toBeTrue()
    })
})

describe('pruneAcknowledged clears on terminal failure (adversarial review 2026-08-02)', () => {
    it('a failed re-run returns the section — an error must never hide as "all good"', () => {
        const store = new FindingStore()
        const acknowledged = new Set(['e1'])
        pruneAcknowledged(acknowledged, [editorState({ editorId: 'e1', status: 'error' })], store)
        expect(acknowledged.size).toBe(0)
    })

    it('a cancelled re-run returns the section too', () => {
        const store = new FindingStore()
        const acknowledged = new Set(['e1'])
        pruneAcknowledged(
            acknowledged,
            [editorState({ editorId: 'e1', status: 'cancelled' })],
            store
        )
        expect(acknowledged.size).toBe(0)
    })
})
