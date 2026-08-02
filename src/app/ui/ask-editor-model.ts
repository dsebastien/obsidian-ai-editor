/**
 * Pure logic for the freeform "Ask a question" modal (design §6 decision 1,
 * né "Ask an editor" — renamed with issue #27 when panels joined the picker):
 * what the editor picker offers and when the Ask button is enabled. The
 * Obsidian `Modal` wiring (`ask-editor-modal.ts`) stays thin — it builds its
 * DOM around these functions and never re-implements the decisions.
 */

/** One entry of the modal's picker: an editor, or a panel (issue #27). */
export interface AskEditorChoice {
    readonly id: string
    readonly name: string
    /** Absent = editor (the comment picker never offers panels). */
    readonly kind?: 'editor' | 'panel'
    /**
     * Backend requests this choice runs (panels: resolvable members +
     * aggregation). Editors omit it — one request is the baseline and
     * labelling every row "1 request" would be noise.
     */
    readonly requestCount?: number
}

/**
 * A choice's picker label (issue #27): panels are marked as such in every
 * surface (Business Rules #11) and carry their request count — the picker
 * must say that one option costs 5× another before it runs it.
 */
export function askChoiceLabel(choice: AskEditorChoice): string {
    if (choice.kind !== 'panel') {
        return choice.name
    }
    const count = choice.requestCount ?? 0
    const requests = count === 1 ? '1 request' : `${count} requests`
    return `${choice.name} (panel · ${requests})`
}

/**
 * The instruction as it will ride into the run, or `null` when there is
 * nothing to submit (blank / whitespace-only). Single source of truth for
 * BOTH the Ask-button enablement and the submitted value — the button can
 * never enable on text that would then submit as nothing.
 */
export function normalizeInstruction(text: string): string | null {
    const trimmed = text.trim()
    return trimmed.length > 0 ? trimmed : null
}

/** Ask-button enablement: there is a non-blank instruction to submit. */
export function canSubmitAsk(text: string): boolean {
    return normalizeInstruction(text) !== null
}

/**
 * The picker's initial selection: the caller's preferred editor when it is
 * actually on offer, otherwise the first one (settings order, mirroring the
 * participant order of a whole-panel review).
 *
 * The preference is what makes `behavior.defaultCommentEditorId` real (plan
 * §4 "Comment routing"): margin comments open the picker on the configured
 * default and the user reroutes from there. A preferred id that no longer
 * resolves — deleted, disabled, review-incapable, so absent from `choices` —
 * falls back silently rather than selecting nothing: a picker whose initial
 * value is empty makes the dialog's primary button look broken.
 *
 * `null` only for an empty choice list — callers gate on ≥1 review-capable
 * editor, so a `null` means the modal should not have been opened at all.
 */
export function defaultAskEditor(
    choices: readonly AskEditorChoice[],
    preferredId?: string
): AskEditorChoice | null {
    if (preferredId !== undefined && preferredId.length > 0) {
        const preferred = choices.find((choice) => choice.id === preferredId)
        if (preferred) {
            return preferred
        }
    }
    return choices[0] ?? null
}
