import { describe, expect, test } from 'bun:test'
import { createAnchor } from '../anchoring/anchor'
import type { TrackedEdit } from './edit-apply'
import { changesConflict, editChange, editsApplicable, planEditChanges } from './edit-apply'

// Document used by every plan test:            0123456789...
const DOC = 'alpha beta gamma delta'
//           alpha: 0-5, beta: 6-10, gamma: 11-16, delta: 17-22

function edit(partial: Partial<TrackedEdit> & Pick<TrackedEdit, 'op'>): TrackedEdit {
    return {
        text: '',
        anchor: null,
        anchoredText: null,
        matchStrategy: null,
        ...partial
    }
}

function anchored(op: TrackedEdit['op'], from: number, to: number, text = ''): TrackedEdit {
    return edit({
        op,
        text,
        anchor: createAnchor(from, to),
        anchoredText: DOC.slice(from, to),
        matchStrategy: 'exact'
    })
}

describe('editChange', () => {
    test('replace covers the anchored range with the text', () => {
        const e = anchored('replace', 6, 10, 'BETA')
        expect(editChange(e, e.anchor!)).toEqual({ from: 6, to: 10, insert: 'BETA' })
    })

    test('delete covers the range with nothing', () => {
        const e = anchored('delete', 6, 10)
        expect(editChange(e, e.anchor!)).toEqual({ from: 6, to: 10, insert: '' })
    })

    test('insert-before is zero-width at the range start — the target text survives', () => {
        const e = anchored('insert-before', 6, 10, 'X ')
        expect(editChange(e, e.anchor!)).toEqual({ from: 6, to: 6, insert: 'X ' })
    })

    test('insert-after is zero-width at the range end — the target text survives', () => {
        const e = anchored('insert-after', 6, 10, ' X')
        expect(editChange(e, e.anchor!)).toEqual({ from: 10, to: 10, insert: ' X' })
    })
})

describe('changesConflict', () => {
    test('overlapping ranges conflict', () => {
        expect(
            changesConflict([
                { from: 0, to: 5, insert: 'a' },
                { from: 4, to: 8, insert: 'b' }
            ])
        ).toBe(true)
    })

    test('touching ranges do not conflict', () => {
        expect(
            changesConflict([
                { from: 0, to: 5, insert: 'a' },
                { from: 5, to: 8, insert: 'b' }
            ])
        ).toBe(false)
    })

    test('a zero-width insertion touching a range does not conflict', () => {
        expect(
            changesConflict([
                { from: 5, to: 5, insert: 'x' },
                { from: 5, to: 8, insert: 'b' }
            ])
        ).toBe(false)
    })

    test('two zero-width insertions at the same position conflict (arbitrary order)', () => {
        expect(
            changesConflict([
                { from: 5, to: 5, insert: 'x' },
                { from: 5, to: 5, insert: 'y' }
            ])
        ).toBe(true)
    })

    test('a zero-width insertion strictly inside a range conflicts', () => {
        expect(
            changesConflict([
                { from: 0, to: 8, insert: 'a' },
                { from: 4, to: 4, insert: 'x' }
            ])
        ).toBe(true)
    })
})

describe('planEditChanges — all-or-nothing (design §4)', () => {
    test('a valid multi-edit proposal plans every change, sorted', () => {
        const plan = planEditChanges(
            [anchored('insert-after', 17, 22, '!'), anchored('replace', 0, 5, 'ALPHA')],
            DOC
        )
        expect(plan).toEqual({
            ok: true,
            changes: [
                { from: 0, to: 5, insert: 'ALPHA' },
                { from: 22, to: 22, insert: '!' }
            ]
        })
    })

    test('an empty proposal is no-proposal (critique-only findings are display-only)', () => {
        expect(planEditChanges([], DOC)).toEqual({ ok: false, reason: 'no-proposal' })
    })

    test('ONE unanchored edit makes the WHOLE proposal unapplicable', () => {
        const plan = planEditChanges(
            [anchored('replace', 0, 5, 'ALPHA'), edit({ op: 'delete' })],
            DOC
        )
        expect(plan).toEqual({ ok: false, reason: 'unanchored' })
    })

    test('ONE stale edit fails the whole proposal', () => {
        const stale: TrackedEdit = {
            ...anchored('replace', 0, 5, 'ALPHA'),
            anchor: { from: 0, to: 5, state: 'stale' }
        }
        expect(planEditChanges([anchored('delete', 6, 10), stale], DOC)).toEqual({
            ok: false,
            reason: 'stale'
        })
    })

    test('ONE failed precondition (live text changed) fails the whole proposal', () => {
        const tampered: TrackedEdit = {
            ...anchored('replace', 0, 5, 'ALPHA'),
            anchoredText: 'gone'
        }
        expect(planEditChanges([tampered], DOC)).toEqual({
            ok: false,
            reason: 'precondition-failed'
        })
    })

    test('edits overlapping EACH OTHER are an incoherent proposal', () => {
        const plan = planEditChanges(
            [anchored('replace', 0, 8, 'x'), anchored('delete', 6, 10)],
            DOC
        )
        expect(plan).toEqual({ ok: false, reason: 'conflicting-edits' })
    })

    test('insert-before + delete of the same span compose (the #17 fix shape)', () => {
        // "add an intro above the line, and separately remove the line" is
        // expressible without a replace that swallows anything.
        const plan = planEditChanges(
            [anchored('insert-before', 6, 10, 'intro '), anchored('delete', 6, 10)],
            DOC
        )
        expect(plan.ok).toBe(true)
        if (plan.ok) {
            expect(plan.changes).toEqual([
                { from: 6, to: 6, insert: 'intro ' },
                { from: 6, to: 10, insert: '' }
            ])
        }
    })
})

describe('editsApplicable mirrors the plan (advertising rule)', () => {
    test('true only when every edit is anchored and conflict-free', () => {
        expect(editsApplicable([anchored('replace', 0, 5, 'x')])).toBe(true)
        expect(editsApplicable([])).toBe(false)
        expect(editsApplicable([edit({ op: 'delete' })])).toBe(false)
        expect(editsApplicable([anchored('replace', 0, 8, 'x'), anchored('delete', 6, 10)])).toBe(
            false
        )
    })

    test('a stale edit anchor is not applicable', () => {
        const stale: TrackedEdit = {
            ...anchored('replace', 0, 5, 'x'),
            anchor: { from: 0, to: 5, state: 'stale' }
        }
        expect(editsApplicable([stale])).toBe(false)
    })
})
