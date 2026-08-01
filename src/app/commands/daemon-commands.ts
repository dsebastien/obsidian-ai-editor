import { Notice } from 'obsidian'
import type { Plugin } from 'obsidian'
import type { SettingsFacade } from '../settings/settings-facade'

/**
 * `Toggle daemon mode` — the one setting a user flips by situation rather
 * than once at setup: on while drafting a piece they want watched, off for
 * the rest of the day. Reaching it meant opening settings, finding the
 * Behavior tab and scrolling to the third section, which is four clicks for a
 * decision people make repeatedly.
 *
 * It is a command, not a ribbon icon or a rail control: daemon mode costs
 * money on every refresh (Business Rules #1), and a control sitting one
 * mis-click away from the Review button is the wrong place for that. The
 * palette is deliberate — you have to name what you want.
 *
 * The confirmation Notice states the new state AND, when switching on, what
 * that state does, because "on" is the expensive direction and the settings
 * copy explaining it is exactly what the command lets you skip.
 */
export function daemonToggleNotice(enabled: boolean, idleSeconds: number): string {
    return enabled
        ? `Daemon mode on — editors refresh a changed note ${idleSeconds}s after you stop typing. Each refresh calls your backends.`
        : 'Daemon mode off — editors run only when you summon them.'
}

export function registerDaemonCommands(plugin: Plugin, facade: SettingsFacade): void {
    plugin.addCommand({
        id: 'toggle-daemon-mode',
        name: 'Toggle daemon mode',
        callback: (): void => {
            const next = !facade.getSettings().behavior.daemonMode
            facade
                .update((draft) => {
                    draft.behavior.daemonMode = next
                })
                .then(() => {
                    new Notice(
                        daemonToggleNotice(next, facade.getSettings().behavior.daemonIdleSeconds)
                    )
                })
                .catch(() => {
                    new Notice('AI Editor: failed to change daemon mode.')
                })
        }
    })
}
