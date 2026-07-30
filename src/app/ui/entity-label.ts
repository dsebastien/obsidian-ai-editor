/**
 * The one vocabulary for telling editors and panels apart (Business Rules
 * #11: "Editors vs Panels are visually distinguishable in every surface —
 * rail, menus, cards, side panel").
 *
 * Two decisions are baked in here so no surface can drift from them:
 *
 * 1. **The distinction is never carried by shape or colour alone.** A ring is
 *    invisible to a screen reader and to anyone who cannot resolve a 12px
 *    glyph, so wherever a panel is named, the name itself says `(panel)`.
 *    The glyphs are an addition, never the whole signal.
 * 2. **Only panels are marked.** An editor is the unmarked default — it is
 *    what every other surface of the plugin is already about — so tagging
 *    both kinds would make the marker noise and stop it standing out. That
 *    asymmetry is deliberate and is why `entityName` takes the kind rather
 *    than the caller picking a helper per kind.
 */

/** The two entity kinds a user can bind, convene or see reported. */
export type EntityKind = 'editor' | 'panel'

/**
 * Text glyphs — solid disc for an editor, ring for a panel — mirroring the
 * rail's solid dots vs ringed panel chip. Text on purpose: they must survive
 * in places that can only hold a string (an `<option>` label, a command name,
 * a tooltip), where no DOM decoration is possible.
 */
export const ENTITY_GLYPHS: Readonly<Record<EntityKind, string>> = {
    editor: '●',
    panel: '◎'
}

/** The word that carries the distinction into the accessible name. */
export const PANEL_MARKER = '(panel)'

/**
 * How an entity is NAMED wherever both kinds can appear: a panel's name
 * carries the marker, an editor's does not (see decision 2 above). This is
 * the string that belongs in an accessible name, a Notice or a command title.
 */
export function entityName(kind: EntityKind, name: string): string {
    return kind === 'panel' ? `${name} ${PANEL_MARKER}` : name
}

/**
 * Dropdown/list option text: the glyph, then the marked name. The glyph gives
 * the scannable distinction in a long list; the marker keeps it true for
 * assistive tech, which reads the option text verbatim.
 */
export function entityOptionText(kind: EntityKind, name: string): string {
    return `${ENTITY_GLYPHS[kind]} ${entityName(kind, name)}`
}

/**
 * Label of an action that convenes a panel (context menu item, palette
 * command). The panel is NAMED rather than merely flagged: a panel-bound verb
 * dispatches one request per member, so the user picking it from a menu is
 * choosing a cost, and "which panel" is what tells them how big it is.
 *
 * `panelName` null (an editor-bound action) returns the label untouched —
 * naming a single editor in the menu item would restate what the action
 * already says.
 */
export function actionDisplayLabel(label: string, panelName: string | null): string {
    return panelName === null ? label : `${label} (panel: ${panelName})`
}
