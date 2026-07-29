import { MarkdownView } from 'obsidian'
import type { Plugin } from 'obsidian'
import type { ReviewController } from '../ui/review-controller'
import { canCancelRun, canReviewSelection } from './command-gates'

/**
 * Static palette commands (design doc "Interaction surfaces" §3). All are
 * pure user intents delegated to the `ReviewController` (Business Rules #1 —
 * nothing runs without an explicit user action), gated by the pure predicates
 * in `command-gates.ts` / `finding-navigation.ts` so unavailable commands are
 * hidden, never dead. No default hotkeys (community review guideline).
 *
 * - `Review current note` — active markdown view whose note is reviewable
 *   (not excluded + ≥1 dispatchable editor; service re-checks fail-closed).
 * - `Review selection` — non-empty selection in an editable reviewable view;
 *   captures the range synchronously (selection-capture contract, design §1).
 * - `Ask an editor` — same gate as `Review selection`; captures the range +
 *   hash synchronously, then opens the freeform modal (design §6 decision 1).
 * - `Open review panel` — reveals the side-panel leaf.
 * - `Cancel review` — the active file's run is still unsettled.
 * - `Next finding` / `Previous finding` — cursor-relative stepping through
 *   the active run's revealable findings, wrapping around.
 *
 * Dynamic commands (per-action `action-<id>`, per-editor accept/dismiss-all)
 * and triage-state commands (accept/dismiss current, severity filter) are
 * deferred until their pipelines exist — no non-functional commands.
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
        id: 'review-selection',
        name: 'Review selection',
        editorCheckCallback: (checking: boolean, editor, ctx): boolean => {
            // `ctx` can be any MarkdownFileInfo host (e.g. an embedded
            // editor); reviews dispatch through a full MarkdownView only.
            if (!(ctx instanceof MarkdownView)) {
                return false
            }
            const allowed = canReviewSelection({
                editable: ctx.getMode() !== 'preview',
                hasSelection: editor.somethingSelected(),
                reviewable: controller.canReview(ctx)
            })
            if (!allowed) {
                return false
            }
            if (checking) {
                return true
            }
            controller.startSelectionReview(ctx, editor)
            return true
        }
    })

    plugin.addCommand({
        id: 'ask-editor',
        name: 'Ask an editor',
        editorCheckCallback: (checking: boolean, editor, ctx): boolean => {
            // Same availability as `Review selection`: the modal dispatches a
            // selection-scoped review, so the gates must agree with what
            // `startReview` would accept.
            if (!(ctx instanceof MarkdownView)) {
                return false
            }
            const allowed = canReviewSelection({
                editable: ctx.getMode() !== 'preview',
                hasSelection: editor.somethingSelected(),
                reviewable: controller.canReview(ctx)
            })
            if (!allowed) {
                return false
            }
            if (checking) {
                return true
            }
            controller.openAskEditorModal(ctx, editor)
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

    plugin.addCommand({
        id: 'cancel-run',
        name: 'Cancel review',
        checkCallback: (checking: boolean): boolean => {
            const run = controller.getActiveRun()
            if (!canCancelRun({ hasRun: run !== null, settled: run?.isSettled() ?? true })) {
                return false
            }
            if (checking) {
                return true
            }
            run?.cancelRun()
            return true
        }
    })

    plugin.addCommand({
        id: 'next-finding',
        name: 'Next finding',
        checkCallback: (checking: boolean): boolean =>
            navigateFindingCommand(controller, checking, 'next')
    })

    plugin.addCommand({
        id: 'prev-finding',
        name: 'Previous finding',
        checkCallback: (checking: boolean): boolean =>
            navigateFindingCommand(controller, checking, 'prev')
    })
}

function navigateFindingCommand(
    controller: ReviewController,
    checking: boolean,
    direction: 'next' | 'prev'
): boolean {
    if (!controller.canNavigateFindings()) {
        return false
    }
    if (checking) {
        return true
    }
    controller.navigateFinding(direction)
    return true
}
