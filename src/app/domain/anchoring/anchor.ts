/**
 * Anchor lifecycle: positions that survive user edits.
 *
 * Anchors are created against a snapshot, then mapped through every document
 * change. A change that INTERSECTS the anchored range makes the anchor
 * stale — the underlying text no longer matches what the backend saw, so any
 * attached suggestion must not be applied (Business Rules #3). Changes
 * before/after the range only shift it.
 *
 * `TextChange` mirrors the essence of a CM6 change span; the ui layer adapts
 * `ChangeDesc.iterChanges` into this shape so the domain stays CM6-free.
 */

export interface TextChange {
    /** Start offset of the replaced range in the PRE-change document. */
    readonly from: number
    /** End offset of the replaced range in the PRE-change document. */
    readonly to: number
    /** Length of the inserted text. */
    readonly insertedLength: number
}

export type AnchorState = 'anchored' | 'stale'

export interface Anchor {
    readonly from: number
    readonly to: number
    readonly state: AnchorState
}

export function createAnchor(from: number, to: number): Anchor {
    return { from, to, state: 'anchored' }
}

/**
 * Maps an anchor through a single document change.
 *
 * Rules:
 * - Change entirely after the anchor: no effect.
 * - Change entirely before the anchor: shift by the length delta.
 * - Change touching/overlapping the anchor range: mark stale (position is
 *   kept best-effort for display, but the anchor is no longer actionable).
 *   Insertions exactly AT the boundaries (empty-range changes at `from` or
 *   `to`) do not invalidate the anchored text itself: an insertion at `from`
 *   shifts, an insertion at `to` leaves the range untouched.
 */
export function mapAnchorThroughChange(anchor: Anchor, change: TextChange): Anchor {
    const delta = change.insertedLength - (change.to - change.from)
    const isPureInsertion = change.from === change.to

    // Entirely after the anchor (insertion exactly at `to` counts as after).
    if (change.from > anchor.to || (isPureInsertion && change.from === anchor.to)) {
        return anchor
    }

    // Entirely before the anchor (insertion exactly at `from` counts as before).
    if (change.to < anchor.from || (isPureInsertion && change.from === anchor.from)) {
        return {
            from: anchor.from + delta,
            to: anchor.to + delta,
            state: anchor.state
        }
    }

    // Overlap: the anchored text was modified.
    const from = Math.min(anchor.from, change.from)
    const to = Math.max(change.from + change.insertedLength, anchor.to + delta)
    return { from, to: Math.max(from, to), state: 'stale' }
}

/**
 * Maps an anchor through an ordered list of changes (all expressed against
 * the same pre-change document, non-overlapping, sorted ascending — the
 * shape CM6's `iterChanges` yields). Positions are adjusted incrementally.
 */
export function mapAnchorThroughChanges(anchor: Anchor, changes: readonly TextChange[]): Anchor {
    let current = anchor
    let shift = 0
    for (const change of changes) {
        const adjusted: TextChange = {
            from: change.from + shift,
            to: change.to + shift,
            insertedLength: change.insertedLength
        }
        current = mapAnchorThroughChange(current, adjusted)
        shift += change.insertedLength - (change.to - change.from)
    }
    return current
}

/**
 * Verifies that the current document still contains the expected text at the
 * anchor — the precondition for applying any suggestion.
 */
export function verifyPrecondition(currentText: string, anchor: Anchor, expected: string): boolean {
    if (anchor.state !== 'anchored') {
        return false
    }
    if (anchor.from < 0 || anchor.to > currentText.length) {
        return false
    }
    return currentText.slice(anchor.from, anchor.to) === expected
}
