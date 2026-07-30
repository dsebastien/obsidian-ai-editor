import type { Plugin } from 'obsidian'
import type { PluginSettingsV1 } from '../domain/settings/settings-schema'
import type { ReviewController } from '../ui/review-controller'
import { diffCommands } from './command-sync'
import type { CommandDiff, CommandView } from './command-sync'

/**
 * Dynamic per-editor bulk triage commands (design doc "Interaction surfaces"
 * §3): `accept-all-<editorId>` / `dismiss-all-<editorId>`.
 *
 * Two axes on purpose:
 * - REGISTRATION follows the settings (one pair per enabled review-capable
 *   editor), synced through the settings mutation observer exactly like the
 *   `action-<bindingId>` commands — command ids embed the editor entity id so
 *   user hotkeys survive renaming the editor, and a renamed editor re-adds
 *   its commands in place with the new palette name.
 * - AVAILABILITY is per invocation: the gate asks the controller whether the
 *   ACTIVE note's run currently has anything that editor could accept or
 *   dismiss, so a command whose run has nothing to triage is hidden from the
 *   palette rather than dead.
 *
 * Registering per run instead would mean churning commands on every stream
 * event and orphaning hotkeys between runs.
 */

export interface BulkCommandView extends CommandView {
    /** Stable command id: `accept-all-<editorId>` / `dismiss-all-<editorId>`. */
    readonly id: string
    readonly name: string
    readonly editorId: string
    readonly kind: 'accept' | 'dismiss'
}

export type BulkCommandDiff = CommandDiff<BulkCommandView>

/** One accept/dismiss pair per enabled review-capable editor. */
export function desiredBulkCommands(settings: PluginSettingsV1): BulkCommandView[] {
    return settings.editors
        .filter((editor) => editor.enabled && editor.capabilities.review)
        .flatMap((editor): BulkCommandView[] => [
            {
                id: `accept-all-${editor.id}`,
                name: `Accept all from ${editor.name}`,
                editorId: editor.id,
                kind: 'accept'
            },
            {
                id: `dismiss-all-${editor.id}`,
                name: `Dismiss all from ${editor.name}`,
                editorId: editor.id,
                kind: 'dismiss'
            }
        ])
}

/** Diffs registered against desired — shared rules, see `command-sync`. */
export function diffBulkCommands(
    registered: ReadonlyMap<string, string>,
    desired: readonly BulkCommandView[]
): BulkCommandDiff {
    return diffCommands(registered, desired)
}

/**
 * Registers the per-editor bulk commands and keeps them in sync with the
 * settings. Call once from `onload`; Obsidian removes the plugin's commands
 * on unload.
 */
export function registerBulkCommands(
    plugin: Plugin,
    controller: ReviewController,
    getSettings: () => PluginSettingsV1,
    subscribe: (listener: () => void) => () => void
): void {
    /** id → registered palette name (rename detection). */
    const registered = new Map<string, string>()

    const sync = (): void => {
        const diff = diffBulkCommands(registered, desiredBulkCommands(getSettings()))
        for (const id of diff.remove) {
            plugin.removeCommand(id)
            registered.delete(id)
        }
        for (const command of diff.add) {
            addBulkCommand(plugin, controller, command)
            registered.set(command.id, command.name)
        }
    }

    sync()
    plugin.register(subscribe(sync))
}

function addBulkCommand(
    plugin: Plugin,
    controller: ReviewController,
    command: BulkCommandView
): void {
    plugin.addCommand({
        id: command.id,
        name: command.name,
        checkCallback: (checking: boolean): boolean => {
            const available =
                command.kind === 'accept'
                    ? controller.canAcceptAll(command.editorId)
                    : controller.canDismissAll(command.editorId)
            if (!available) {
                return false
            }
            if (checking) {
                return true
            }
            if (command.kind === 'accept') {
                controller.acceptAllFindings(command.editorId)
            } else {
                controller.dismissAllFindings(command.editorId)
            }
            return true
        }
    })
}
