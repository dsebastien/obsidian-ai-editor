import type { ReviewGate } from '../services/reviewability'

/**
 * Pure state → view-model computation for the side panel's Review button
 * (GitHub issue #16).
 *
 * The button doubles as the panel's run-state indicator: it dispatches the
 * shared whole-note review for the panel's bound note, and while a run (or a
 * per-editor retry) is in flight it REFUSES rather than dispatching. That is
 * the one behavioral difference from the rail's button, and it is deliberate:
 * the rail's button turns into Cancel because the rail sits in the editor
 * where the user's attention is on the text; `RunController.startRun`
 * cancel-replaces an existing run for the same file, so a panel button that
 * dispatched while busy would silently destroy findings the panel is
 * displaying at that very moment. Refusing is the only outcome that cannot
 * lose work. Cancelling stays available through the rail and the
 * `Cancel review or action` command.
 *
 * Kept DOM-free so every state (no note, excluded, kill-switched, no editor,
 * busy) is spec-pinnable without a workspace.
 *
 * DECISION — a kill-switched note gets a DISABLED button with the reason, not
 * a hidden one. Plan §4b says a matching `disabled` rule removes the plugin's
 * chrome from a note (rail, menu items, commands, card, panel binding), and
 * the panel binding is indeed gone. But the panel leaf itself is something the
 * user opened on purpose, and the rule has just emptied it: a disabled button
 * naming the rule is the difference between an explained panel and a
 * mysteriously blank one. The kill switch's promise is that nothing dispatches
 * — a disabled button dispatches nothing — not that the plugin must refuse to
 * explain itself in a surface the user is looking at.
 */

export interface PanelReviewButtonInput {
    /**
     * File name of the panel's bound note (the active markdown note, or the
     * last active one while focus is in the panel), or null when the panel is
     * bound to nothing. Names, not paths: the button sits under the panel's
     * own file line and a full path would wrap the header.
     */
    readonly noteName: string | null
    /**
     * The shared reviewability answer for the bound note (`reviewGate`), or
     * null when there is no bound note to evaluate.
     */
    readonly gate: ReviewGate | null
    /** A review run or retry is in flight for the bound note. */
    readonly busy: boolean
}

export interface PanelReviewButtonViewModel {
    /** Visible label. */
    readonly text: string
    /** Accessible name — always carries the bound note (issue #16). */
    readonly ariaLabel: string
    /** Hover tooltip: the accessible name, plus the reason when refused. */
    readonly tooltip: string
    readonly disabled: boolean
    /** Render the busy affordance (spinner; reduced-motion aware in CSS). */
    readonly busy: boolean
}

/**
 * Derives the button's label, state and tooltip from the bound note.
 *
 * `busy` wins over every gate refusal: a run in flight is a fact about right
 * now, while a refusal is a fact about the configuration — and a rule added
 * mid-run must not make the panel claim nothing is happening (the run stays
 * bound and keeps remapping anchors, plan §4b).
 */
export function panelReviewButtonState(input: PanelReviewButtonInput): PanelReviewButtonViewModel {
    const { noteName, gate } = input
    if (noteName === null || gate === null) {
        return {
            text: 'Review',
            ariaLabel: 'Review this note',
            tooltip: 'Open a note to review it',
            disabled: true,
            busy: false
        }
    }
    if (input.busy) {
        return {
            text: 'Reviewing…',
            ariaLabel: `Reviewing ${noteName}`,
            tooltip: `A review is already running for ${noteName} — cancel it to start over`,
            disabled: true,
            busy: true
        }
    }
    switch (gate.status) {
        case 'ok':
            return {
                text: 'Review',
                ariaLabel: `Review ${noteName}`,
                tooltip: `Review ${noteName} with the enabled editors`,
                disabled: false,
                busy: false
            }
        case 'excluded':
            return {
                text: 'Review',
                ariaLabel: `Review ${noteName}`,
                // Names the tab that holds the fix, like every other
                // exclusion message in the plugin.
                tooltip: `${noteName} is excluded from AI review by your privacy settings (Behavior tab)`,
                disabled: true,
                busy: false
            }
        case 'rule-disabled':
            return {
                text: 'Review',
                ariaLabel: `Review ${noteName}`,
                tooltip: `AI Editor is turned off for ${noteName} by the rule ${gate.ruleLabel} (Rules tab)`,
                disabled: true,
                busy: false
            }
        case 'rule-target-unusable':
            // Distinct from `no-editor` on purpose: the vault may be full of
            // working editors — this note is confined to a pool that cannot
            // run, so the fix starts in the Rules tab, not the Editors tab.
            return {
                text: 'Review',
                ariaLabel: `Review ${noteName}`,
                tooltip: `The rule ${gate.ruleLabel} (Rules tab) assigns ${noteName} to editors that cannot review — check that rule's editor or panel`,
                disabled: true,
                busy: false
            }
        case 'no-editor':
            return {
                text: 'Review',
                ariaLabel: `Review ${noteName}`,
                tooltip:
                    'No editor can review right now — enable an editor and a backend in the settings',
                disabled: true,
                busy: false
            }
    }
}

/**
 * What the panel body says when there is no run to show.
 *
 * Derived from the GATE, not from "is a note bound": on a note the plugin
 * refuses — excluded, kill-switched, or confined by a rule to a pool that
 * cannot run — the body used to read "No review yet. Select Review to start
 * one." next to a disabled button whose tooltip said the opposite. It invited
 * an action the surface had just refused, and it claimed there was no review
 * when a hidden bound run may still exist (a kill switch hides the binding, it
 * does not end the run).
 *
 * The refusal wording is the button's own tooltip rather than a second copy of
 * it, so the two halves of the panel cannot drift apart.
 */
export function panelEmptyStateText(input: PanelReviewButtonInput): string {
    const { noteName, gate } = input
    if (noteName === null || gate === null) {
        return 'No review yet. Open a note, then select Review.'
    }
    if (input.busy) {
        return 'Reviewing… findings appear here as they arrive.'
    }
    return gate.status === 'ok'
        ? 'No review yet. Select Review to start one.'
        : panelReviewButtonState(input).tooltip
}
