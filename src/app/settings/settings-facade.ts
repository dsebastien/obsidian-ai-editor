import { produce } from 'immer'
import type { Draft } from 'immer'
import {
    DEFAULT_PLUGIN_SETTINGS,
    loadSettings,
    pluginSettingsSchema
} from '../domain/settings/settings-schema'
import type { PluginSettingsV1 } from '../domain/settings/settings-schema'

/**
 * Read/update facade every settings surface works against. All mutations go
 * through `update` (Immer-style mutator over a draft) so persistence happens
 * in exactly one place and the UI never holds a mutable settings reference.
 */
export interface SettingsFacade {
    getSettings(): PluginSettingsV1
    update(mutator: (draft: Draft<PluginSettingsV1>) => void): Promise<void>
}

/**
 * Raw persistence surface every Obsidian `Plugin` instance provides.
 * Kept structural (no `obsidian` import) so the fallback facade is testable
 * under `bun test` without the Obsidian runtime.
 */
export interface SettingsPersistence {
    loadData(): Promise<unknown>
    saveData(data: unknown): Promise<void>
}

/**
 * What the settings tab accepts as its host: the plugin instance. When the
 * plugin implements the facade itself (`getSettings` + `update`), the tab
 * delegates to it; otherwise a fallback facade is built over
 * `loadData`/`saveData` so the tab works before the plugin migrates to the
 * versioned settings schema.
 */
export type SettingsHost = SettingsPersistence & Partial<SettingsFacade>

export interface CreatedSettingsFacade {
    readonly facade: SettingsFacade
    /**
     * Resolves once persisted settings are loaded. Callers that rendered
     * before this resolved should re-render; `update` always waits for it
     * internally so a mutation can never clobber unloaded data.
     */
    readonly ready: Promise<void>
}

/**
 * Builds the facade for a host. Prefers a host-provided implementation;
 * falls back to self-managed persistence that preserves foreign keys in
 * `data.json` (legacy fields, sibling features) on every save.
 */
export function createSettingsFacade(host: SettingsHost): CreatedSettingsFacade {
    const hostGetSettings = host.getSettings?.bind(host)
    const hostUpdate = host.update?.bind(host)
    if (hostGetSettings && hostUpdate) {
        return {
            facade: { getSettings: hostGetSettings, update: hostUpdate },
            ready: Promise.resolve()
        }
    }

    let settings: PluginSettingsV1 = DEFAULT_PLUGIN_SETTINGS
    let foreignKeys: Record<string, unknown> = {}
    const ready: Promise<void> = host
        .loadData()
        .then((raw) => {
            settings = loadSettings(raw)
            foreignKeys = collectForeignKeys(raw)
        })
        .catch(() => {
            settings = DEFAULT_PLUGIN_SETTINGS
            foreignKeys = {}
        })

    return {
        facade: {
            getSettings: (): PluginSettingsV1 => settings,
            update: async (mutator: (draft: Draft<PluginSettingsV1>) => void): Promise<void> => {
                await ready
                // Validate before persisting: the load path is strict, so a
                // schema-invalid save would be wiped on the next startup.
                // Rejecting keeps the previous value and lets callers warn.
                const next = produce(settings, mutator)
                const parsed = pluginSettingsSchema.safeParse(next)
                if (!parsed.success) {
                    throw new Error('Rejected a settings update that failed schema validation')
                }
                settings = parsed.data
                await host.saveData({ ...foreignKeys, ...settings })
            }
        },
        ready
    }
}

/**
 * Keys present in the persisted data but unknown to the settings schema.
 * They are carried through saves untouched so no save path ever destroys
 * data owned by other parts of the plugin (or by older versions). Shared
 * with the plugin's own settings bootstrap.
 */
export function collectForeignKeys(raw: unknown): Record<string, unknown> {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
        return {}
    }
    const known = new Set(Object.keys(DEFAULT_PLUGIN_SETTINGS))
    const foreign: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(raw)) {
        if (!known.has(key)) {
            foreign[key] = value
        }
    }
    return foreign
}
