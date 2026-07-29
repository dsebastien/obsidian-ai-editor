import { MarkdownView } from 'obsidian'
import type { Plugin } from 'obsidian'
import type { ReviewController } from '../ui/review-controller'

/**
 * Review commands. Both are pure user intents delegated to the
 * `ReviewController` (Business Rules #1 — nothing runs without an explicit
 * user action):
 *
 * - `Review current note` — available only for an active markdown view whose
 *   note is not privacy-excluded (exclusions gate availability, and the
 *   review service re-checks them fail-closed).
 * - `Open review panel` — reveals the side-panel leaf.
 */
export function registerReviewCommands(plugin: Plugin, controller: ReviewController): void {
    plugin.addCommand({
        id: 'review-current-note',
        name: 'Review current note',
        checkCallback: (checking: boolean): boolean => {
            const view = plugin.app.workspace.getActiveViewOfType(MarkdownView)
            if (!view || !controller.canReview(view)) {
                return false
            }
            if (checking) {
                return true
            }
            void controller.startReview(view)
            return true
        }
    })

    plugin.addCommand({
        id: 'open-review-panel',
        name: 'Open review panel',
        callback: (): void => {
            void controller.activateSidePanel()
        }
    })
}
