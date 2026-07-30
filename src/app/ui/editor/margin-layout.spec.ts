import { describe, expect, it } from 'bun:test'
import {
    clusterByLine,
    marginColumnPlacement,
    marginColumnWidth,
    stackMarginSlots,
    MARGIN_CARD_GAP,
    MARGIN_COLUMN_GAP,
    MARGIN_COLUMN_MIN_WIDTH,
    MARGIN_COLUMN_WIDTH,
    MARGIN_MIN_PANE_WIDTH,
    MARGIN_MODE_HYSTERESIS,
    SAME_LINE_EPSILON
} from './margin-layout'
import type { MarginPlacementInput, MarginPlacementMode, MarginSlotInput } from './margin-layout'

const placement = (overrides: Partial<MarginPlacementInput> = {}): MarginPlacementInput => ({
    enabled: true,
    hasComments: true,
    paneWidth: 1_200,
    freeRight: 400,
    current: 'hidden',
    ...overrides
})

describe('marginColumnWidth', () => {
    it('never exceeds the preferred width', () => {
        expect(marginColumnWidth(4_000)).toBe(MARGIN_COLUMN_WIDTH)
    })

    it('never eats more than a third of the pane', () => {
        expect(marginColumnWidth(750)).toBe(250)
    })

    it('reports nothing for an unmeasurable pane', () => {
        expect(marginColumnWidth(0)).toBe(0)
        expect(marginColumnWidth(Number.NaN)).toBe(0)
    })

    it('is at least the minimum width at the smallest pane that gets a column', () => {
        // The invariant that lets `marginColumnPlacement` have no
        // "too narrow to render" branch.
        expect(marginColumnWidth(MARGIN_MIN_PANE_WIDTH)).toBeGreaterThanOrEqual(
            MARGIN_COLUMN_MIN_WIDTH
        )
    })
})

describe('marginColumnPlacement', () => {
    it('hides the column when the user turned it off', () => {
        expect(marginColumnPlacement(placement({ enabled: false })).mode).toBe('hidden')
    })

    it('hides the column when the note has no comments (no empty gutter)', () => {
        expect(marginColumnPlacement(placement({ hasComments: false })).mode).toBe('hidden')
    })

    it('hides the column in a pane too small to host it', () => {
        expect(
            marginColumnPlacement(placement({ paneWidth: MARGIN_MIN_PANE_WIDTH - 1 })).mode
        ).toBe('hidden')
    })

    it('hides the column for a pane measured while hidden', () => {
        expect(marginColumnPlacement(placement({ paneWidth: 0 })).mode).toBe('hidden')
        expect(marginColumnPlacement(placement({ paneWidth: Number.NaN })).mode).toBe('hidden')
    })

    it('overlays free margin without reserving anything', () => {
        const result = marginColumnPlacement(placement({ freeRight: 500 }))
        expect(result.mode).toBe('overlay')
        expect(result.reserve).toBe(0)
        expect(result.width).toBe(MARGIN_COLUMN_WIDTH)
    })

    it('reserves space when the text runs the full width', () => {
        const result = marginColumnPlacement(placement({ freeRight: 0 }))
        expect(result.mode).toBe('reserve')
        expect(result.reserve).toBe(MARGIN_COLUMN_WIDTH + MARGIN_COLUMN_GAP)
    })

    it('reserves only what the free margin does not already cover', () => {
        const result = marginColumnPlacement(placement({ freeRight: 100 }))
        expect(result.reserve).toBe(MARGIN_COLUMN_WIDTH + MARGIN_COLUMN_GAP - 100)
    })

    it('keeps overlaying at exactly the width it needs', () => {
        const free = MARGIN_COLUMN_WIDTH + MARGIN_COLUMN_GAP
        expect(marginColumnPlacement(placement({ freeRight: free, current: 'overlay' })).mode).toBe(
            'overlay'
        )
    })

    it('needs extra room to leave reserve mode (hysteresis)', () => {
        const free = MARGIN_COLUMN_WIDTH + MARGIN_COLUMN_GAP + 1
        expect(marginColumnPlacement(placement({ freeRight: free, current: 'reserve' })).mode).toBe(
            'reserve'
        )
        expect(
            marginColumnPlacement(
                placement({ freeRight: free + MARGIN_MODE_HYSTERESIS, current: 'reserve' })
            ).mode
        ).toBe('overlay')
    })

    it('does not flip mode inside the hysteresis band', () => {
        const free = MARGIN_COLUMN_WIDTH + MARGIN_COLUMN_GAP + 10
        const modes: MarginPlacementMode[] = ['overlay', 'reserve']
        expect(
            modes.map(
                (current) => marginColumnPlacement(placement({ freeRight: free, current })).mode
            )
        ).toEqual(['overlay', 'reserve'])
    })
})

describe('clusterByLine', () => {
    it('groups comments whose anchors sit on the same line', () => {
        const clusters = clusterByLine([
            { id: 'a', anchorTop: 100 },
            { id: 'b', anchorTop: 100 },
            { id: 'c', anchorTop: 240 }
        ])
        expect(clusters.map((cluster) => cluster.ids)).toEqual([['a', 'b'], ['c']])
    })

    it('keys a cluster on its first member so the key is stable', () => {
        const clusters = clusterByLine([
            { id: 'b', anchorTop: 100 },
            { id: 'a', anchorTop: 100 }
        ])
        expect(clusters[0]?.key).toBe('b')
        expect(clusters[0]?.anchorTop).toBe(100)
    })

    it('sorts by anchor and breaks ties by input order', () => {
        const clusters = clusterByLine([
            { id: 'later', anchorTop: 300 },
            { id: 'first', anchorTop: 10 },
            { id: 'first-tie', anchorTop: 10 }
        ])
        expect(clusters.map((cluster) => cluster.key)).toEqual(['first', 'later'])
        expect(clusters[0]?.ids).toEqual(['first', 'first-tie'])
    })

    it('absorbs sub-pixel rounding but never merges neighbouring lines', () => {
        const clusters = clusterByLine([
            { id: 'a', anchorTop: 100 },
            { id: 'b', anchorTop: 100 + SAME_LINE_EPSILON },
            { id: 'c', anchorTop: 100 + SAME_LINE_EPSILON * 2 + 1 }
        ])
        expect(clusters.map((cluster) => cluster.ids)).toEqual([['a', 'b'], ['c']])
    })

    it('returns nothing for nothing', () => {
        expect(clusterByLine([])).toEqual([])
    })
})

describe('stackMarginSlots', () => {
    const bounds = { top: 0, bottom: 1_000 }
    const slot = (key: string, anchorTop: number, height = 60): MarginSlotInput => ({
        key,
        anchorTop,
        height
    })

    it('leaves well-separated cards exactly at their anchors', () => {
        const positions = stackMarginSlots([slot('a', 100), slot('b', 400)], bounds)
        expect(positions.map((position) => position.top)).toEqual([100, 400])
    })

    it('pushes an overlapping card below its predecessor', () => {
        const positions = stackMarginSlots([slot('a', 100), slot('b', 120)], bounds)
        expect(positions.map((position) => position.top)).toEqual([100, 100 + 60 + MARGIN_CARD_GAP])
    })

    it('is independent of input order', () => {
        const ordered = stackMarginSlots([slot('a', 100), slot('b', 120)], bounds)
        const shuffled = stackMarginSlots([slot('b', 120), slot('a', 100)], bounds)
        expect(shuffled).toEqual(ordered)
    })

    it('never pushes a card below the column bottom when it can pull up', () => {
        const positions = stackMarginSlots([slot('a', 900), slot('b', 900), slot('c', 900)], {
            top: 0,
            bottom: 1_000
        })
        const last = positions[positions.length - 1]
        expect((last?.top ?? 0) + (last?.height ?? 0)).toBeLessThanOrEqual(1_000)
        // Still ordered, still non-overlapping after the pull-up pass.
        for (let index = 1; index < positions.length; index += 1) {
            const previous = positions[index - 1]
            const current = positions[index]
            expect(current?.top ?? 0).toBeGreaterThanOrEqual(
                (previous?.top ?? 0) + (previous?.height ?? 0) + MARGIN_CARD_GAP
            )
        }
    })

    it('lets a card sit above its anchor rather than off-screen', () => {
        const positions = stackMarginSlots([slot('a', 980)], { top: 0, bottom: 1_000 })
        expect(positions[0]?.top).toBe(1_000 - 60)
    })

    it('never pulls a card above the column top, even when nothing fits', () => {
        const positions = stackMarginSlots(
            [slot('a', 0, 400), slot('b', 0, 400), slot('c', 0, 400)],
            { top: 0, bottom: 500 }
        )
        expect(positions.every((position) => position.top >= 0)).toBe(true)
        expect(positions[0]?.top).toBe(0)
    })

    it('starts the stack at the column top when an anchor scrolled above it', () => {
        const positions = stackMarginSlots([slot('a', -200)], { top: 10, bottom: 1_000 })
        expect(positions[0]?.top).toBe(10)
    })

    it('returns nothing for nothing', () => {
        expect(stackMarginSlots([], bounds)).toEqual([])
    })
})
