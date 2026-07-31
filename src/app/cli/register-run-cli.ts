import type { Plugin } from 'obsidian'
import {
    CANCEL_CLI_COMMAND,
    CANCEL_CLI_DESCRIPTION,
    CANCEL_CLI_FLAGS,
    handleCancelCli
} from '../services/cli/cancel-cli'
import type { CancelCliDeps } from '../services/cli/cancel-cli'
import {
    STATUS_CLI_COMMAND,
    STATUS_CLI_DESCRIPTION,
    STATUS_CLI_FLAGS,
    handleStatusCli
} from '../services/cli/status-cli'
import type { StatusCliDeps } from '../services/cli/status-cli'
import type { RunController } from '../services/orchestration/run-controller'
import { createNoteResolver } from './resolve-note-path'

/**
 * Obsidian glue for the run-inspection CLI subcommands (`editor-ai-daemons:cancel`,
 * `editor-ai-daemons:status`; design doc "Interaction surfaces" §4): binds the pure
 * handlers to the live vault and the shared `RunController`, and registers
 * them.
 *
 * Same caller contract as `registerReviewCli`: the plugin `onload` guards
 * registration with `Platform.isDesktop && requireApiVersion('1.12.2')` and
 * wraps each call in a try/catch — `registerCliHandler` throws when the
 * command is still registered by a dying instance (double-load race), and
 * the plugin then degrades to no CLI surface for that subcommand.
 *
 * These handlers only READ the controller state (plus `cancelRun`, which
 * flips run state but never discards it): cancelling from the CLI leaves
 * the findings inspectable via `editor-ai-daemons:status` and the review UI.
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

/**
 * Registers `editor-ai-daemons:status` — the read-only poll surface for external
 * agents: reports the current run for a note (settled state, per-editor
 * states, findings shaped exactly like `editor-ai-daemons:review` output) without
 * running anything. Same caller contract as above.
 */
export function registerStatusCli(input: { plugin: Plugin; runController: RunController }): void {
    const { plugin, runController } = input

    const deps: StatusCliDeps = {
        resolveFile: createNoteResolver(plugin.app),
        getRun: (path) => runController.getRun(path)
    }

    plugin.registerCliHandler(
        STATUS_CLI_COMMAND,
        STATUS_CLI_DESCRIPTION,
        STATUS_CLI_FLAGS,
        (params) => handleStatusCli(params, deps)
    )
}
