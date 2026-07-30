import { describe, expect, it } from 'bun:test'
import { history, isolateHistory, undo, undoDepth } from '@codemirror/commands'
import { EditorState, Text } from '@codemirror/state'
import type { TransactionSpec } from '@codemirror/state'
import type { DecorationSet } from '@codemirror/view'
import {
    clearTransformPreviewEffect,
    hasTransformPreview,
    previewAriaLabel,
    previewWidgetPos,
    sanitizePreviewColor,
    showTransformPreviewEffect,
    transformPreviewField
} from './transform-preview'
import type { TransformPreviewSpec } from './transform-preview'

function previewSpec(overrides: Partial<TransformPreviewSpec> = {}): TransformPreviewSpec {
    return {
        runId: 'run-1',
        kind: 'transform-selection',
        anchor: 0,
        title: 'Rephrase — Concision editor',
        editorColor: '#ff0000',
        segments: [
            { kind: 'del', text: 'old' },
            { kind: 'ins', text: 'new' }
        ],
        rationale: null,
        actions: { onAccept: () => undefined, onReject: () => undefined },
        ...overrides
    }
}

function stateWith(docText: string): EditorState {
    return EditorState.create({ doc: docText, extensions: [transformPreviewField] })
}

function apply(state: EditorState, spec: TransactionSpec): EditorState {
    return state.update(spec).state
}

function widgetPositions(state: EditorState): number[] {
    const decorations: DecorationSet = state.field(transformPreviewField)
    const positions: number[] = []
    const cursor = decorations.iter()
    while (cursor.value) {
        positions.push(cursor.from)
        cursor.next()
    }
    return positions
}

describe('previewWidgetPos', () => {
    const doc = Text.of(['first line', 'second', ''])

    it('anchors at the end of the line containing the offset', () => {
        expect(previewWidgetPos(doc, 3)).toBe(10) // inside "first line"
        expect(previewWidgetPos(doc, 13)).toBe(17) // inside "second"
    })

    it('treats a doc-end anchor on a trailing empty line as end of previous line', () => {
        // doc.length (18) is the START of the trailing empty line — the
        // line-start rule sends the widget after "second" (17).
        expect(previewWidgetPos(doc, doc.length)).toBe(17)
    })

    it('moves a line-start anchor to the end of the PREVIOUS line', () => {
        // Offset 11 = start of "second": a whole-line selection of line 1
        // ends here; the widget belongs after "first line".
        expect(previewWidgetPos(doc, 11)).toBe(10)
    })

    it('keeps offset 0 on the first line', () => {
        expect(previewWidgetPos(doc, 0)).toBe(10)
    })

    it('clamps out-of-bounds anchors into the document', () => {
        expect(previewWidgetPos(doc, 9_999)).toBe(17)
        expect(previewWidgetPos(doc, -5)).toBe(10)
        const flat = Text.of(['no trailing newline'])
        expect(previewWidgetPos(flat, 9_999)).toBe(flat.length)
    })
})

describe('sanitizePreviewColor', () => {
    it('keeps ordinary CSS color values', () => {
        expect(sanitizePreviewColor('#a1b2c3')).toBe('#a1b2c3')
        expect(sanitizePreviewColor('rgb(10, 20, 30)')).toBe('rgb(10, 20, 30)')
        expect(sanitizePreviewColor('var(--color-red)')).toBe('var(--color-red)')
    })

    it('replaces values that could break out of the declaration', () => {
        expect(sanitizePreviewColor('red; position: fixed')).toBe('var(--text-accent)')
        expect(sanitizePreviewColor('x} body {')).toBe('var(--text-accent)')
    })
})

describe('previewAriaLabel', () => {
    it('names replacements and insertions distinctly', () => {
        expect(previewAriaLabel({ kind: 'transform-selection', title: 'Rephrase — A' })).toBe(
            'Rephrase — A — proposed replacement'
        )
        expect(previewAriaLabel({ kind: 'insert-at', title: 'Say more — A' })).toBe(
            'Say more — A — proposed insertion'
        )
    })
})

describe('transformPreviewField', () => {
    it('starts empty', () => {
        expect(hasTransformPreview(stateWith('hello world'))).toBe(false)
    })

    it('shows one block widget at the anchor line end', () => {
        const state = apply(stateWith('one two\nthree'), {
            effects: showTransformPreviewEffect.of(previewSpec({ anchor: 4 }))
        })
        expect(hasTransformPreview(state)).toBe(true)
        expect(widgetPositions(state)).toEqual([7]) // end of "one two"
    })

    it('replaces the previous preview when a new one is shown', () => {
        let state = apply(stateWith('one two\nthree'), {
            effects: showTransformPreviewEffect.of(previewSpec({ anchor: 4 }))
        })
        state = apply(state, {
            effects: showTransformPreviewEffect.of(previewSpec({ runId: 'run-2', anchor: 10 }))
        })
        expect(widgetPositions(state)).toEqual([13]) // end of "three" only
    })

    it('clears on the clear effect', () => {
        let state = apply(stateWith('one two'), {
            effects: showTransformPreviewEffect.of(previewSpec({ anchor: 2 }))
        })
        state = apply(state, { effects: clearTransformPreviewEffect.of(null) })
        expect(hasTransformPreview(state)).toBe(false)
    })

    it('maps the widget through unrelated document changes', () => {
        let state = apply(stateWith('one two\nthree'), {
            effects: showTransformPreviewEffect.of(previewSpec({ anchor: 4 }))
        })
        // Insert at the very start: the widget shifts with its line.
        state = apply(state, { changes: { from: 0, to: 0, insert: 'X ' } })
        expect(widgetPositions(state)).toEqual([9])
    })

    it('maps a show effect dispatched alongside changes in one transaction', () => {
        const state = apply(stateWith('one two'), {
            changes: { from: 0, to: 0, insert: 'AB ' },
            effects: showTransformPreviewEffect.of(previewSpec({ anchor: 4 }))
        })
        // Effect positions refer to the post-change document already (CM6
        // convention): anchor 4 lands inside the changed doc's first line.
        expect(widgetPositions(state)).toEqual([10])
    })

    it('survives a change that deletes the anchor span (controller dismisses)', () => {
        let state = apply(stateWith('one two\nthree'), {
            effects: showTransformPreviewEffect.of(previewSpec({ anchor: 4 }))
        })
        state = apply(state, { changes: { from: 0, to: 7, insert: '' } })
        // The decoration maps (possibly to position 0) — it is the review
        // controller's job to detect the failed precondition and clear.
        expect(hasTransformPreview(state)).toBe(true)
    })
})

/**
 * Contract pin for the controller's Accept dispatch (queued in slice 2 as a
 * manual check until `@codemirror/commands` became a dev dependency): the
 * accepted transform must be its OWN undo event. CM6's history joins an
 * annotation-less transaction to the previous event when adjacent and within
 * `newGroupDelay`, and later `input.type` transactions join symmetrically —
 * so without `isolateHistory.of('full')`, Ctrl+Z after an accept near recent
 * typing would revert the transform AND the user's keystrokes.
 */
describe('accept history isolation (isolateHistory contract)', () => {
    function historyState(docText: string): EditorState {
        return EditorState.create({ doc: docText, extensions: [history()] })
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

    it('control: an annotation-less accept merges into adjacent typing (the hazard)', () => {
        // Type '!' at the end, then "accept" a replacement of the adjacent
        // span — annotation-less, both within newGroupDelay.
        let state = historyState('alpha beta')
        state = apply(state, {
            changes: { from: 10, to: 10, insert: '!' },
            userEvent: 'input.type'
        })
        expect(undoDepth(state)).toBe(1)
        state = apply(state, { changes: { from: 6, to: 10, insert: 'BETA' } })
        // Merged: one undo event holds both the typing and the replacement.
        expect(undoDepth(state)).toBe(1)
        expect(undoOnce(state).doc.toString()).toBe('alpha beta')
    })

    it('isolates the accept from typing that happened just before it', () => {
        let state = historyState('alpha beta')
        state = apply(state, {
            changes: { from: 10, to: 10, insert: '!' },
            userEvent: 'input.type'
        })
        state = apply(state, {
            changes: { from: 6, to: 10, insert: 'BETA' },
            annotations: isolateHistory.of('full')
        })
        expect(undoDepth(state)).toBe(2)
        // One undo reverts ONLY the accepted transform; the typing survives.
        expect(undoOnce(state).doc.toString()).toBe('alpha beta!')
    })

    it('isolates the accept from typing that continues right after it', () => {
        let state = historyState('alpha beta')
        state = apply(state, {
            changes: { from: 6, to: 10, insert: 'BETA' },
            annotations: isolateHistory.of('full')
        })
        state = apply(state, {
            changes: { from: 10, to: 10, insert: '!' },
            userEvent: 'input.type'
        })
        expect(undoDepth(state)).toBe(2)
        // One undo reverts ONLY the typing; the accepted transform survives.
        expect(undoOnce(state).doc.toString()).toBe('alpha BETA')
    })
})
