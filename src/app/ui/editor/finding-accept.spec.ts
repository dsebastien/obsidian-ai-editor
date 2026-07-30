import { describe, expect, it } from 'bun:test'
import { history, isolateHistory, undo, undoDepth } from '@codemirror/commands'
import { EditorState } from '@codemirror/state'
import type { TransactionSpec } from '@codemirror/state'
import {
    findingDecorationsField,
    removeFindingsEffect,
    setFindingsEffect
} from './finding-decorations'
import type { FindingDecorationSpec } from './finding-decorations'

/**
 * Contract pin for the FINDING accept dispatches — the card button
 * (`finding-card.ts`), the `accept-finding` triage command and the bulk
 * accept (`ReviewController.acceptAllFindings`) all dispatch the same shape:
 * the replacement change(s) + `removeFindingsEffect` for the accepted
 * finding(s) + `isolateHistory.of('full')`.
 *
 * The annotation is load-bearing: CM6's history joins an annotation-less
 * transaction to the previous event when adjacent and within `newGroupDelay`
 * (and later `input.type` transactions join symmetrically), so without it
 * Ctrl+Z after an accept next to recent typing reverts the accept AND the
 * user's keystrokes. Bulk accept additionally promises ONE undo step for the
 * whole batch — many changes in one transaction, one history event.
 */

function findingSpec(overrides: Partial<FindingDecorationSpec> = {}): FindingDecorationSpec {
    return {
        findingId: 'f-1',
        editorId: 'e-1',
        from: 0,
        to: 5,
        color: '#ff0000',
        editorName: 'Concision Editor',
        panelName: null,
        severity: 'suggestion',
        edgeIndex: 0,
        stale: false,
        current: false,
        ...overrides
    }
}

function stateWith(docText: string, specs: readonly FindingDecorationSpec[]): EditorState {
    const base = EditorState.create({
        doc: docText,
        extensions: [findingDecorationsField, history()]
    })
    return base.update({ effects: setFindingsEffect.of(specs) }).state
}

function apply(state: EditorState, spec: TransactionSpec): EditorState {
    return state.update(spec).state
}

function undoOnce(state: EditorState): EditorState {
    let result = state
    undo({
        state,
        dispatch: (tr) => {
            result = tr.state
        }
    })
    return result
}

function markIds(state: EditorState): string[] {
    const ids: string[] = []
    const cursor = state.field(findingDecorationsField).iter()
    while (cursor.value) {
        ids.push((cursor.value.spec as { findingId?: string }).findingId ?? '')
        cursor.next()
    }
    return ids
}

describe('single finding accept dispatch', () => {
    it('applies the replacement, drops only that mark, and is its own undo event', () => {
        let state = stateWith('alpha beta', [
            findingSpec({ findingId: 'f-1', from: 0, to: 5 }),
            findingSpec({ findingId: 'f-2', from: 6, to: 10 })
        ])
        state = apply(state, {
            changes: { from: 6, to: 10, insert: 'BETA' },
            effects: removeFindingsEffect.of(['f-2']),
            annotations: isolateHistory.of('full')
        })
        expect(state.doc.toString()).toBe('alpha BETA')
        expect(markIds(state)).toEqual(['f-1'])
        expect(undoDepth(state)).toBe(1)
        expect(undoOnce(state).doc.toString()).toBe('alpha beta')
    })

    it('never merges with typing that happened just before it', () => {
        let state = stateWith('alpha beta', [findingSpec({ findingId: 'f-2', from: 6, to: 10 })])
        state = apply(state, {
            changes: { from: 10, to: 10, insert: '!' },
            userEvent: 'input.type'
        })
        state = apply(state, {
            changes: { from: 6, to: 10, insert: 'BETA' },
            effects: removeFindingsEffect.of(['f-2']),
            annotations: isolateHistory.of('full')
        })
        expect(undoDepth(state)).toBe(2)
        // One undo reverts ONLY the accepted suggestion; the typing survives.
        expect(undoOnce(state).doc.toString()).toBe('alpha beta!')
    })
})

describe('bulk accept dispatch', () => {
    it('applies every planned edit as ONE undo step', () => {
        let state = stateWith('abc def ghi', [
            findingSpec({ findingId: 'f-1', from: 0, to: 3 }),
            findingSpec({ findingId: 'f-2', from: 4, to: 7 }),
            findingSpec({ findingId: 'f-3', from: 8, to: 11 })
        ])
        state = apply(state, {
            // Plan order: sorted, non-overlapping, pre-transaction coordinates.
            changes: [
                { from: 0, to: 3, insert: 'ABC' },
                { from: 4, to: 7, insert: 'DEF' }
            ],
            effects: removeFindingsEffect.of(['f-1', 'f-2']),
            annotations: isolateHistory.of('full')
        })
        expect(state.doc.toString()).toBe('ABC DEF ghi')
        expect(markIds(state)).toEqual(['f-3'])
        expect(undoDepth(state)).toBe(1)
        // ONE Ctrl+Z restores the whole batch — the M4 bulk promise.
        expect(undoOnce(state).doc.toString()).toBe('abc def ghi')
    })

    it('keeps the untouched findings anchored through the batch', () => {
        let state = stateWith('abc def ghi', [
            findingSpec({ findingId: 'f-1', from: 0, to: 3 }),
            findingSpec({ findingId: 'f-3', from: 8, to: 11 })
        ])
        state = apply(state, {
            changes: [{ from: 0, to: 3, insert: 'ABCDE' }],
            effects: removeFindingsEffect.of(['f-1']),
            annotations: isolateHistory.of('full')
        })
        const cursor = state.field(findingDecorationsField).iter()
        expect({ from: cursor.from, to: cursor.to }).toEqual({ from: 10, to: 13 })
    })

    it('is isolated from typing that continues right after the batch', () => {
        let state = stateWith('abc def', [findingSpec({ findingId: 'f-1', from: 0, to: 3 })])
        state = apply(state, {
            changes: [{ from: 0, to: 3, insert: 'ABC' }],
            effects: removeFindingsEffect.of(['f-1']),
            annotations: isolateHistory.of('full')
        })
        state = apply(state, { changes: { from: 7, to: 7, insert: '!' }, userEvent: 'input.type' })
        expect(undoDepth(state)).toBe(2)
        expect(undoOnce(state).doc.toString()).toBe('ABC def')
    })
})
