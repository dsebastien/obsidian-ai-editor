import { MarkdownView, Notice } from 'obsidian'
import type { Plugin } from 'obsidian'
import type { SettingsFacade } from '../settings/settings-facade'
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
 * - `Preview what will be sent` — the trust surface (plan M5): assembles the
 *   REAL context for the active note through the same `buildEditorPrompt` a
 *   dispatch uses and shows it read-only. Sends nothing.
 * - `Open review panel` — reveals the side-panel leaf.
 * - `Cancel review` — the active file's run is still unsettled.
 * - `Next finding` / `Previous finding` — triage stepping through the
 *   active run's revealable findings (anchor order, all editors, wrapping
 *   around): moves the per-file triage cursor, rings the current finding,
 *   and opens its card (card-on-jump).
 * - `Accept current finding` / `Dismiss current finding` — judge the triage
 *   cursor's finding (accept routes through the FindingStore precondition
 *   exactly like the card button) and auto-advance to the next remaining
 *   one. Hidden unless a current finding exists (and, for accept, is
 *   actionable with its note open in an editor).
 * - `accept-all` — accept every non-conflicting finding of the active run
 *   (all editors) as ONE undoable transaction; overlapping and no-longer-
 *   matching suggestions are skipped and reported. The per-editor variants
 *   are dynamic commands (`bulk-commands.ts`).
 * - `filter-severity` — cycle the active file's severity lens (all →
 *   warnings and suggestions → warnings only); the Notice says what is shown
 *   and how much is hidden.
 * - `Ask for comments` — same gate as `Review selection`, plus a comment
 *   store: parks a background question on the selection whose answer lands in
 *   the margin (plan §5.5 / M8).
 * - `toggle-margin-comments` — show/hide the margin comment column (plan
 *   §5.5 / M8). A global view preference, so it is always available and
 *   persists; the Notice says where the comments went either way.
 */
export function registerReviewCommands(
    plugin: Plugin,
    controller: ReviewController,
    settings: SettingsFacade
): void {
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
        id: 'comment-on-selection',
        name: 'Ask for comments',
        editorCheckCallback: (checking: boolean, editor, ctx): boolean => {
            // A margin comment IS a review scoped to the span, so it takes the
            // same gate — plus a comment store to park it in.
            if (!(ctx instanceof MarkdownView) || !controller.canCommentOnNote()) {
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
            controller.openCommentModal(ctx, editor)
            return true
        }
    })

    plugin.addCommand({
        id: 'preview-context',
        name: 'Preview what will be sent',
        checkCallback: (checking: boolean): boolean => {
            const view = plugin.app.workspace.getActiveViewOfType(MarkdownView)
            if (!view || !controller.canPreviewContext(view)) {
                return false
            }
            if (checking) {
                return true
            }
            controller.openContextPreview(view)
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
        name: 'Cancel review or action',
        checkCallback: (checking: boolean): boolean => {
            // One cancel surface for everything in flight on the active
            // note: the review run and/or the transform/generate run.
            const run = controller.getActiveRun()
            const transform = controller.getActiveTransformRun()
            const reviewCancellable = canCancelRun({
                hasRun: run !== null,
                // `isBusy`, not `isSettled`: a panel whose scorecard is being
                // written has every editor terminal and a backend request in
                // flight — the one moment Cancel must not disappear.
                settled: !(run?.isBusy() ?? false)
            })
            const transformCancellable = canCancelRun({
                hasRun: transform !== null,
                settled: transform?.isSettled() ?? true
            })
            if (!reviewCancellable && !transformCancellable) {
                return false
            }
            if (checking) {
                return true
            }
            if (reviewCancellable) {
                run?.cancelRun()
            }
            if (transformCancellable) {
                transform?.cancel()
            }
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

    plugin.addCommand({
        id: 'accept-finding',
        name: 'Accept current finding',
        checkCallback: (checking: boolean): boolean => {
            if (!controller.canAcceptCurrentFinding()) {
                return false
            }
            if (checking) {
                return true
            }
            controller.acceptCurrentFinding()
            return true
        }
    })

    plugin.addCommand({
        id: 'filter-severity',
        name: 'Cycle severity filter',
        checkCallback: (checking: boolean): boolean => {
            if (!controller.canCycleSeverityFilter()) {
                return false
            }
            if (checking) {
                return true
            }
            controller.cycleSeverityFilter()
            return true
        }
    })

    plugin.addCommand({
        id: 'accept-all',
        name: 'Accept all non-conflicting findings',
        checkCallback: (checking: boolean): boolean => {
            if (!controller.canAcceptAll(null)) {
                return false
            }
            if (checking) {
                return true
            }
            controller.acceptAllFindings(null)
            return true
        }
    })

    plugin.addCommand({
        id: 'generate-more',
        // The fan-out is in the NAME: one press is one backend request per
        // finished editor, and the palette is the one surface that cannot
        // show the count the per-editor button carries.
        name: 'Generate more findings from every finished editor',
        checkCallback: (checking: boolean): boolean => {
            if (!controller.canGenerateMore()) {
                return false
            }
            if (checking) {
                return true
            }
            // One round per editor that finished — never a loop. The findings
            // already on the note are kept; the new ones are appended.
            controller.generateMore()
            return true
        }
    })

    plugin.addCommand({
        id: 'toggle-margin-comments',
        name: 'Toggle the margin comment column',
        // No gate: this is a view preference, not an operation on a note, and
        // a command that vanishes when the active note has no comments would
        // be unfindable exactly when the user wants to turn the column back
        // on. It never sends anything anywhere.
        callback: (): void => {
            const next = !settings.getSettings().behavior.showMarginComments
            void settings
                .update((draft) => {
                    draft.behavior.showMarginComments = next
                })
                .then(() => {
                    controller.requestRefresh()
                    new Notice(
                        next
                            ? 'Margin comments are on. They appear beside the text when the pane is wide enough.'
                            : 'Margin comments are off. They are still listed in the review panel.'
                    )
                })
        }
    })

    plugin.addCommand({
        id: 'dismiss-finding',
        name: 'Dismiss current finding',
        checkCallback: (checking: boolean): boolean => {
            if (!controller.canDismissCurrentFinding()) {
                return false
            }
            if (checking) {
                return true
            }
            controller.dismissCurrentFinding()
            return true
        }
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
