/**
 * Pure availability predicates for the static palette commands (design doc
 * "Interaction surfaces" §3). The command glue builds the state from live
 * Obsidian objects and asks these functions; a command whose gate is false
 * is hidden from the palette (`checkCallback` contract), never shown dead.
 */

export interface ReviewSelectionGateState {
    /** The view hosts an editable markdown editor (not reading view). */
    readonly editable: boolean
    /** A non-empty text selection exists at check time. */
    readonly hasSelection: boolean
    /** The note passes the shared reviewability predicate (`isReviewable`). */
    readonly reviewable: boolean
}

/**
 * `Review selection` gate: same condition as the editor context menu item —
 * an actual selection in an editable view, and a review that could start.
 */
export function canReviewSelection(state: ReviewSelectionGateState): boolean {
    return state.editable && state.hasSelection && state.reviewable
}

export interface CancelRunGateState {
    /** A run exists for the active file. */
    readonly hasRun: boolean
    /** Every editor stream of that run reached a terminal state. */
    readonly settled: boolean
}

/** `Cancel review` gate: only an unsettled run can be cancelled. */
export function canCancelRun(state: CancelRunGateState): boolean {
    return state.hasRun && !state.settled
}
