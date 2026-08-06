import { describe, expect, it } from 'bun:test'
import { EditorState } from '@codemirror/state'
import type { Transaction } from '@codemirror/state'
import { isTriageOnlyEdit, triageEditAnnotation } from './triage-edit'

/**
 * The classifier feeding `handleEditorUpdate`'s daemon branch: a doc-changing
 * update where EVERY doc-changing transaction carries `triageEditAnnotation`
 * takes the triage-edit path (never restarts an armed idle window); one
 * unmarked doc change makes the whole update a keystroke-tier edit.
 */

function makeState(doc = 'The quick brown fox.'): EditorState {
    return EditorState.create({ doc })
}

function triageTransaction(state: EditorState): Transaction {
    return state.update({
        changes: { from: 0, to: 3, insert: 'A' },
        annotations: triageEditAnnotation.of(true)
    })
}

function plainEditTransaction(state: EditorState): Transaction {
    return state.update({ changes: { from: 0, to: 0, insert: 'x' } })
}

function selectionOnlyTransaction(state: EditorState): Transaction {
    return state.update({ selection: { anchor: 1 } })
}

describe('isTriageOnlyEdit', () => {
    it('accepts a single annotated doc-changing transaction (the accept dispatch)', () => {
        expect(isTriageOnlyEdit([triageTransaction(makeState())])).toBeTrue()
    })

    it('rejects a plain keystroke transaction', () => {
        expect(isTriageOnlyEdit([plainEditTransaction(makeState())])).toBeFalse()
    })

    it('one unmarked doc change poisons the batch — keystroke semantics win', () => {
        const state = makeState()
        expect(
            isTriageOnlyEdit([triageTransaction(state), plainEditTransaction(state)])
        ).toBeFalse()
    })

    it('ignores non-doc-changing transactions bundled into the update', () => {
        const state = makeState()
        expect(
            isTriageOnlyEdit([selectionOnlyTransaction(state), triageTransaction(state)])
        ).toBeTrue()
    })

    it('an undo of a triage accept carries no annotation and reads as an edit', () => {
        // CM6 does not copy custom annotations onto history-generated
        // transactions; pinned so a regression in that assumption surfaces.
        const state = makeState()
        const accept = triageTransaction(state)
        const undo = accept.state.update({ changes: accept.changes.invert(state.doc) })
        expect(isTriageOnlyEdit([undo])).toBeFalse()
    })
})
