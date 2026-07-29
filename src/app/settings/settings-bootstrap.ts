import { loadSettingsDetailed } from '../domain/settings/settings-schema'
import type { PluginSettingsV1 } from '../domain/settings/settings-schema'
import { seedStarterPack } from '../domain/settings/starter-pack'
import { collectForeignKeys } from './settings-facade'

/**
 * Result of preparing raw `data.json` content for the plugin at load time.
 */
export interface SettingsBootstrap {
    readonly settings: PluginSettingsV1
    /**
     * Keys present in `data.json` but unknown to the settings schema —
     * carried through every save untouched so persistence never destroys
     * data owned by other plugin versions or sibling features.
     */
    readonly foreignKeys: Record<string, unknown>
    /**
     * True when the starter pack was seeded on this load and the result
     * must be persisted back to `data.json`.
     */
    readonly needsSave: boolean
    /**
     * Persisted values that failed validation and were reset to defaults
     * during salvage. The caller MUST warn the user when non-empty —
     * especially for privacy exclusions (Business Rule #7).
     */
    readonly dropped: readonly string[]
    /**
     * Entity paths whose duplicated ids were regenerated (sync-merge
     * artifact — see `resolveIdCollisions`). The caller MUST warn when
     * non-empty; `needsSave` is already set so the fix persists.
     */
    readonly regeneratedIds: readonly string[]
}

/**
 * Parses persisted settings defensively (per-entity salvage, never throws)
 * and seeds the starter pack exactly once (`starterPackSeeded` idempotence
 * lives in `seedStarterPack`). Pure — the caller persists when `needsSave`
 * is set and surfaces `dropped` when non-empty.
 */
export function bootstrapSettings(raw: unknown): SettingsBootstrap {
    const loaded = loadSettingsDetailed(raw)
    const seeded = seedStarterPack(loaded.settings)
    return {
        settings: seeded,
        foreignKeys: collectForeignKeys(raw),
        needsSave: seeded !== loaded.settings || loaded.regeneratedIds.length > 0,
        dropped: loaded.dropped,
        regeneratedIds: loaded.regeneratedIds
    }
}
