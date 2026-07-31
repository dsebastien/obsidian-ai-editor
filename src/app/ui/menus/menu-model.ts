import type { VerbClass } from '../../domain/actions/verb-registry'
import { actionDisplayLabel } from '../entity-label'

/**
 * Pure decision logic for the AI Editor context menus (design doc
 * "Interaction surfaces" §1/§2): given the observable state of the
 * right-clicked surface, which items appear, in which order? The Obsidian
 * `Menu` wiring (`editor-menu.ts`, `file-menu.ts`) stays thin — it only
 * builds the state, asks these functions, and adds exactly the returned
 * items. No disabled placeholders: an item that cannot dispatch is simply
 * not offered (design rule: no non-functional UI).
 *
 * Batch review on `files-menu` is deferred post-M4 — there is deliberately
 * no model for it.
 */

/** `MenuItem.setSection` value grouping every AI Editor item together. */
export const PLUGIN_MENU_SECTION = 'editor-ai-daemons'

// ---------------------------------------------------------------------------
// Editor context menu (right-click in the editor) — design §1
// ---------------------------------------------------------------------------

/** The slice of a resolved bound action the menu model needs. */
export interface BoundActionView {
    readonly bindingId: string
    /** Sentence-case verb label (`Critique`), without the target. */
    readonly label: string
    readonly verbClass: VerbClass
    /** The panel this action convenes, or null for an editor binding. */
    readonly panelName: string | null
}

/**
 * What the menu item / palette entry actually says. A panel-bound verb names
 * its panel (Business Rules #11, and one click there is one request per
 * member); an editor-bound one stays the bare verb.
 *
 * Ordering deliberately still uses the bare `label`: the marker is about which
 * kind the action convenes, and letting it move `Critique` under `C (panel…)`
 * would shuffle a menu the user navigates by verb.
 */
export function actionMenuTitle(action: BoundActionView): string {
    return actionDisplayLabel(action.label, action.panelName)
}

export interface EditorMenuState {
    /** The view hosts an editable markdown editor (not reading view). */
    readonly editable: boolean
    /** A non-empty text selection exists at menu-open time. */
    readonly hasSelection: boolean
    /** The note passes the shared reviewability predicate (`isReviewable`). */
    readonly reviewable: boolean
    /**
     * The user may be OFFERED an ask on this note: the plugin operates on it
     * and the vault has a review-capable editor (`canAskEditor`).
     *
     * Separate from `reviewable` because the two asks do not dispatch the
     * note's default pool: "Ask an editor" names its editor
     * (`instructionEditorIds`, which outranks an `assign` rule) and a comment
     * names its own. Gating them on `reviewable` hid both items on every note
     * an `assign` rule matched whose target could not run — with no
     * explanation, while any healthy editor would have answered.
     */
    readonly askable: boolean
    /**
     * The plugin does not operate on this note: privacy-excluded (Business
     * Rules #7) or switched off by a binding rule (plan §4b). Both produce the
     * same menu outcome — nothing offered — so one flag covers them; the
     * dispatch services keep the two apart where the difference is actionable.
     *
     * Gates the bound actions independently of `reviewable`: a vault whose
     * editors are all rewrite-only is not "reviewable", yet its transform
     * actions dispatch.
     */
    readonly blocked: boolean
    /** Dispatchable bound actions (`resolveActions`), settings order. */
    readonly actions: readonly BoundActionView[]
    /**
     * Durable margin comments are available: the plugin has a comment store
     * (plan §5.5 / M8). Without one the item would open a dialog whose
     * submission had nowhere to go.
     */
    readonly comments: boolean
}

export type EditorMenuEntry =
    | { readonly kind: 'action'; readonly action: BoundActionView }
    | { readonly kind: 'review-selection' }
    | { readonly kind: 'ask-editor' }
    | { readonly kind: 'comment-selection' }

/** At most this many bound actions appear; beyond it the palette is the surface. */
export const ACTION_MENU_CAP = 10

/** Menu icon per verb class (design §1). */
export function actionMenuIcon(verbClass: VerbClass): string {
    switch (verbClass) {
        case 'transform':
            return 'check'
        case 'generate':
            return 'wand-2'
        case 'review':
            return 'message-circle'
    }
}

/**
 * Entries for the editor context menu, in presentation order (design §1):
 * bound actions first — alphabetical by label, capped at `ACTION_MENU_CAP` —
 * then "Review selection", "Ask an editor…" and "Ask for comments…".
 * Everything requires a non-empty selection in an editable view on a note the
 * plugin operates on. Beyond that the three tail items split on WHICH pool
 * they dispatch: "Review selection" needs the note to be `reviewable` (it runs
 * the note's default pool, rule included), while the two asks need only
 * `askable` (they name their own editor, which outranks the rule). The bound
 * actions need neither — each action's own dispatchability was already
 * resolved upstream, so undispatchable actions never reach `state.actions`.
 *
 * "Ask for comments…" comes last on purpose: it is the only item that does
 * NOT produce something to watch. It parks a background job whose answer
 * lands in the margin later, so it belongs after the two synchronous asks
 * rather than competing with them.
 */
export function editorMenuEntries(state: EditorMenuState): readonly EditorMenuEntry[] {
    if (!state.editable || !state.hasSelection) {
        return []
    }
    // Whole-plugin refusal: not one item, review or action (`reviewable` is
    // necessarily false too, but the contract is stated here rather than
    // inferred from a caller building consistent state).
    if (state.blocked) {
        return []
    }
    const entries: EditorMenuEntry[] = []
    const sorted = [...state.actions].sort((a, b) => a.label.localeCompare(b.label))
    for (const action of sorted.slice(0, ACTION_MENU_CAP)) {
        entries.push({ kind: 'action', action })
    }
    if (state.reviewable) {
        entries.push({ kind: 'review-selection' })
    }
    if (state.askable) {
        entries.push({ kind: 'ask-editor' })
        if (state.comments) {
            entries.push({ kind: 'comment-selection' })
        }
    }
    return entries
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
