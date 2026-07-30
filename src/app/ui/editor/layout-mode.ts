/**
 * Adaptive layout rules (plan M4 "Adaptive Juri layout", stage D slice 4).
 *
 * The rail, the floating cards and (later, M8) the margin comment column all
 * live over the editor, so they only work while the pane is wide enough. A
 * `ResizeObserver` on the markdown view content feeds pane widths into
 * `nextLayoutMode`; the review controller re-renders the rail in its compact
 * form below the threshold, and the finding card clamps itself into the pane
 * box computed here.
 *
 * Everything in this module is pure: the observer glue in
 * `review-controller.ts` and `finding-card.ts` only measures and applies.
 */

/**
 * How much room the pane gives the editor chrome:
 * - `wide` — full rail (labeled Review/Cancel button) + floating cards;
 * - `narrow` — compact rail (icon-only, tooltips carry everything) and cards
 *   clamped into the pane; the side panel is the real fallback surface and the
 *   compact rail's tooltip says so.
 */
export type PaneLayoutMode = 'wide' | 'narrow'

/** Pane width (px) at or below which the layout collapses to `narrow`. */
export const NARROW_MAX_WIDTH = 500

/**
 * Width (px) the pane must reach to go back to `wide`. The gap to
 * {@link NARROW_MAX_WIDTH} is hysteresis: dragging a split around the
 * threshold would otherwise re-render the rail on every observed frame, and
 * the rail is chrome the user is aiming at with the mouse.
 */
export const NARROW_EXIT_WIDTH = 560

/**
 * Next layout mode for an observed pane width, given the current one.
 *
 * A non-finite or non-positive width is NOT a narrow pane — it is a pane
 * being measured while hidden (collapsed sidebar, deferred leaf, a view being
 * detached), and flipping every such pane to compact would make the rail
 * flicker on unrelated workspace changes. Those measurements keep the current
 * mode.
 */
export function nextLayoutMode(width: number, current: PaneLayoutMode): PaneLayoutMode {
    if (!Number.isFinite(width) || width <= 0) {
        return current
    }
    if (width <= NARROW_MAX_WIDTH) {
        return 'narrow'
    }
    if (width >= NARROW_EXIT_WIDTH) {
        return 'wide'
    }
    return current
}

/** Client-coordinate box (same shape as a `DOMRect`'s edges). */
export interface LayoutBox {
    readonly left: number
    readonly top: number
    readonly right: number
    readonly bottom: number
}

/**
 * Smallest card box worth aiming for. Below these sizes clamping into the
 * pane makes the card unusable, so the pane constraint is dropped for that
 * axis (see {@link paneCardViewport}).
 */
export const CARD_MIN_WIDTH = 240
export const CARD_MIN_HEIGHT = 160

/**
 * The box a finding card must stay inside: the pane rect, inset by `padding`
 * and intersected with the window box — so a card opened in a narrow split
 * never spills over the document in the pane next to it.
 *
 * Per axis, the pane constraint is dropped when it would leave less than the
 * card minimum ({@link CARD_MIN_WIDTH} / {@link CARD_MIN_HEIGHT}): squeezing
 * a card into a sliver of a pane is worse than letting it overlay its
 * neighbour, and a pane scrolled (or dragged) partly out of the window can
 * even intersect to nothing. The axes are decided independently because
 * horizontal and vertical splits are independent.
 */
export function paneCardViewport(pane: LayoutBox, windowBox: LayoutBox, padding = 8): LayoutBox {
    const left = Math.max(windowBox.left, pane.left + padding)
    const right = Math.min(windowBox.right, pane.right - padding)
    const top = Math.max(windowBox.top, pane.top + padding)
    const bottom = Math.min(windowBox.bottom, pane.bottom - padding)
    const fitsHorizontally = right - left >= CARD_MIN_WIDTH
    const fitsVertically = bottom - top >= CARD_MIN_HEIGHT
    return {
        left: fitsHorizontally ? left : windowBox.left,
        right: fitsHorizontally ? right : windowBox.right,
        top: fitsVertically ? top : windowBox.top,
        bottom: fitsVertically ? bottom : windowBox.bottom
    }
}

/**
 * Width cap for a card inside `box`: the box width, never below
 * {@link CARD_MIN_WIDTH} (a card that cannot fit is left readable and allowed
 * to overflow rather than crushed to a column of single words).
 */
export function cardMaxWidth(box: LayoutBox): number {
    return Math.max(CARD_MIN_WIDTH, box.right - box.left)
}
