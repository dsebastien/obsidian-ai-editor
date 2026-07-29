import { normalizePath } from 'obsidian'
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

/**
 * Obsidian glue for the `ai-editor:review` CLI subcommand (design doc
 * "Interaction surfaces" §4): binds the pure `handleReviewCli` core to the
 * live vault and the shared review pipeline, and registers the handler.
 *
 * The caller (plugin `onload`) guards registration with
 * `Platform.isDesktop && requireApiVersion('1.12.2')` — `registerCliHandler`
 * shipped with API 1.12.2 and the CLI is a desktop surface; on older public
 * releases the plugin simply has no CLI surface (no `minAppVersion` bump).
 *
 * The run goes through the exact same `startReview` service as the `Review
 * current note` command, on the exact same `RunController` — so a CLI run on
 * a note that is open in a view shows up in the rail, panel, and highlights
 * like any other run. The snapshot is read from the vault (saved state), not
 * from an editor buffer.
 */
export function registerReviewCli(input: {
    plugin: Plugin
    runController: RunController
    getSettings: () => PluginSettingsV1
}): void {
    const { plugin, runController, getSettings } = input
    const vaultReader = new ObsidianVaultReader(plugin.app)

    const deps: ReviewCliDeps = {
        getSettings,
        // Accepts a vault-relative path (with or without `.md`) or plain
        // link text, markdown notes only — same tolerance as wikilink
        // resolution, so `--file "My Note"` works like `[[My Note]]`.
        resolveFile: (file: string): string | null => {
            const normalized = normalizePath(file)
            const vault = plugin.app.vault
            const byPath =
                vault.getFileByPath(normalized) ?? vault.getFileByPath(`${normalized}.md`)
            const resolved = byPath ?? plugin.app.metadataCache.getFirstLinkpathDest(normalized, '')
            return resolved !== null && resolved.extension === 'md' ? resolved.path : null
        },
        readNote: (path: string): Promise<string | null> => vaultReader.readNote(path),
        runReview: (run) =>
            startReview({
                settings: run.settings,
                snapshot: run.snapshot,
                vault: vaultReader,
                runController,
                fetchImpl: window.fetch.bind(window),
                confirmedLargeNote: run.confirmedLargeNote
            })
    }

    plugin.registerCliHandler(
        REVIEW_CLI_COMMAND,
        REVIEW_CLI_DESCRIPTION,
        REVIEW_CLI_FLAGS,
        (params) => handleReviewCli(params, deps)
    )
}
