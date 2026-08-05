import { describe, expect, it } from 'bun:test'
import { bootstrapSettings } from './settings-bootstrap'
import { DEFAULT_PLUGIN_SETTINGS } from '../domain/settings/settings-schema'
import {
    REVISION_2_EDITOR_SPECS,
    STARTER_EDITOR_SPECS,
    STARTER_PACK_VERSION,
    STARTER_PANEL_NAME
} from '../domain/settings/starter-pack'

const ALL_STARTER_COUNT = STARTER_EDITOR_SPECS.length + REVISION_2_EDITOR_SPECS.length

describe('bootstrapSettings', () => {
    it('seeds the starter pack on a fresh install (null data)', () => {
        const boot = bootstrapSettings(null)
        expect(boot.needsSave).toBe(true)
        expect(boot.settings.starterPackVersion).toBe(STARTER_PACK_VERSION)
        expect(boot.settings.editors).toHaveLength(ALL_STARTER_COUNT)
        expect(boot.settings.panels.map((panel) => panel.name)).toEqual([STARTER_PANEL_NAME])
        expect(boot.foreignKeys).toEqual({})
    })

    it('returns already-seeded settings unchanged, with no save needed', () => {
        const seeded = bootstrapSettings(null).settings
        const boot = bootstrapSettings(seeded)
        expect(boot.needsSave).toBe(false)
        expect(boot.settings).toEqual(seeded)
    })

    it('falls back to defaults (then seeds) on garbage data', () => {
        const boot = bootstrapSettings('not an object')
        expect(boot.needsSave).toBe(true)
        expect(boot.settings.starterPackVersion).toBe(STARTER_PACK_VERSION)
        expect(boot.settings.behavior).toEqual(DEFAULT_PLUGIN_SETTINGS.behavior)
        expect(boot.foreignKeys).toEqual({})
    })

    it('captures unknown data.json keys as foreign keys (legacy shape preserved)', () => {
        const boot = bootstrapSettings({ enabled: false, legacyThing: { a: 1 } })
        expect(boot.foreignKeys).toEqual({ enabled: false, legacyThing: { a: 1 } })
        // The legacy shape carries no versioned settings: defaults + seed apply.
        expect(boot.settings.starterPackVersion).toBe(STARTER_PACK_VERSION)
        expect(boot.needsSave).toBe(true)
    })

    it('never re-seeds at the current version, even with zero editors (user deleted them)', () => {
        const raw = { ...DEFAULT_PLUGIN_SETTINGS, starterPackVersion: STARTER_PACK_VERSION }
        const boot = bootstrapSettings(raw)
        expect(boot.settings.editors).toHaveLength(0)
        expect(boot.settings.panels).toHaveLength(0)
        expect(boot.needsSave).toBe(false)
    })

    it('seeds ONLY the later revisions into a ≤0.3.x vault (legacy boolean)', () => {
        // A vault seeded under the retired boolean gets the Grammar Editor
        // and nothing else: no resurrected personas, no second panel — even
        // when the user deleted every starter entity (issue #37).
        const raw = { ...DEFAULT_PLUGIN_SETTINGS, starterPackSeeded: true }
        delete (raw as Record<string, unknown>)['starterPackVersion']
        const boot = bootstrapSettings(raw)
        expect(boot.settings.editors.map((editor) => editor.name)).toEqual(
            REVISION_2_EDITOR_SPECS.map((spec) => spec.name)
        )
        expect(boot.settings.panels).toHaveLength(0)
        expect(boot.settings.starterPackVersion).toBe(STARTER_PACK_VERSION)
        expect(boot.needsSave).toBe(true)
        // The retired key rides along as a foreign key, protecting downgrades.
        expect(boot.foreignKeys).toEqual({ starterPackSeeded: true })
    })

    it('preserves user entities while seeding around them', () => {
        const withUserEditor = {
            ...DEFAULT_PLUGIN_SETTINGS,
            editors: [
                {
                    id: 'user-editor',
                    name: 'My editor'
                }
            ]
        }
        const boot = bootstrapSettings(withUserEditor)
        expect(boot.settings.editors.map((editor) => editor.id)).toContain('user-editor')
        expect(boot.settings.editors).toHaveLength(ALL_STARTER_COUNT + 1)
        expect(boot.needsSave).toBe(true)
    })
})
