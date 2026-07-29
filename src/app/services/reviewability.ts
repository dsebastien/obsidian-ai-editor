import type { EditorConfig, PluginSettingsV1 } from '../domain/settings/settings-schema'
import { isExcluded } from './context/exclusions'
import type { NoteMetadata } from './context/vault-reader.intf'
import { resolveApiBackend } from './review-service'

/**
 * Shared reviewability predicate for every interaction surface (command
 * gates, context menus, CLI handler). One answer to one question: "can a
 * review start on this note right now?" — the note is not privacy-excluded
 * (Business Rules #7) AND at least one enabled review-capable editor can
 * actually dispatch (its backend resolves).
 *
 * The exclusion rules are NOT duplicated here: `isExcluded` is re-exported
 * from `context/exclusions` (the single decision point), and editor/backend
 * resolution reuses `resolveApiBackend` from the review service — so a
 * surface gated by `isReviewable` can never disagree with what `startReview`
 * would refuse.
 */

export { isExcluded } from './context/exclusions'

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
 * Whether `path` is a valid review target: not excluded (folder, tag, or
 * frontmatter opt-out — fail-closed on `null` metadata, see `isExcluded`)
 * and at least one review-capable editor is configured.
 */
export function isReviewable(
    path: string,
    metadata: NoteMetadata | null,
    settings: PluginSettingsV1
): boolean {
    return !isExcluded(path, metadata, settings.behavior) && hasReviewCapableEditor(settings)
}
