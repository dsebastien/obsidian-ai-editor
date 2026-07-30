/**
 * Who a finding highlight belongs to, said in two ways that do not depend on
 * being able to resolve a hue (plan M9: "a persona is identified by colour
 * today — colourblind users need a non-colour indicator too").
 *
 * A highlight in the document carries exactly one persona's tint. With three
 * editors reviewing one note that tint is the ONLY thing telling three
 * overlapping opinions apart, and it is invisible to a red/green deficiency,
 * to a monochrome display and to a screen reader. Two additions here, on
 * purpose independent of each other:
 *
 * 1. {@link findingMarkTitle} — the sentence the mark carries as its `title`.
 *    Naming the editor, the panel it was a member of, the severity and
 *    whether the finding has gone stale.
 * 2. {@link findingEdgeIndex} — a per-editor **underline style** index. Shape,
 *    not colour: solid / dotted / dashed / double at the bottom edge, derived
 *    from the editor's position in the settings list so it is stable for the
 *    life of the vault and matches the order of the rail's chips.
 *
 * ## Why `title` and not `aria-label`
 *
 * A CodeMirror mark decoration renders as a `<span>` inside the editor's
 * contenteditable, i.e. `role=generic` — which ARIA forbids naming (the same
 * rule that moved the margin card's composed sentence onto a `role=group`).
 * Rendering the mark as `<mark>` would earn a nameable role, and was
 * rejected: Obsidian styles `.markdown-rendered mark` at a higher specificity
 * than a single class of ours, so every finding would inherit the theme's
 * `==highlight==` look inside Live Preview and the plugin would fight it with
 * doubled selectors forever.
 *
 * `title` is therefore the mark's own disclosure — a tooltip for every
 * sighted user, exposed as the accessible description by the browsers
 * Obsidian ships on. The AUTHORITATIVE named surfaces for a finding are
 * elsewhere and already correct: the side-panel row (named section per
 * editor), the review card (`role=dialog`, named) and the rail chip. A
 * highlight is a pointer into those, never the only way to read a finding.
 */

import type { Severity } from '../../domain/operations/contract'
import { entityName } from '../entity-label'

/** How many distinct bottom-edge styles the stylesheet provides. */
export const FINDING_EDGE_STYLE_COUNT = 4

/** Human wording for a severity, for the places that show it as prose. */
export const SEVERITY_WORDS: Readonly<Record<Severity, string>> = {
    info: 'info',
    suggestion: 'suggestion',
    warning: 'warning'
}

/** Everything the mark's disclosure sentence is built from. */
export interface FindingMarkIdentity {
    readonly editorName: string
    /** The panel this editor reviewed as a member of, when there was one. */
    readonly panelName: string | null
    readonly severity: Severity
    /** The text under the mark changed since the finding was made. */
    readonly stale: boolean
}

/**
 * The sentence a finding highlight carries. Leads with the editor because
 * that is what the colour was standing in for; the panel follows, marked the
 * way every other surface marks one (`entityName`), so a highlight from a
 * four-member panel never reads like one from a lone editor.
 */
export function findingMarkTitle(identity: FindingMarkIdentity): string {
    const parts = [`${identity.editorName} — ${SEVERITY_WORDS[identity.severity]}`]
    if (identity.panelName !== null && identity.panelName.length > 0) {
        parts.push(`member of ${entityName('panel', identity.panelName)}`)
    }
    if (identity.stale) {
        // The dimmed, dashed look says "no longer actionable" to someone who
        // can see it. The words have to say it too.
        parts.push('stale — the text changed since this was written')
    }
    return parts.join(' · ')
}

/**
 * The bottom-edge style slot for an editor, from its index in the settings
 * list. Wraps past the number of styles the stylesheet defines: with more
 * editors than styles two personas can share one, which still beats every
 * persona sharing one. A negative index (editor not in settings — deleted
 * mid-run, its findings still on the note) falls back to slot 0.
 */
export function findingEdgeIndex(editorIndex: number): number {
    if (!Number.isFinite(editorIndex) || editorIndex < 0) {
        return 0
    }
    return Math.floor(editorIndex) % FINDING_EDGE_STYLE_COUNT
}
