import { describe, expect, it } from 'bun:test'
import { produce } from 'immer'
import { collectControlKeys, readControlValue, writeControlValue } from './control-bindings'
import { DEFAULT_PLUGIN_SETTINGS } from '../domain/settings/settings-schema'
import type { PluginSettingsV1 } from '../domain/settings/settings-schema'

function write(key: string, value: unknown): { settings: PluginSettingsV1; landed: boolean } {
    let landed = false
    const settings = produce(DEFAULT_PLUGIN_SETTINGS, (draft) => {
        landed = writeControlValue(draft, key, value)
    })
    return { settings, landed }
}

describe('readControlValue', () => {
    it('resolves a nested dot path', () => {
        expect(readControlValue(DEFAULT_PLUGIN_SETTINGS, 'behavior.daemonIdleSeconds')).toBe(
            DEFAULT_PLUGIN_SETTINGS.behavior.daemonIdleSeconds
        )
        expect(readControlValue(DEFAULT_PLUGIN_SETTINGS, 'voiceProfile.followLinks')).toBe(
            DEFAULT_PLUGIN_SETTINGS.voiceProfile.followLinks
        )
    })

    it('returns undefined for an unresolvable path instead of throwing', () => {
        // undefined is what the framework reads as "use defaultValue", so a
        // bad key degrades to the declared default mid-render rather than
        // taking the settings pane down with it.
        expect(readControlValue(DEFAULT_PLUGIN_SETTINGS, 'behavior.nope')).toBeUndefined()
        expect(readControlValue(DEFAULT_PLUGIN_SETTINGS, 'nope.nested.deep')).toBeUndefined()
        expect(
            readControlValue(DEFAULT_PLUGIN_SETTINGS, 'behavior.daemonIdleSeconds.tooFar')
        ).toBeUndefined()
    })
})

describe('writeControlValue', () => {
    it('writes a nested scalar and reports that it landed', () => {
        const { settings, landed } = write('behavior.daemonIdleSeconds', 42)
        expect(landed).toBe(true)
        expect(settings.behavior.daemonIdleSeconds).toBe(42)
    })

    it('leaves the rest of the settings untouched', () => {
        const { settings } = write('behavior.daemonAlwaysOn', true)
        expect(settings.behavior.daemonAlwaysOn).toBe(true)
        expect(settings.behavior.daemonIdleSeconds).toBe(
            DEFAULT_PLUGIN_SETTINGS.behavior.daemonIdleSeconds
        )
        expect(settings.editors).toEqual(DEFAULT_PLUGIN_SETTINGS.editors)
    })

    it('refuses to invent a field the schema does not define', () => {
        // Materializing the parent would push an object the schema rejects
        // into storage, surfacing as a parse error far from the typo.
        const { settings, landed } = write('behavior.notAField', 1)
        expect(landed).toBe(false)
        expect(settings).toEqual(DEFAULT_PLUGIN_SETTINGS)
    })

    it('refuses a missing intermediate object and an empty key', () => {
        expect(write('nope.deep', 1).landed).toBe(false)
        expect(write('', 1).landed).toBe(false)
        expect(write('behavior.daemonIdleSeconds.tooFar', 1).landed).toBe(false)
    })
})

describe('collectControlKeys', () => {
    it('walks groups, lists and pages in declaration order', () => {
        const tree = [
            { name: 'A', control: { type: 'toggle', key: 'behavior.a' } },
            {
                type: 'group',
                items: [{ name: 'B', control: { type: 'text', key: 'behavior.b' } }]
            },
            {
                type: 'page',
                name: 'Page',
                items: [
                    {
                        type: 'list',
                        items: [{ name: 'C', control: { type: 'slider', key: 'behavior.c' } }]
                    }
                ]
            }
        ]
        expect(collectControlKeys(tree)).toEqual(['behavior.a', 'behavior.b', 'behavior.c'])
    })

    it('ignores action, render and empty definitions', () => {
        const tree = [
            { name: 'Action', action: (): void => {} },
            { name: 'Render', render: (): void => {} },
            { name: 'Empty' },
            { type: 'page', name: 'Imperative', page: (): null => null }
        ]
        expect(collectControlKeys(tree)).toEqual([])
    })
})
