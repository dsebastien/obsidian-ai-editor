import type { RuleOutcome } from '../domain/rules/rule-engine'
import type { EditorConfig, PluginSettingsV1 } from '../domain/settings/settings-schema'
import { isExcluded } from './context/exclusions'
import { noteRuleOutcome } from './rules/note-rules'
import type { NoteFactsSource } from './rules/note-rules'
import { resolveApiBackend, resolveReviewParticipants } from './review-service'

/**
 * Shared reviewability predicate for every interaction surface (command
 * gates, context menus, the rail, the CLI, the daemon). One answer to one
 * question: "can a review start on THIS note right now?" — the note is not
 * privacy-excluded (Business Rules #7), no binding rule switches the plugin
 * off for it (plan §4b), AND at least one editor of the pool that would
 * actually run on this note can dispatch.
 *
 * That last clause is note-scoped on purpose. The gate used to ask a GLOBAL
 * question (`hasReviewCapableEditor`) while `startReview` asked a note-scoped
 * one, so a note whose `assign` rule named an editor that could not run — a
 * deleted one, a disabled one, one without the review capability, one whose
 * backend does not resolve — passed the gate on every surface and then refused
 * on click, every time. Both now derive the pool through the same
 * `resolveReviewParticipants`, so the disagreement is not a bug that was fixed
 * but a state that cannot be expressed.
 *
 * No rule is duplicated here: `isExcluded` comes from `context/exclusions`,
 * the kill switch from `rules/note-rules`, and participant resolution from
 * `review-service` — so a surface gated by `isReviewable` can never disagree
 * with what `startReview` would refuse.
 *
 * `reviewGate` is the ONE evaluation; `isReviewable` and
 * `isPluginEnabledForNote` are projections of its answer. Surfaces that only
 * need a yes/no keep asking those; surfaces that must SAY WHY (the side
 * panel's Review button) read the gate itself, so an explanation can never
 * drift from the decision it explains.
 */

export { isExcluded } from './context/exclusions'
export { isPluginDisabledByRule } from './rules/note-rules'

/**
 * Every editor that could participate in a review run right now: enabled,
 * review capability on, and its backend resolves to an enabled API backend
 * with a model (mirrors the participant selection in `startReview`). In
 * settings order — surfaces that offer an editor choice (the "Ask an
 * editor" modal) list exactly these, so the user can never pick an editor
 * `startReview` would refuse.
 */
export function reviewCapableEditors(settings: PluginSettingsV1): EditorConfig[] {
    return settings.editors.filter(
        (editor) =>
            editor.enabled && editor.capabilities.review && resolveApiBackend(settings, editor).ok
    )
}

/**
 * Whether at least one editor could participate in a review run. Surfaces
 * gated on this never offer non-functional UI (design rule: no placeholder
 * commands or menu items).
 */
export function hasReviewCapableEditor(settings: PluginSettingsV1): boolean {
    return reviewCapableEditors(settings).length > 0
}

/**
 * Why a review cannot start on a note — or `ok` when it can. The order below
 * IS the reporting priority, and it mirrors the order `startReview` refuses
 * in: privacy first (Business Rules #7 — the strongest statement the plugin
 * can make about a note), then the kill switch (plan §4b), then whether any
 * editor could carry the request.
 *
 * `rule-disabled` and `rule-target-unusable` carry the rule label so a surface
 * can name the rule the user has to find in the Rules tab. None of these are
 * collapsed together, because their fixes live in different settings tabs:
 * Behavior for the exclusion, Rules for the kill switch, Rules AND Editors for
 * a rule whose assigned pool cannot run, Editors/Backends for the global case.
 */
export type ReviewGate =
    | { readonly status: 'ok' }
    | { readonly status: 'excluded' }
    | { readonly status: 'rule-disabled'; readonly ruleLabel: string }
    /**
     * An `assign` rule matched, and nothing in the pool it names can review:
     * the target was deleted, or every editor in it is disabled, lacks the
     * review capability, or has no usable backend. Distinct from `no-editor`
     * because the vault may be full of perfectly working editors — this note
     * just is not allowed to use them.
     */
    | { readonly status: 'rule-target-unusable'; readonly ruleLabel: string }
    | { readonly status: 'no-editor' }

/**
 * The single reviewability evaluation for a note.
 *
 * `source` is the `VaultReader`: metadata and note-type facts are read through
 * it, so a note that is not open in any view fails closed exactly like
 * `startReview` would.
 */
export function reviewGate(
    path: string,
    source: NoteFactsSource,
    settings: PluginSettingsV1
): ReviewGate {
    const note = noteGate(path, source, settings)
    if (note.refusal !== null) {
        return note.refusal
    }
    // The pool this NOTE would dispatch — not the vault's editor list. The
    // rule outcome is reused rather than recomputed: resolving it twice would
    // pay for the metadata facts twice on a path that runs on every refresh.
    const { participants } = resolveReviewParticipants(settings, note.outcome)
    if (participants.length > 0) {
        return { status: 'ok' }
    }
    return note.outcome.kind === 'assigned'
        ? { status: 'rule-target-unusable', ruleLabel: note.outcome.ruleLabel }
        : { status: 'no-editor' }
}

/**
 * The note-level half of the gate: the two refusals that are about the NOTE
 * (privacy, kill switch), or the rule outcome the participant pool needs. Split
 * out so `isPluginEnabledForNote` never pays for the editor/backend scan it
 * does not care about — it runs on every rail refresh of every open pane.
 */
type NoteGate =
    | { readonly refusal: ReviewGate }
    | { readonly refusal: null; readonly outcome: RuleOutcome }

function noteGate(path: string, source: NoteFactsSource, settings: PluginSettingsV1): NoteGate {
    if (isExcluded(path, source.getNoteMetadata(path), settings.behavior)) {
        return { refusal: { status: 'excluded' } }
    }
    const outcome = noteRuleOutcome(path, source, settings)
    if (outcome.kind === 'disabled') {
        return { refusal: { status: 'rule-disabled', ruleLabel: outcome.ruleLabel } }
    }
    return { refusal: null, outcome }
}

/**
 * Whether the plugin operates on this note at all: not privacy-excluded and
 * not switched off by a binding rule. The gate for surfaces that are not
 * review-specific — the bound actions (a vault whose editors are all
 * rewrite-only is not "reviewable" yet its transforms dispatch) and the rail.
 * `no-editor` therefore does NOT make a note plugin-disabled.
 */
export function isPluginEnabledForNote(
    path: string,
    source: NoteFactsSource,
    settings: PluginSettingsV1
): boolean {
    return noteGate(path, source, settings).refusal === null
}

/**
 * Whether `path` is a valid review target: the plugin operates on it
 * (`isPluginEnabledForNote`) and at least one review-capable editor is
 * configured.
 */
export function isReviewable(
    path: string,
    source: NoteFactsSource,
    settings: PluginSettingsV1
): boolean {
    return reviewGate(path, source, settings).status === 'ok'
}
