import type { Plugin } from 'obsidian'
import {
    CANCEL_CLI_COMMAND,
    CANCEL_CLI_DESCRIPTION,
    CANCEL_CLI_FLAGS,
    handleCancelCli
} from '../services/cli/cancel-cli'
import type { CancelCliDeps } from '../services/cli/cancel-cli'
import type { RunController } from '../services/orchestration/run-controller'
import { createNoteResolver } from './resolve-note-path'

/**
 * Obsidian glue for the run-inspection CLI subcommands (`ai-editor:cancel`;
 * design doc "Interaction surfaces" §4): binds the pure handlers to the live
 * vault and the shared `RunController`, and registers them.
 *
 * Same caller contract as `registerReviewCli`: the plugin `onload` guards
 * registration with `Platform.isDesktop && requireApiVersion('1.12.2')` and
 * wraps each call in a try/catch — `registerCliHandler` throws when the
 * command is still registered by a dying instance (double-load race), and
 * the plugin then degrades to no CLI surface for that subcommand.
 *
 * These handlers only READ the controller state (plus `cancelRun`, which
 * flips run state but never discards it): cancelling from the CLI leaves
 * the findings inspectable via `ai-editor:status` and the review UI.
 */
export function registerCancelCli(input: { plugin: Plugin; runController: RunController }): void {
    const { plugin, runController } = input

    const deps: CancelCliDeps = {
        resolveFile: createNoteResolver(plugin.app),
        getRun: (path) => runController.getRun(path)
    }

    plugin.registerCliHandler(
        CANCEL_CLI_COMMAND,
        CANCEL_CLI_DESCRIPTION,
        CANCEL_CLI_FLAGS,
        (params) => handleCancelCli(params, deps)
    )
}
