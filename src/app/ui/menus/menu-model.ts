/**
 * Pure decision logic for the AI Editor context menus (design doc
 * "Interaction surfaces" §1/§2): given the observable state of the
 * right-clicked surface, which items appear? The Obsidian `Menu` wiring
 * (`editor-menu.ts`, `file-menu.ts`) stays thin — it only builds the state,
 * asks these functions, and adds exactly the returned items. No disabled
 * placeholders: an item that cannot dispatch is simply not offered (design
 * rule: no non-functional UI).
 *
 * v1 scope: only review-class items. Bound action verbs (rephrase, summarize,
 * …) have no dispatch path until the M3 transform operations land, so they do
 * not appear here yet. Batch review on `files-menu` is deferred post-M4 —
 * there is deliberately no model for it.
 */

/** `MenuItem.setSection` value grouping every AI Editor item together. */
export const AI_EDITOR_MENU_SECTION = 'ai-editor'

// ---------------------------------------------------------------------------
// Editor context menu (right-click in the editor) — design §1
// ---------------------------------------------------------------------------

export interface EditorMenuState {
    /** The view hosts an editable markdown editor (not reading view). */
    readonly editable: boolean
    /** A non-empty text selection exists at menu-open time. */
    readonly hasSelection: boolean
    /** The note passes the shared reviewability predicate (`isReviewable`). */
    readonly reviewable: boolean
}

export type EditorMenuItemId = 'review-selection'

/**
 * Items for the editor context menu. "Review selection" appears only when
 * there is something selected in an editable view AND a review could actually
 * start (not excluded + ≥1 dispatchable review-capable editor).
 */
export function editorMenuItems(state: EditorMenuState): readonly EditorMenuItemId[] {
    if (!state.editable || !state.hasSelection || !state.reviewable) {
        return []
    }
    return ['review-selection']
}

// ---------------------------------------------------------------------------
// File context menu (file explorer, tab header, link) — design §2
// ---------------------------------------------------------------------------

export interface FileMenuState {
    /** The target is a single markdown file (`TFile` with `.md` extension). */
    readonly markdownFile: boolean
    /** The file passes the shared reviewability predicate (`isReviewable`). */
    readonly reviewable: boolean
}

export type FileMenuItemId = 'review-note' | 'open-review-panel'

/**
 * Items for the single-file context menu. Both items are gated on the target
 * being a reviewable markdown note: folders and non-markdown files get
 * nothing, and without a dispatchable editor "Review note" would be a dead
 * item while "Open review panel" alone would open an empty panel.
 */
export function fileMenuItems(state: FileMenuState): readonly FileMenuItemId[] {
    if (!state.markdownFile || !state.reviewable) {
        return []
    }
    return ['review-note', 'open-review-panel']
}
