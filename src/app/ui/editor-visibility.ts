/**
 * Disabled-editor visibility lens (hide, never purge).
 *
 * Turning an editor OFF in the settings must make the persona vanish from
 * every review surface at once — side-panel section, findings list, text
 * decorations, rail chip — and stop the daemon re-dispatching it. It must
 * NOT delete anything: the findings stay in the run's store untouched, so
 * re-enabling the editor brings them straight back without a paid re-review.
 * (A DELETED editor is the opposite case and keeps its findings visible —
 * the run still knows what it was called; only a present-but-disabled
 * editor is hidden, because the toggle is the user's word that this persona
 * stays quiet until re-enabled.)
 *
 * Pure and structural so every surface filters through the SAME rules and
 * the rules are spec-pinned here (`editor-visibility.spec.ts`); the
 * controller and the side panel only apply them.
 */

/** The one field of an editor config this lens reads. */
export interface EditorEnablement {
    readonly id: string
    readonly enabled: boolean
}

/** Anything attributed to an editor (run states, tracked findings). */
export interface EditorAttributed {
    readonly editorId: string
}

/**
 * Ids of editors that exist in the settings AND are switched off. Unknown
 * ids (deleted editors) are deliberately absent: their findings stay
 * visible.
 */
export function disabledEditorIds(editors: readonly EditorEnablement[]): ReadonlySet<string> {
    const disabled = new Set<string>()
    for (const editor of editors) {
        if (!editor.enabled) {
            disabled.add(editor.id)
        }
    }
    return disabled
}

/** Drops every item attributed to a disabled editor. A view lens — the
 * source collection is never mutated. */
export function withoutDisabledEditors<T extends EditorAttributed>(
    items: readonly T[],
    disabled: ReadonlySet<string>
): readonly T[] {
    if (disabled.size === 0) {
        return items
    }
    return items.filter((item) => !disabled.has(item.editorId))
}

/** What the side panel renders per editor: the sections that stay, and how
 * many were skipped as acknowledged (the restorable footer count). */
export interface PanelSectionPlan<T extends EditorAttributed> {
    readonly sections: readonly T[]
    readonly acknowledgedCount: number
}

/**
 * Splits a run's editor states into rendered sections and the acknowledged
 * count. Order of precedence, spec-pinned:
 * - a DISABLED editor's section disappears entirely and is NOT counted as
 *   acknowledged — the footer's "N acknowledged" must never invite the user
 *   to restore a section the settings toggle is hiding;
 * - an acknowledged (and enabled) editor's section is skipped and counted
 *   (issue #24's restorable footer).
 */
export function panelSectionPlan<T extends EditorAttributed>(
    states: readonly T[],
    acknowledged: ReadonlySet<string>,
    disabled: ReadonlySet<string>
): PanelSectionPlan<T> {
    const sections: T[] = []
    let acknowledgedCount = 0
    for (const state of states) {
        if (disabled.has(state.editorId)) {
            continue
        }
        if (acknowledged.has(state.editorId)) {
            acknowledgedCount += 1
            continue
        }
        sections.push(state)
    }
    return { sections, acknowledgedCount }
}
