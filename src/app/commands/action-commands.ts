import { MarkdownView } from 'obsidian'
import type { Plugin } from 'obsidian'
import type { PluginSettingsV1 } from '../domain/settings/settings-schema'
import { resolveActionById, resolveActions } from '../services/actions/action-resolution'
import type { ReviewController } from '../ui/review-controller'
import { canRunBoundAction } from './command-gates'

/**
 * Dynamic per-action palette commands (design doc "Interaction surfaces"
 * §3): one `action-<bindingId>` command per DISPATCHABLE action binding.
 * Command ids embed the binding entity's stable id — the verb id for
 * built-in verbs, the entity UUID for custom actions — so user hotkeys
 * survive renames and rebinding; removing the binding orphans its hotkey
 * (Obsidian behavior).
 *
 * Registration follows the settings: on every settings mutation the desired
 * command set is diffed against the registered one — stale commands are
 * removed, new ones added, and a renamed action re-registers under its
 * unchanged id (`addCommand` replaces in place). A binding that cannot
 * dispatch is never registered (design rule: no non-functional commands);
 * availability is additionally re-checked per invocation through the same
 * `resolveActionById` the dispatch path uses.
 */

// ---------------------------------------------------------------------------
// Pure: desired set + diff
// ---------------------------------------------------------------------------

export interface ActionCommandView {
    /** Stable command id: `action-<bindingId>`. */
    readonly id: string
    /** Palette name — the action's sentence-case label. */
    readonly name: string
    readonly bindingId: string
}

/** The commands the current settings call for: one per dispatchable binding. */
export function desiredActionCommands(settings: PluginSettingsV1): ActionCommandView[] {
    return resolveActions(settings).map((action) => ({
        id: `action-${action.bindingId}`,
        name: action.label,
        bindingId: action.bindingId
    }))
}

export interface ActionCommandDiff {
    /** Commands to (re)register: new ids, or same id with a changed name. */
    readonly add: readonly ActionCommandView[]
    /** Command ids to remove. */
    readonly remove: readonly string[]
}

/**
 * Diffs the registered command set (id → name) against the desired one.
 * Unchanged commands are touched by neither list, so a settings mutation
 * that does not affect actions is a no-op.
 */
export function diffActionCommands(
    registered: ReadonlyMap<string, string>,
    desired: readonly ActionCommandView[]
): ActionCommandDiff {
    const desiredIds = new Set(desired.map((command) => command.id))
    const remove = [...registered.keys()].filter((id) => !desiredIds.has(id))
    const add = desired.filter((command) => registered.get(command.id) !== command.name)
    return { add, remove }
}

// ---------------------------------------------------------------------------
// Obsidian glue
// ---------------------------------------------------------------------------

/**
 * Registers the dynamic commands and keeps them in sync with the settings
 * via the facade's mutation observer. Call once from `onload`; Obsidian
 * removes the plugin's commands on unload.
 */
export function registerActionCommands(
    plugin: Plugin,
    controller: ReviewController,
    getSettings: () => PluginSettingsV1,
    subscribe: (listener: () => void) => () => void
): void {
    /** id → registered palette name (rename detection). */
    const registered = new Map<string, string>()

    const sync = (): void => {
        const diff = diffActionCommands(registered, desiredActionCommands(getSettings()))
        for (const id of diff.remove) {
            plugin.removeCommand(id)
            registered.delete(id)
        }
        for (const command of diff.add) {
            addActionCommand(plugin, controller, getSettings, command)
            registered.set(command.id, command.name)
        }
    }

    sync()
    plugin.register(subscribe(sync))
}

function addActionCommand(
    plugin: Plugin,
    controller: ReviewController,
    getSettings: () => PluginSettingsV1,
    command: ActionCommandView
): void {
    plugin.addCommand({
        id: command.id,
        name: command.name,
        editorCheckCallback: (checking: boolean, editor, ctx): boolean => {
            // `ctx` can be any MarkdownFileInfo host (e.g. an embedded
            // editor); dispatch goes through a full MarkdownView only.
            if (!(ctx instanceof MarkdownView)) {
                return false
            }
            const file = ctx.file
            if (!file) {
                return false
            }
            // Live dispatchability + the class-specific editor state gate.
            const resolved = resolveActionById(getSettings(), command.bindingId)
            if (!resolved || controller.isNoteExcluded(file.path)) {
                return false
            }
            const allowed = canRunBoundAction({
                verbClass: resolved.verbClass,
                editable: ctx.getMode() !== 'preview',
                hasSelection: editor.somethingSelected()
            })
            if (!allowed) {
                return false
            }
            if (checking) {
                return true
            }
            // Selection capture happens synchronously inside.
            controller.startBoundAction(ctx, editor, command.bindingId)
            return true
        }
    })
}
