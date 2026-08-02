import { Notice } from 'obsidian'
import type { App } from 'obsidian'
import type { Draft } from 'immer'
import type { PluginSettingsV1 } from '../../domain/settings/settings-schema'
import type { SettingsFacade } from '../settings-facade'

/** Everything a tab renderer needs: app handle, settings facade, re-render. */
export interface TabContext {
    readonly app: App
    readonly facade: SettingsFacade
    /** Re-renders the whole settings tab; call after structural mutations. */
    readonly refresh: () => void
    /**
     * Clears the review history, in memory and on disk (issue #21). Wired by
     * the plugin; absent in headless/test contexts.
     */
    readonly clearHistory?: () => void
}

/**
 * Persists a mutation through the facade. Pass `refresh: true` for changes
 * that alter which controls exist (add/delete/reorder/toggle-driven fields);
 * plain value edits skip the re-render so text inputs keep focus.
 */
export function commit(
    ctx: TabContext,
    mutator: (draft: Draft<PluginSettingsV1>) => void,
    options: { refresh?: boolean } = {}
): void {
    void ctx.facade
        .update(mutator)
        .then(() => {
            if (options.refresh) {
                ctx.refresh()
            }
        })
        .catch(() => {
            new Notice('AI Editor: failed to save settings.')
        })
}
