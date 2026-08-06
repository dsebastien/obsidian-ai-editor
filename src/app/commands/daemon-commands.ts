import { MarkdownView } from 'obsidian'
import type { Plugin } from 'obsidian'
import type { ReviewController } from '../ui/review-controller'

/**
 * `Toggle daemon mode for the current note` — the one mode a user flips by situation rather than
 * once at setup: on for the note they are drafting and want watched, off for
 * the rest. Daemon mode is PER NOTE and runtime-only (Sébastien,
 * 2026-08-06): each note starts from the `behavior.daemonAlwaysOn` default
 * (off unless that setting is on) when it opens, and this command — like the
 * rail toggle — flips the ACTIVE note only, for as long as it stays open.
 * Nothing is persisted; reopening a note starts from the default again.
 *
 * It is a command, not a ribbon icon: daemon mode costs money on every
 * refresh (Business Rules #1), and the palette is deliberate — you have to
 * name what you want. `checkCallback` hides it without an active markdown
 * note, because there is no note whose mode it could flip (a hidden command
 * over a dead one, Business Rules #14).
 *
 * The confirmation Notice (raised inside `toggleDaemonModeFor`, shared with
 * the rail toggle) states the new state AND, when switching on, what that
 * state does, because "on" is the expensive direction and the settings copy
 * explaining it is exactly what the command lets you skip.
 */
export function daemonToggleNotice(enabled: boolean, idleSeconds: number): string {
    return enabled
        ? `Daemon mode on for this note — editors refresh it after ${idleSeconds}s of quiet (editing restarts the clock; triaging findings does not). Each refresh calls your backends. The choice lasts until the note is closed.`
        : 'Daemon mode off for this note — editors run only when you summon them.'
}

export function registerDaemonCommands(plugin: Plugin, controller: ReviewController): void {
    plugin.addCommand({
        id: 'toggle-daemon-mode',
        name: 'Toggle daemon mode for the current note',
        checkCallback: (checking: boolean): boolean => {
            const view = plugin.app.workspace.getActiveViewOfType(MarkdownView)
            const path = view?.file?.path
            if (path === undefined) {
                return false
            }
            if (!checking) {
                controller.toggleDaemonModeFor(path)
            }
            return true
        }
    })
}
