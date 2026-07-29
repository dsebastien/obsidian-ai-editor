import { describe, expect, it } from 'bun:test'
import { bootstrapSettings } from './settings-bootstrap'
import { DEFAULT_PLUGIN_SETTINGS } from '../domain/settings/settings-schema'
import { STARTER_EDITOR_SPECS, STARTER_PANEL_NAME } from '../domain/settings/starter-pack'

describe('bootstrapSettings', () => {
    it('seeds the starter pack on a fresh install (null data)', () => {
        const boot = bootstrapSettings(null)
        expect(boot.needsSave).toBe(true)
        expect(boot.settings.starterPackSeeded).toBe(true)
        expect(boot.settings.editors).toHaveLength(STARTER_EDITOR_SPECS.length)
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
        expect(boot.settings.starterPackSeeded).toBe(true)
        expect(boot.settings.behavior).toEqual(DEFAULT_PLUGIN_SETTINGS.behavior)
        expect(boot.foreignKeys).toEqual({})
    })

    it('captures unknown data.json keys as foreign keys (legacy shape preserved)', () => {
        const boot = bootstrapSettings({ enabled: false, legacyThing: { a: 1 } })
        expect(boot.foreignKeys).toEqual({ enabled: false, legacyThing: { a: 1 } })
        // The legacy shape carries no versioned settings: defaults + seed apply.
        expect(boot.settings.starterPackSeeded).toBe(true)
        expect(boot.needsSave).toBe(true)
    })

    it('never re-seeds when the flag is set, even with zero editors (user deleted them)', () => {
        const raw = { ...DEFAULT_PLUGIN_SETTINGS, starterPackSeeded: true }
        const boot = bootstrapSettings(raw)
        expect(boot.settings.editors).toHaveLength(0)
        expect(boot.settings.panels).toHaveLength(0)
        expect(boot.needsSave).toBe(false)
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
        expect(boot.settings.editors).toHaveLength(STARTER_EDITOR_SPECS.length + 1)
        expect(boot.needsSave).toBe(true)
    })
})
