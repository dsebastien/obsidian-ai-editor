import { describe, expect, it } from 'bun:test'
import {
    CARD_MIN_HEIGHT,
    CARD_MIN_WIDTH,
    NARROW_EXIT_WIDTH,
    NARROW_MAX_WIDTH,
    cardMaxWidth,
    nextLayoutMode,
    paneCardViewport
} from './layout-mode'
import type { LayoutBox } from './layout-mode'

describe('nextLayoutMode', () => {
    it('collapses to narrow at or below the threshold', () => {
        expect(nextLayoutMode(NARROW_MAX_WIDTH, 'wide')).toBe('narrow')
        expect(nextLayoutMode(320, 'wide')).toBe('narrow')
    })

    it('stays wide above the exit width', () => {
        expect(nextLayoutMode(NARROW_EXIT_WIDTH, 'narrow')).toBe('wide')
        expect(nextLayoutMode(1_200, 'narrow')).toBe('wide')
    })

    it('keeps the current mode inside the hysteresis band', () => {
        const inBand = (NARROW_MAX_WIDTH + NARROW_EXIT_WIDTH) / 2
        expect(nextLayoutMode(inBand, 'narrow')).toBe('narrow')
        expect(nextLayoutMode(inBand, 'wide')).toBe('wide')
    })

    it('has a non-empty hysteresis band (no flapping at the threshold)', () => {
        expect(NARROW_EXIT_WIDTH).toBeGreaterThan(NARROW_MAX_WIDTH)
    })

    it('keeps the current mode for a hidden or unmeasurable pane', () => {
        for (const width of [0, -10, Number.NaN, Number.POSITIVE_INFINITY]) {
            expect(nextLayoutMode(width, 'wide')).toBe('wide')
            expect(nextLayoutMode(width, 'narrow')).toBe('narrow')
        }
    })
})

const windowBox: LayoutBox = { left: 8, top: 8, right: 1_608, bottom: 908 }

describe('paneCardViewport', () => {
    it('constrains the card to the pane, inset by the padding', () => {
        const pane: LayoutBox = { left: 800, top: 100, right: 1_600, bottom: 900 }
        expect(paneCardViewport(pane, windowBox, 8)).toEqual({
            left: 808,
            top: 108,
            right: 1_592,
            bottom: 892
        })
    })

    it('never exceeds the window box', () => {
        const pane: LayoutBox = { left: -200, top: -200, right: 5_000, bottom: 5_000 }
        expect(paneCardViewport(pane, windowBox, 8)).toEqual(windowBox)
    })

    it('drops the pane constraint on an axis too small for a card', () => {
        // 200px-wide pane (< CARD_MIN_WIDTH) but plenty tall: the card keeps
        // the window width and the pane height.
        const pane: LayoutBox = { left: 800, top: 100, right: 1_000, bottom: 900 }
        const box = paneCardViewport(pane, windowBox, 8)
        expect(box.left).toBe(windowBox.left)
        expect(box.right).toBe(windowBox.right)
        expect(box.top).toBe(108)
        expect(box.bottom).toBe(892)
    })

    it('decides the axes independently', () => {
        // Wide but very short pane: horizontal clamp stays, vertical drops.
        const pane: LayoutBox = { left: 400, top: 300, right: 1_400, bottom: 400 }
        const box = paneCardViewport(pane, windowBox, 8)
        expect(box.left).toBe(408)
        expect(box.right).toBe(1_392)
        expect(box.top).toBe(windowBox.top)
        expect(box.bottom).toBe(windowBox.bottom)
    })

    it('falls back to the window box for a pane outside the window', () => {
        const pane: LayoutBox = { left: 2_000, top: 2_000, right: 2_800, bottom: 2_800 }
        expect(paneCardViewport(pane, windowBox, 8)).toEqual(windowBox)
    })

    it('honors the axis minimums exactly', () => {
        const pane: LayoutBox = {
            left: 100,
            top: 100,
            right: 100 + CARD_MIN_WIDTH,
            bottom: 100 + CARD_MIN_HEIGHT
        }
        // With zero padding the pane box is exactly the minimum → kept.
        const kept = paneCardViewport(pane, windowBox, 0)
        expect(kept).toEqual({
            left: 100,
            top: 100,
            right: 100 + CARD_MIN_WIDTH,
            bottom: 100 + CARD_MIN_HEIGHT
        })
        // One pixel of padding takes it below the minimum on both axes.
        expect(paneCardViewport(pane, windowBox, 1)).toEqual(windowBox)
    })
})

describe('cardMaxWidth', () => {
    it('is the box width when the box is roomy', () => {
        expect(cardMaxWidth({ left: 100, top: 0, right: 700, bottom: 500 })).toBe(600)
    })

    it('never goes below the card minimum', () => {
        expect(cardMaxWidth({ left: 100, top: 0, right: 180, bottom: 500 })).toBe(CARD_MIN_WIDTH)
        expect(cardMaxWidth({ left: 100, top: 0, right: 90, bottom: 500 })).toBe(CARD_MIN_WIDTH)
    })
})
