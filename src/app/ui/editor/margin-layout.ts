/**
 * Geometry of the margin comment column (plan §5.5 / M8, slice 3).
 *
 * Everything in this module is pure arithmetic over measurements the glue
 * takes; no DOM, no CodeMirror. Three decisions live here:
 *
 * 1. **Where the column may exist at all** ({@link marginColumnPlacement}).
 * 2. **Which comments share a line** ({@link clusterByLine}) — a line with
 *    several comments collapses to one chip instead of stacking three cards
 *    over the same sentence.
 * 3. **Where each group actually lands** ({@link stackMarginSlots}) — cards
 *    want to sit next to their span but must not overlap, so they push each
 *    other down and, at the bottom of the viewport, pull each other back up.
 *
 * ## Why not a CM6 gutter
 *
 * The same reason the rail is not one (`rail.ts` header): CM6 gutters are
 * left-side, line-oriented strips inside the scroller. A right-hand comment
 * column is neither — it is chrome the user reads in parallel with the text,
 * its items are taller than a line, and it has to coexist with Obsidian's own
 * gutters (line numbers, fold) rather than compete for the same slot. So the
 * column is an absolutely-positioned overlay owned by the markdown view, and
 * this module is what keeps it aligned with the lines underneath.
 *
 * ## Coexistence with Obsidian's editor width — the decision
 *
 * With **Readable line length** on (Obsidian's default), the text is centered
 * and the pane already has a wide empty right margin. The column drops into
 * that space and the note's layout does not move at all — `overlay`.
 *
 * With readable line length off, the text runs the full pane width and there
 * is no free margin. Floating cards on top of the prose would be unreadable
 * and would hide the very sentences they comment on, so the column instead
 * RESERVES its width by padding the editor scroller — `reserve`. The text
 * reflows once, when the first comment appears on the note and when the last
 * one leaves, both of which are explicit user actions.
 *
 * The mode is decided from the free space measured with any reserve already
 * added back (`freeRight`), so applying the reserve cannot flip the decision
 * that produced it. {@link MARGIN_MODE_HYSTERESIS} widens the return path to
 * `overlay` for the same reason `nextLayoutMode` has a band: dragging a split
 * across the boundary must not reflow the note on every observed frame.
 */

/** Preferred column width (px). Wide enough for a question plus an answer. */
export const MARGIN_COLUMN_WIDTH = 280

/**
 * Narrowest column worth rendering. Below this a card is a column of single
 * words, and the side panel — which is the documented narrow fallback for
 * every other surface — is a better place to read comments.
 */
export const MARGIN_COLUMN_MIN_WIDTH = 220

/** Gap between the text and the column. */
export const MARGIN_COLUMN_GAP = 12

/** Vertical gap between two stacked groups. */
export const MARGIN_CARD_GAP = 8

/**
 * Pane width (px) below which there is no margin column at all.
 *
 * Deliberately far above `NARROW_MAX_WIDTH` (500): the rail is 16px chips and
 * survives a narrow pane, a comment column is 220px of prose and does not. A
 * pane that cannot host the column keeps its comments in the side panel, and
 * the plan's M4 row already records that the ~900px three-column figure was
 * superseded pending this slice — this is the number it is superseded by.
 */
export const MARGIN_MIN_PANE_WIDTH = 700

/**
 * Extra free space required to go back to `overlay` once `reserve` is
 * applied. Hysteresis, not a fudge factor: without it a pane sitting exactly
 * on the boundary would reflow the note on every resize frame.
 */
export const MARGIN_MODE_HYSTERESIS = 40

/**
 * How the column coexists with the note's text:
 * - `overlay` — it sits in free margin; the text does not move;
 * - `reserve` — the editor is padded by the column's width; the text reflows
 *   once when the column appears and once when it goes;
 * - `hidden` — no column (disabled, no comments, or the pane is too small);
 *   the side panel is the surface.
 */
export type MarginPlacementMode = 'overlay' | 'reserve' | 'hidden'

export interface MarginPlacement {
    readonly mode: MarginPlacementMode
    /** Column width in px; `0` when hidden. */
    readonly width: number
    /**
     * Padding to apply to the editor scroller, in px. Non-zero only in
     * `reserve` mode — the glue sets it as a CSS custom property and clears it
     * on every other mode, so nothing can leave the editor padded.
     */
    readonly reserve: number
}

export const HIDDEN_MARGIN_PLACEMENT: MarginPlacement = { mode: 'hidden', width: 0, reserve: 0 }

export interface MarginPlacementInput {
    /** The user's toggle (`behavior.showMarginComments`). */
    readonly enabled: boolean
    /** At least one comment would be rendered. */
    readonly hasComments: boolean
    /** Markdown view content width, px. */
    readonly paneWidth: number
    /**
     * Free space to the right of the TEXT inside the pane, px, measured with
     * any currently-applied reserve added back. Passing the raw measurement
     * while the reserve is applied would make the mode oscillate.
     */
    readonly freeRight: number
    /** Mode currently applied, for the hysteresis band. */
    readonly current: MarginPlacementMode
}

/**
 * Whether a column may be shown, how wide, and whether it costs the text any
 * space.
 *
 * A non-finite or non-positive pane width means the pane is being measured
 * while hidden (collapsed sidebar, deferred leaf). That yields `hidden` on
 * purpose — unlike the rail's compact form, there is nothing to flicker: the
 * pane is not on screen, and the column is rebuilt from the model the moment
 * it is measured again.
 */
export function marginColumnPlacement(input: MarginPlacementInput): MarginPlacement {
    if (!input.enabled || !input.hasComments) {
        return HIDDEN_MARGIN_PLACEMENT
    }
    if (!Number.isFinite(input.paneWidth) || input.paneWidth < MARGIN_MIN_PANE_WIDTH) {
        return HIDDEN_MARGIN_PLACEMENT
    }
    // At the pane gate the width rule already yields at least
    // MARGIN_COLUMN_MIN_WIDTH (spec-pinned as an invariant between the two
    // constants), so there is no "too narrow to render" branch here.
    const width = marginColumnWidth(input.paneWidth)
    const needed = width + MARGIN_COLUMN_GAP
    const free = Number.isFinite(input.freeRight) ? input.freeRight : 0
    const overlays =
        input.current === 'overlay' ? free >= needed : free >= needed + MARGIN_MODE_HYSTERESIS
    if (overlays) {
        return { mode: 'overlay', width, reserve: 0 }
    }
    // Reserve exactly what the overlay would have needed and no more: the
    // padding is a constant of the column, not of the current measurement, so
    // it cannot drift a pixel per resize.
    return { mode: 'reserve', width, reserve: Math.max(0, needed - Math.max(0, free)) }
}

/**
 * Column width for a pane: the preferred width, clamped so it never eats more
 * than a third of the pane (the note is what the user is reading), and never
 * reported below the minimum — a placement that cannot reach
 * {@link MARGIN_COLUMN_MIN_WIDTH} is hidden instead of crushed.
 */
export function marginColumnWidth(paneWidth: number): number {
    if (!Number.isFinite(paneWidth) || paneWidth <= 0) {
        return 0
    }
    return Math.min(MARGIN_COLUMN_WIDTH, Math.floor(paneWidth / 3))
}

// ---------------------------------------------------------------------------
// Line clustering
// ---------------------------------------------------------------------------

/**
 * Vertical distance (px) within which two anchors count as the same line.
 * Small on purpose: two comments on the same line measure to the SAME top, so
 * this only absorbs sub-pixel rounding, never merges neighbouring lines.
 */
export const SAME_LINE_EPSILON = 4

export interface MarginClusterInput {
    readonly id: string
    /** Desired y of the comment's anchor, in column coordinates. */
    readonly anchorTop: number
}

export interface MarginCluster {
    /** The first member's id — stable across renders, unlike an index. */
    readonly key: string
    readonly anchorTop: number
    readonly ids: readonly string[]
}

/**
 * Groups comments whose anchors sit on the same line.
 *
 * Sorted by anchor position, ties broken by input order (which is the stored
 * order, i.e. the order the user asked the questions in) — so a line's chip
 * always expands to the same sequence.
 *
 * The cluster's `anchorTop` is the FIRST member's: a group must align with the
 * line it belongs to, and averaging over members that are all on that line
 * would only introduce rounding.
 */
export function clusterByLine(
    items: readonly MarginClusterInput[],
    epsilon: number = SAME_LINE_EPSILON
): readonly MarginCluster[] {
    const ordered = items
        .map((item, index) => ({ item, index }))
        .sort((a, b) =>
            a.item.anchorTop === b.item.anchorTop
                ? a.index - b.index
                : a.item.anchorTop - b.item.anchorTop
        )
    const clusters: { key: string; anchorTop: number; ids: string[] }[] = []
    for (const { item } of ordered) {
        const last = clusters[clusters.length - 1]
        if (last && Math.abs(item.anchorTop - last.anchorTop) <= epsilon) {
            last.ids.push(item.id)
            continue
        }
        clusters.push({ key: item.id, anchorTop: item.anchorTop, ids: [item.id] })
    }
    return clusters
}

// ---------------------------------------------------------------------------
// Stacking
// ---------------------------------------------------------------------------

export interface MarginSlotInput {
    readonly key: string
    /** Where the slot WANTS to be (its anchor's y). */
    readonly anchorTop: number
    /** Measured height of the rendered group. */
    readonly height: number
}

export interface MarginSlotPosition {
    readonly key: string
    readonly top: number
    readonly height: number
}

export interface MarginStackBounds {
    readonly top: number
    readonly bottom: number
}

/**
 * Lays out the groups: each one as close to its anchor as it can get without
 * overlapping its neighbours.
 *
 * Two passes, and both are needed:
 *
 * - **Push down** (top → bottom): a group starts at its anchor, or right
 *   below the previous group when its anchor would overlap it. This is what
 *   makes a run of comments on consecutive lines readable.
 * - **Pull up** (bottom → top): after pushing, the last groups can be shoved
 *   past the bottom of the viewport, where they would simply not be visible.
 *   The second pass pulls the overflowing tail back up, never above
 *   `bounds.top` and never past its own anchor — a card is allowed to sit
 *   ABOVE its line (it is still the nearest legible position) but is never
 *   dragged off the top of the column.
 *
 * Input order is irrelevant: the slots are sorted by anchor first, so the
 * output is a function of the geometry alone.
 */
export function stackMarginSlots(
    slots: readonly MarginSlotInput[],
    bounds: MarginStackBounds,
    gap: number = MARGIN_CARD_GAP
): readonly MarginSlotPosition[] {
    const ordered = slots
        .map((slot, index) => ({ slot, index }))
        .sort((a, b) =>
            a.slot.anchorTop === b.slot.anchorTop
                ? a.index - b.index
                : a.slot.anchorTop - b.slot.anchorTop
        )
        .map(({ slot }) => slot)

    const tops: number[] = []
    let cursor = bounds.top
    for (const slot of ordered) {
        const top = Math.max(slot.anchorTop, cursor)
        tops.push(top)
        cursor = top + slot.height + gap
    }

    // Pull-up: walk backwards, keeping each group above the next one, and
    // never above the column's top edge.
    for (let index = ordered.length - 1; index >= 0; index -= 1) {
        const slot = ordered[index]
        const top = tops[index]
        if (slot === undefined || top === undefined) {
            continue
        }
        const nextTop = index + 1 < ordered.length ? tops[index + 1] : bounds.bottom + gap
        const limit = (nextTop ?? bounds.bottom + gap) - gap - slot.height
        const pulled = Math.min(top, limit)
        tops[index] = Math.max(bounds.top, pulled)
    }

    return ordered.map((slot, index) => ({
        key: slot.key,
        top: tops[index] ?? slot.anchorTop,
        height: slot.height
    }))
}
