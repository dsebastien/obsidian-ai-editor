import type { EditorConfig, PluginSettingsV1 } from '../domain/settings/settings-schema'
import { isExcluded } from './context/exclusions'
import { noteRuleOutcome } from './rules/note-rules'
import type { NoteFactsSource } from './rules/note-rules'
import { resolveApiBackend } from './review-service'

/**
 * Shared reviewability predicate for every interaction surface (command
 * gates, context menus, the rail, the CLI, the daemon). One answer to one
 * question: "can a review start on this note right now?" — the note is not
 * privacy-excluded (Business Rules #7), no binding rule switches the plugin
 * off for it (plan §4b), AND at least one enabled review-capable editor can
 * actually dispatch (its backend resolves).
 *
 * No rule is duplicated here: `isExcluded` comes from `context/exclusions`,
 * the kill switch from `rules/note-rules`, and editor/backend resolution from
 * `resolveApiBackend` — so a surface gated by `isReviewable` can never
 * disagree with what `startReview` would refuse.
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
 * `rule-disabled` carries the rule label so a surface can name the rule the
 * user has to find in the Rules tab; the two refusals are deliberately NOT
 * collapsed, because their fixes live in different settings tabs.
 */
export type ReviewGate =
    | { readonly status: 'ok' }
    | { readonly status: 'excluded' }
    | { readonly status: 'rule-disabled'; readonly ruleLabel: string }
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
    if (note !== null) {
        return note
    }
    return hasReviewCapableEditor(settings) ? { status: 'ok' } : { status: 'no-editor' }
}

/**
 * The note-level half of the gate: the two refusals that are about the NOTE
 * (privacy, kill switch), or `null` when neither applies. Split out so
 * `isPluginEnabledForNote` never pays for the editor/backend scan it does not
 * care about — it runs on every rail refresh of every open pane.
 */
function noteGate(
    path: string,
    source: NoteFactsSource,
    settings: PluginSettingsV1
): ReviewGate | null {
    if (isExcluded(path, source.getNoteMetadata(path), settings.behavior)) {
        return { status: 'excluded' }
    }
    const outcome = noteRuleOutcome(path, source, settings)
    if (outcome.kind === 'disabled') {
        return { status: 'rule-disabled', ruleLabel: outcome.ruleLabel }
    }
    return null
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
    return noteGate(path, source, settings) === null
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
