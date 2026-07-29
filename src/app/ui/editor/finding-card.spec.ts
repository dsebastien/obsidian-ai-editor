import { describe, expect, it } from 'bun:test'
import { CARD_GAP, computeCardPosition, selectFindingsAtPos } from './finding-card'
import type { CardAnchorRect, CardSize, CardViewport, FindingSpanCandidate } from './finding-card'

const viewport: CardViewport = { left: 8, top: 8, right: 1008, bottom: 708 }
const card: CardSize = { width: 300, height: 200 }

function anchor(overrides: Partial<CardAnchorRect> = {}): CardAnchorRect {
    return { left: 100, top: 100, bottom: 120, ...overrides }
}

describe('computeCardPosition', () => {
    it('places the card below the anchor, left-aligned, when it fits', () => {
        const position = computeCardPosition(anchor(), card, viewport)
        expect(position).toEqual({ left: 100, top: 120 + CARD_GAP })
    })

    it('honors a custom gap', () => {
        const position = computeCardPosition(anchor(), card, viewport, 20)
        expect(position.top).toBe(140)
    })

    it('clamps the left edge to the viewport left', () => {
        const position = computeCardPosition(anchor({ left: -50 }), card, viewport)
        expect(position.left).toBe(viewport.left)
    })

    it('clamps the right edge so the card stays inside the viewport', () => {
        const position = computeCardPosition(anchor({ left: 990 }), card, viewport)
        expect(position.left).toBe(viewport.right - card.width)
    })

    it('flips above the anchor when there is no room below', () => {
        const position = computeCardPosition(anchor({ top: 600, bottom: 620 }), card, viewport)
        expect(position.top).toBe(600 - CARD_GAP - card.height)
    })

    it('clamps to the viewport bottom when the card fits on neither side', () => {
        const tallCard: CardSize = { width: 300, height: 650 }
        const position = computeCardPosition(anchor({ top: 350, bottom: 370 }), tallCard, viewport)
        expect(position.top).toBe(viewport.bottom - tallCard.height)
    })

    it('pins to the viewport top when the card is taller than the viewport', () => {
        const hugeCard: CardSize = { width: 300, height: 5_000 }
        const position = computeCardPosition(anchor(), hugeCard, viewport)
        expect(position.top).toBe(viewport.top)
    })

    it('pins to the viewport left when the card is wider than the viewport', () => {
        const wideCard: CardSize = { width: 5_000, height: 200 }
        const position = computeCardPosition(anchor(), wideCard, viewport)
        expect(position.left).toBe(viewport.left)
    })
})

function candidate(findingId: string, from: number, to: number): FindingSpanCandidate {
    return { findingId, from, to }
}

describe('selectFindingsAtPos', () => {
    it('returns nothing when no span covers the position', () => {
        expect(selectFindingsAtPos([candidate('f-1', 0, 5)], 10)).toEqual([])
    })

    it('returns the single covering finding', () => {
        expect(selectFindingsAtPos([candidate('f-1', 0, 5)], 3)).toEqual(['f-1'])
    })

    it('treats span boundaries as covering (inclusive)', () => {
        const candidates = [candidate('f-1', 5, 10)]
        expect(selectFindingsAtPos(candidates, 5)).toEqual(['f-1'])
        expect(selectFindingsAtPos(candidates, 10)).toEqual(['f-1'])
    })

    it('stacks overlapping findings innermost-first', () => {
        const candidates = [
            candidate('outer', 0, 100),
            candidate('inner', 40, 50),
            candidate('middle', 20, 80)
        ]
        expect(selectFindingsAtPos(candidates, 45)).toEqual(['inner', 'middle', 'outer'])
    })

    it('breaks equal-length ties by start position, then id', () => {
        const byFrom = [candidate('b', 10, 20), candidate('a', 12, 22)]
        expect(selectFindingsAtPos(byFrom, 15)).toEqual(['b', 'a'])
        const byId = [candidate('b', 10, 20), candidate('a', 10, 20)]
        expect(selectFindingsAtPos(byId, 15)).toEqual(['a', 'b'])
    })

    it('dedupes duplicate finding ids', () => {
        const candidates = [candidate('f-1', 0, 10), candidate('f-1', 2, 8)]
        expect(selectFindingsAtPos(candidates, 5)).toEqual(['f-1'])
    })

    it('ignores empty spans', () => {
        expect(selectFindingsAtPos([candidate('empty', 5, 5)], 5)).toEqual([])
    })
})
