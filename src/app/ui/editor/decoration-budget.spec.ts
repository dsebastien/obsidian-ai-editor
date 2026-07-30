import { describe, expect, test } from 'bun:test'

import {
    MAX_DECORATED_FINDINGS,
    applyDecorationBudget,
    undecoratedNoticeText
} from './decoration-budget'

interface Span {
    readonly id: string
    readonly from: number
    readonly current: boolean
}

function spans(count: number, currentIndex = -1): Span[] {
    return Array.from({ length: count }, (_, index) => ({
        id: `f-${index}`,
        from: index * 10,
        current: index === currentIndex
    }))
}

describe('applyDecorationBudget', () => {
    test('returns the input untouched under the cap', () => {
        const input = spans(5)
        const result = applyDecorationBudget(input, 10)
        expect(result.decorated).toBe(input)
        expect(result.undecorated).toBe(0)
    })

    test('returns the input untouched exactly AT the cap', () => {
        const input = spans(10)
        expect(applyDecorationBudget(input, 10).decorated).toBe(input)
    })

    test('keeps the first spans in document order over the cap', () => {
        const result = applyDecorationBudget(spans(15), 10)
        expect(result.decorated.map((span) => span.id)).toEqual(spans(10).map((span) => span.id))
        expect(result.undecorated).toBe(5)
    })

    test('orders by position, not by input order', () => {
        // The store hands findings over in completion order; the cap must be
        // "the first N in the note", which is the only observable rule.
        const shuffled: Span[] = [
            { id: 'c', from: 300, current: false },
            { id: 'a', from: 100, current: false },
            { id: 'd', from: 400, current: false },
            { id: 'b', from: 200, current: false }
        ]
        expect(applyDecorationBudget(shuffled, 2).decorated.map((span) => span.id)).toEqual([
            'a',
            'b'
        ])
    })

    test('always decorates the triage cursor, even past the cap', () => {
        const result = applyDecorationBudget(spans(50, 40), 10)
        expect(result.decorated.some((span) => span.current)).toBeTrue()
        expect(result.decorated).toHaveLength(11)
        expect(result.undecorated).toBe(39)
    })

    test('does not duplicate a cursor that is already inside the cap', () => {
        const result = applyDecorationBudget(spans(50, 3), 10)
        expect(result.decorated).toHaveLength(10)
        expect(result.decorated.filter((span) => span.current)).toHaveLength(1)
        expect(result.undecorated).toBe(40)
    })

    test('every span is either decorated or counted — nothing vanishes', () => {
        for (const [total, cap] of [
            [0, 10],
            [10, 10],
            [1_000, 250],
            [10_000, MAX_DECORATED_FINDINGS]
        ] as const) {
            const result = applyDecorationBudget(spans(total), cap)
            expect(result.decorated.length + result.undecorated).toBe(total)
        }
    })

    test('a zero cap decorates nothing and counts everything', () => {
        const result = applyDecorationBudget(spans(7), 0)
        expect(result.decorated).toEqual([])
        expect(result.undecorated).toBe(7)
    })

    test('does not mutate its input', () => {
        const input = spans(15)
        const before = input.map((span) => span.id)
        applyDecorationBudget(input, 5)
        expect(input.map((span) => span.id)).toEqual(before)
    })

    test('the shipped cap is the one the docs describe', () => {
        expect(MAX_DECORATED_FINDINGS).toBe(2_000)
        expect(applyDecorationBudget(spans(2_001)).undecorated).toBe(1)
    })
})

describe('undecoratedNoticeText', () => {
    test('says nothing when nothing was left out', () => {
        expect(undecoratedNoticeText(0)).toBe('')
        expect(undecoratedNoticeText(-3)).toBe('')
    })

    test('names the consequence, singular and plural', () => {
        expect(undecoratedNoticeText(1)).toContain('1 finding is listed here but not highlighted')
        expect(undecoratedNoticeText(42)).toContain(
            '42 findings are listed here but not highlighted'
        )
    })

    test('never uses plugin vocabulary', () => {
        expect(undecoratedNoticeText(5).toLowerCase()).not.toContain('decoration')
        expect(undecoratedNoticeText(5).toLowerCase()).not.toContain('budget')
    })
})
