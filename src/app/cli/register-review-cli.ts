import type { Plugin } from 'obsidian'
import type { PluginSettingsV1 } from '../domain/settings/settings-schema'
import {
    REVIEW_CLI_COMMAND,
    REVIEW_CLI_DESCRIPTION,
    REVIEW_CLI_FLAGS,
    handleReviewCli
} from '../services/cli/review-cli'
import type { ReviewCliDeps } from '../services/cli/review-cli'
import type { RunController } from '../services/orchestration/run-controller'
import { startReview } from '../services/review-service'
import { ObsidianVaultReader } from '../ui/obsidian-vault-reader'
import type { ReviewController } from '../ui/review-controller'
import { createNoteResolver } from './resolve-note-path'

/**
 * Obsidian glue for the `ai-editor:review` CLI subcommand (design doc
 * "Interaction surfaces" §4): binds the pure `handleReviewCli` core to the
 * live vault and the shared review pipeline, and registers the handler.
 *
 * The caller (plugin `onload`) guards registration with
 * `Platform.isDesktop && requireApiVersion('1.12.2')` — `registerCliHandler`
 * shipped with API 1.12.2 and the CLI is a desktop surface; on older public
 * releases the plugin simply has no CLI surface (no `minAppVersion` bump).
 * `registerCliHandler` throws when the command is already registered (e.g.
 * a dying instance in a double-load race), so the caller also wraps this in
 * a try/catch and degrades to no CLI surface for the session.
 *
 * The run goes through the exact same `startReview` service as the `Review
 * current note` command, on the exact same `RunController`. Two cases:
 *
 * - Note OPEN in a markdown view: the snapshot comes from the LIVE editor
 *   buffer via `ReviewController.cliRunBinding` (the buffer may hold unsaved
 *   edits — a vault-state snapshot would put every anchor/decoration on
 *   offsets computed against different text), and the started run is bound
 *   to the view glue synchronously via `bindCliRun` so edits typed during
 *   the run keep remapping anchors (Business Rules #3/#4) and the
 *   rail/panel/highlights pick the run up immediately.
 * - Note NOT open: the snapshot is the saved vault state, and the settled
 *   run is discarded after the output document is shaped (`releaseRun`) —
 *   retained runs pin the full snapshot text and finding store, so batch
 *   CLI usage must not accumulate them.
 */
export function registerReviewCli(input: {
    plugin: Plugin
    runController: RunController
    reviewController: ReviewController
    getSettings: () => PluginSettingsV1
}): void {
    const { plugin, runController, reviewController, getSettings } = input
    const vaultReader = new ObsidianVaultReader(plugin.app)

    const deps: ReviewCliDeps = {
        getSettings,
        resolveFile: createNoteResolver(plugin.app),
        readNote: (path: string): Promise<string | null> => vaultReader.readNote(path),
        runReview: async (run) => {
            const path = run.snapshot.filePath
            const live = reviewController.cliRunBinding(path)
            const result = await startReview({
                settings: run.settings,
                snapshot: live?.snapshot ?? run.snapshot,
                vault: vaultReader,
                runController,
                fetchImpl: window.fetch.bind(window),
                confirmedLargeNote: run.confirmedLargeNote,
                ...(live ? { refreshSnapshot: live.refreshSnapshot } : {})
            })
            if (result.status === 'started' && live) {
                // Synchronous on purpose — same invariant as the `started`
                // branch of `ReviewController.startReview`: edit forwarding
                // only covers edits made after the glue holds the run.
                reviewController.bindCliRun(path, result.skips)
            }
            return result
        },
        releaseRun: (path, run): void => {
            if (reviewController.hasOpenMarkdownView(path)) {
                return // the run lives on in the rail/panel/highlights
            }
            if (runController.getRun(path) !== run) {
                return // a newer run owns the slot — never discard it
            }
            runController.discardRun(path)
        }
    }

    plugin.registerCliHandler(
        REVIEW_CLI_COMMAND,
        REVIEW_CLI_DESCRIPTION,
        REVIEW_CLI_FLAGS,
        (params) => handleReviewCli(params, deps)
    )
}
