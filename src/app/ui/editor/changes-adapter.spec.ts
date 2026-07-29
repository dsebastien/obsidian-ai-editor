import { describe, expect, it } from 'bun:test'
import { EditorState } from '@codemirror/state'
import type { ChangeSpec } from '@codemirror/state'
import { changesFromTransaction } from './changes-adapter'
import { createAnchor, mapAnchorThroughChanges } from '../../domain/anchoring/anchor'

function transactionOf(docText: string, changes: ChangeSpec) {
    return EditorState.create({ doc: docText }).update({ changes })
}

describe('changesFromTransaction', () => {
    it('adapts a single insertion (pre-change coordinates, zero-width range)', () => {
        const tr = transactionOf('hello world', { from: 5, to: 5, insert: ' dear' })
        expect(changesFromTransaction(tr)).toEqual([{ from: 5, to: 5, insertedLength: 5 }])
    })

    it('adapts a single deletion (insertedLength 0)', () => {
        const tr = transactionOf('hello world', { from: 5, to: 11 })
        expect(changesFromTransaction(tr)).toEqual([{ from: 5, to: 11, insertedLength: 0 }])
    })

    it('adapts a replacement', () => {
        const tr = transactionOf('hello world', { from: 6, to: 11, insert: 'there!' })
        expect(changesFromTransaction(tr)).toEqual([{ from: 6, to: 11, insertedLength: 6 }])
    })

    it('adapts a multi-change transaction sorted ascending in pre-change coordinates', () => {
        const tr = transactionOf('hello world', [
            { from: 6, to: 11, insert: 'moon' },
            { from: 0, to: 5, insert: 'goodbye' }
        ])
        expect(tr.newDoc.toString()).toBe('goodbye moon')
        expect(changesFromTransaction(tr)).toEqual([
            { from: 0, to: 5, insertedLength: 7 },
            { from: 6, to: 11, insertedLength: 4 }
        ])
    })

    it('returns an empty list for a changeless transaction', () => {
        const tr = EditorState.create({ doc: 'hello' }).update({ selection: { anchor: 2 } })
        expect(changesFromTransaction(tr)).toEqual([])
    })

    describe('round-trip with domain anchor mapping', () => {
        const doc = 'alpha beta gamma delta'
        const anchoredText = 'gamma'
        const from = doc.indexOf(anchoredText)
        const to = from + anchoredText.length

        const cases: { name: string; changes: ChangeSpec }[] = [
            { name: 'insertion before the anchor', changes: { from: 0, to: 0, insert: '## ' } },
            { name: 'deletion before the anchor', changes: { from: 0, to: 6 } },
            {
                name: 'replacement before the anchor',
                changes: { from: 6, to: 10, insert: 'BETA!' }
            },
            {
                name: 'change after the anchor',
                changes: { from: doc.length, to: doc.length, insert: ' epsilon' }
            },
            {
                name: 'multiple changes around the anchor',
                changes: [
                    { from: 0, to: 5, insert: 'a' },
                    { from: 6, to: 10, insert: 'bb' },
                    { from: doc.length - 5, to: doc.length, insert: 'd' }
                ]
            }
        ]

        for (const { name, changes } of cases) {
            it(`keeps the anchor over its text: ${name}`, () => {
                const tr = transactionOf(doc, changes)
                const mapped = mapAnchorThroughChanges(
                    createAnchor(from, to),
                    changesFromTransaction(tr)
                )
                expect(mapped.state).toBe('anchored')
                expect(tr.newDoc.sliceString(mapped.from, mapped.to)).toBe(anchoredText)
            })
        }

        it('marks the anchor stale when a change overlaps it', () => {
            const tr = transactionOf(doc, { from: from + 1, to: from + 3, insert: 'X' })
            const mapped = mapAnchorThroughChanges(
                createAnchor(from, to),
                changesFromTransaction(tr)
            )
            expect(mapped.state).toBe('stale')
        })
    })
})
