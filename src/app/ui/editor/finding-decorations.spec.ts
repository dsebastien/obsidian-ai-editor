import { describe, expect, it } from 'bun:test'
import { EditorState } from '@codemirror/state'
import type { StateEffect, TransactionSpec } from '@codemirror/state'
import type { DecorationSet } from '@codemirror/view'
import {
    clearFindingsEffect,
    emphasizeEditorEffect,
    findingDecorationsField,
    findingSpansAt,
    markStaleEffect,
    removeFindingsEffect,
    setFindingsEffect
} from './finding-decorations'
import type { FindingDecorationSpec } from './finding-decorations'

interface RenderedMark {
    readonly from: number
    readonly to: number
    readonly findingId: string
    readonly classes: string
    readonly style: string
}

function renderedMarks(decorations: DecorationSet): RenderedMark[] {
    const marks: RenderedMark[] = []
    const cursor = decorations.iter()
    while (cursor.value) {
        const spec = cursor.value.spec as {
            findingId?: string
            class?: string
            attributes?: Record<string, string>
        }
        marks.push({
            from: cursor.from,
            to: cursor.to,
            findingId: spec.findingId ?? '',
            classes: spec.class ?? '',
            style: spec.attributes?.['style'] ?? ''
        })
        cursor.next()
    }
    return marks
}

function findingSpec(overrides: Partial<FindingDecorationSpec> = {}): FindingDecorationSpec {
    return {
        findingId: 'f-1',
        editorId: 'e-1',
        from: 0,
        to: 5,
        color: '#ff0000',
        stale: false,
        ...overrides
    }
}

function stateWith(docText: string, ...effects: StateEffect<unknown>[]): EditorState {
    const base = EditorState.create({ doc: docText, extensions: [findingDecorationsField] })
    if (effects.length === 0) {
        return base
    }
    return base.update({ effects }).state
}

function apply(state: EditorState, spec: TransactionSpec): EditorState {
    return state.update(spec).state
}

function marksOf(state: EditorState): RenderedMark[] {
    return renderedMarks(state.field(findingDecorationsField))
}

describe('findingDecorationsField', () => {
    it('starts empty', () => {
        expect(marksOf(stateWith('alpha beta gamma'))).toEqual([])
    })

    describe('setFindings', () => {
        it('renders marks with class, color custom property, and data attributes', () => {
            const state = stateWith(
                'alpha beta gamma',
                setFindingsEffect.of([findingSpec({ from: 6, to: 10 })])
            )
            const marks = marksOf(state)
            expect(marks).toHaveLength(1)
            expect(marks[0]?.from).toBe(6)
            expect(marks[0]?.to).toBe(10)
            expect(marks[0]?.classes).toBe('ai-editor-finding')
            expect(marks[0]?.style).toBe('--ai-editor-finding-color: #ff0000')
        })

        it('renders stale specs with the stale class', () => {
            const state = stateWith(
                'alpha beta gamma',
                setFindingsEffect.of([findingSpec({ stale: true })])
            )
            expect(marksOf(state)[0]?.classes).toBe('ai-editor-finding ai-editor-finding-stale')
        })

        it('replaces any previous findings wholesale', () => {
            let state = stateWith('alpha beta gamma', setFindingsEffect.of([findingSpec()]))
            state = apply(state, {
                effects: setFindingsEffect.of([findingSpec({ findingId: 'f-2', from: 6, to: 10 })])
            })
            const marks = marksOf(state)
            expect(marks).toHaveLength(1)
            expect(marks[0]?.findingId).toBe('f-2')
        })

        it('sorts unsorted specs (RangeSet requirement)', () => {
            const state = stateWith(
                'alpha beta gamma',
                setFindingsEffect.of([
                    findingSpec({ findingId: 'late', from: 11, to: 16 }),
                    findingSpec({ findingId: 'early', from: 0, to: 5 })
                ])
            )
            expect(marksOf(state).map((m) => m.findingId)).toEqual(['early', 'late'])
        })

        it('skips empty, reversed, and out-of-bounds ranges', () => {
            const state = stateWith(
                'alpha',
                setFindingsEffect.of([
                    findingSpec({ findingId: 'empty', from: 2, to: 2 }),
                    findingSpec({ findingId: 'reversed', from: 4, to: 1 }),
                    findingSpec({ findingId: 'negative', from: -1, to: 3 }),
                    findingSpec({ findingId: 'beyond', from: 0, to: 99 }),
                    findingSpec({ findingId: 'valid', from: 0, to: 5 })
                ])
            )
            expect(marksOf(state).map((m) => m.findingId)).toEqual(['valid'])
        })

        it('falls back to a theme color when the color could escape the style attribute', () => {
            const state = stateWith(
                'alpha',
                setFindingsEffect.of([findingSpec({ color: 'red; background: url(evil)' })])
            )
            expect(marksOf(state)[0]?.style).toBe('--ai-editor-finding-color: var(--text-accent)')
        })
    })

    describe('mapping through document changes (review finding #4)', () => {
        it('shifts marks when text is inserted before them', () => {
            let state = stateWith(
                'alpha beta gamma',
                setFindingsEffect.of([findingSpec({ from: 6, to: 10 })])
            )
            state = apply(state, { changes: { from: 0, to: 0, insert: '## ' } })
            const marks = marksOf(state)
            expect(marks[0]?.from).toBe(9)
            expect(marks[0]?.to).toBe(13)
            expect(state.doc.sliceString(9, 13)).toBe('beta')
        })

        it('leaves marks alone when text changes after them', () => {
            let state = stateWith(
                'alpha beta gamma',
                setFindingsEffect.of([findingSpec({ from: 0, to: 5 })])
            )
            state = apply(state, { changes: { from: 11, to: 16, insert: 'GAMMA' } })
            const marks = marksOf(state)
            expect(marks[0]?.from).toBe(0)
            expect(marks[0]?.to).toBe(5)
        })

        it('drops marks whose range is fully deleted', () => {
            let state = stateWith(
                'alpha beta gamma',
                setFindingsEffect.of([findingSpec({ from: 6, to: 10 })])
            )
            state = apply(state, { changes: { from: 5, to: 11 } })
            expect(marksOf(state)).toEqual([])
        })
    })

    describe('markStale', () => {
        it('switches only the named findings to the stale look, in place', () => {
            let state = stateWith(
                'alpha beta gamma',
                setFindingsEffect.of([
                    findingSpec({ findingId: 'f-1', from: 0, to: 5 }),
                    findingSpec({ findingId: 'f-2', from: 6, to: 10 })
                ])
            )
            state = apply(state, { effects: markStaleEffect.of(['f-2']) })
            const marks = marksOf(state)
            expect(marks[0]?.classes).toBe('ai-editor-finding')
            expect(marks[1]?.classes).toBe('ai-editor-finding ai-editor-finding-stale')
            expect(marks[1]?.from).toBe(6)
            expect(marks[1]?.to).toBe(10)
        })

        it('ignores unknown finding ids', () => {
            let state = stateWith('alpha', setFindingsEffect.of([findingSpec()]))
            state = apply(state, { effects: markStaleEffect.of(['nope']) })
            expect(marksOf(state)[0]?.classes).toBe('ai-editor-finding')
        })

        it('applies to positions already mapped through the same transaction', () => {
            let state = stateWith(
                'alpha beta gamma',
                setFindingsEffect.of([findingSpec({ findingId: 'f-1', from: 6, to: 10 })])
            )
            state = apply(state, {
                changes: { from: 0, to: 0, insert: 'X' },
                effects: markStaleEffect.of(['f-1'])
            })
            const marks = marksOf(state)
            expect(marks[0]?.classes).toBe('ai-editor-finding ai-editor-finding-stale')
            expect(marks[0]?.from).toBe(7)
            expect(marks[0]?.to).toBe(11)
        })
    })

    describe('emphasizeEditor (rail-chip click flash)', () => {
        const twoEditors = [
            findingSpec({ findingId: 'mine', editorId: 'e-1', from: 0, to: 5 }),
            findingSpec({ findingId: 'theirs', editorId: 'e-2', from: 6, to: 10 })
        ]

        it('adds the emphasized class to exactly the given editor marks', () => {
            let state = stateWith('alpha beta gamma', setFindingsEffect.of(twoEditors))
            state = apply(state, { effects: emphasizeEditorEffect.of('e-1') })
            const marks = marksOf(state)
            expect(marks[0]?.classes).toBe('ai-editor-finding ai-editor-finding-emphasized')
            expect(marks[1]?.classes).toBe('ai-editor-finding')
        })

        it('never emphasizes stale marks (dimmed, non-revealable)', () => {
            let state = stateWith(
                'alpha beta gamma',
                setFindingsEffect.of([
                    findingSpec({ findingId: 'live', editorId: 'e-1', from: 0, to: 5 }),
                    findingSpec({
                        findingId: 'stale',
                        editorId: 'e-1',
                        from: 6,
                        to: 10,
                        stale: true
                    })
                ])
            )
            state = apply(state, { effects: emphasizeEditorEffect.of('e-1') })
            const marks = marksOf(state)
            expect(marks[0]?.classes).toBe('ai-editor-finding ai-editor-finding-emphasized')
            expect(marks[1]?.classes).toBe('ai-editor-finding ai-editor-finding-stale')
        })

        it('moves the emphasis when another editor chip is clicked', () => {
            let state = stateWith('alpha beta gamma', setFindingsEffect.of(twoEditors))
            state = apply(state, { effects: emphasizeEditorEffect.of('e-1') })
            state = apply(state, { effects: emphasizeEditorEffect.of('e-2') })
            const marks = marksOf(state)
            expect(marks[0]?.classes).toBe('ai-editor-finding')
            expect(marks[1]?.classes).toBe('ai-editor-finding ai-editor-finding-emphasized')
        })

        it('clears the emphasis with null (auto-clear timer)', () => {
            let state = stateWith('alpha beta gamma', setFindingsEffect.of(twoEditors))
            state = apply(state, { effects: emphasizeEditorEffect.of('e-1') })
            state = apply(state, { effects: emphasizeEditorEffect.of(null) })
            expect(marksOf(state).map((mark) => mark.classes)).toEqual([
                'ai-editor-finding',
                'ai-editor-finding'
            ])
        })

        it('drops the emphasis when the emphasized mark goes stale', () => {
            let state = stateWith('alpha beta gamma', setFindingsEffect.of(twoEditors))
            state = apply(state, { effects: emphasizeEditorEffect.of('e-1') })
            state = apply(state, { effects: markStaleEffect.of(['mine']) })
            expect(marksOf(state)[0]?.classes).toBe('ai-editor-finding ai-editor-finding-stale')
        })

        it('resets on a full setFindings rebuild (note switch, run change)', () => {
            let state = stateWith('alpha beta gamma', setFindingsEffect.of(twoEditors))
            state = apply(state, { effects: emphasizeEditorEffect.of('e-1') })
            state = apply(state, { effects: setFindingsEffect.of(twoEditors) })
            expect(marksOf(state).map((mark) => mark.classes)).toEqual([
                'ai-editor-finding',
                'ai-editor-finding'
            ])
        })

        it('survives unrelated document edits (marks keep the flash while mapping)', () => {
            let state = stateWith('alpha beta gamma', setFindingsEffect.of(twoEditors))
            state = apply(state, { effects: emphasizeEditorEffect.of('e-1') })
            state = apply(state, { changes: { from: 15, to: 15, insert: '!' } })
            expect(marksOf(state)[0]?.classes).toBe(
                'ai-editor-finding ai-editor-finding-emphasized'
            )
        })
    })

    describe('clearFindings', () => {
        it('removes every mark', () => {
            let state = stateWith(
                'alpha beta gamma',
                setFindingsEffect.of([
                    findingSpec({ from: 0, to: 5 }),
                    findingSpec({ findingId: 'f-2', from: 6, to: 10 })
                ])
            )
            state = apply(state, { effects: clearFindingsEffect.of(null) })
            expect(marksOf(state)).toEqual([])
        })
    })

    describe('removeFindings', () => {
        it('removes only the named findings, keeping the rest untouched', () => {
            let state = stateWith(
                'alpha beta gamma',
                setFindingsEffect.of([
                    findingSpec({ findingId: 'f-1', from: 0, to: 5 }),
                    findingSpec({ findingId: 'f-2', from: 6, to: 10 }),
                    findingSpec({ findingId: 'f-3', from: 11, to: 16 })
                ])
            )
            state = apply(state, { effects: removeFindingsEffect.of(['f-1', 'f-3']) })
            expect(marksOf(state).map((m) => m.findingId)).toEqual(['f-2'])
        })

        it('ignores unknown finding ids', () => {
            let state = stateWith('alpha', setFindingsEffect.of([findingSpec()]))
            state = apply(state, { effects: removeFindingsEffect.of(['nope']) })
            expect(marksOf(state)).toHaveLength(1)
        })

        it('combines with a document change in the same transaction', () => {
            let state = stateWith(
                'alpha beta gamma',
                setFindingsEffect.of([
                    findingSpec({ findingId: 'f-1', from: 0, to: 5 }),
                    findingSpec({ findingId: 'f-2', from: 6, to: 10 })
                ])
            )
            // Accept-style dispatch: replace the range and drop its mark.
            state = apply(state, {
                changes: { from: 0, to: 5, insert: 'ALPHA INDEED' },
                effects: removeFindingsEffect.of(['f-1'])
            })
            const marks = marksOf(state)
            expect(marks.map((m) => m.findingId)).toEqual(['f-2'])
            expect(state.doc.sliceString(marks[0]?.from ?? 0, marks[0]?.to ?? 0)).toBe('beta')
        })
    })

    describe('findingSpansAt', () => {
        it('returns the spans covering a position', () => {
            const state = stateWith(
                'alpha beta gamma',
                setFindingsEffect.of([
                    findingSpec({ findingId: 'f-1', from: 0, to: 5 }),
                    findingSpec({ findingId: 'f-2', from: 6, to: 10 })
                ])
            )
            expect(findingSpansAt(state, 7)).toEqual([
                { findingId: 'f-2', editorId: 'e-1', from: 6, to: 10, stale: false }
            ])
        })

        it('returns every overlapping span at the position', () => {
            const state = stateWith(
                'alpha beta gamma',
                setFindingsEffect.of([
                    findingSpec({ findingId: 'wide', from: 0, to: 16 }),
                    findingSpec({ findingId: 'narrow', from: 6, to: 10, stale: true })
                ])
            )
            const spans = findingSpansAt(state, 8)
            expect(spans.map((s) => s.findingId).sort()).toEqual(['narrow', 'wide'])
            expect(spans.find((s) => s.findingId === 'narrow')?.stale).toBe(true)
        })

        it('returns nothing away from any span', () => {
            const state = stateWith(
                'alpha beta gamma',
                setFindingsEffect.of([findingSpec({ from: 0, to: 5 })])
            )
            expect(findingSpansAt(state, 12)).toEqual([])
        })

        it('returns nothing when the field is not installed', () => {
            const state = EditorState.create({ doc: 'alpha' })
            expect(findingSpansAt(state, 0)).toEqual([])
        })
    })

    describe('setFindings effect position mapping', () => {
        it('maps effect positions when the same transaction also changes the document', () => {
            const base = stateWith('alpha beta gamma')
            const tr = base.update({ changes: { from: 0, to: 0, insert: '# ' } })
            const effect = setFindingsEffect.of([findingSpec({ from: 6, to: 10 })])
            const mapped = effect.map(tr.changes)
            expect(mapped).not.toBeNull()
            if (!mapped) {
                return
            }
            expect(mapped.value[0]?.from).toBe(8)
            expect(mapped.value[0]?.to).toBe(12)
        })
    })
})
