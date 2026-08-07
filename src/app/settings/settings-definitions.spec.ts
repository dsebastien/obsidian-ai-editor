/**
 * The dot-path guard for the declarative settings tree (issue #35).
 *
 * `SettingDefinitionControl` addresses its value by an opaque string `key`,
 * which `settings-tab.ts` resolves as a DOT PATH into `PluginSettingsV1`. That
 * is the one stringly-typed seam the declarative API introduces: a typo does
 * not fail to compile, it produces a control that reads `undefined` forever
 * (the framework silently falls back to the declared default) and whose writes
 * are refused by `writeControlValue`. Nothing on screen says so.
 *
 * So this spec builds the WHOLE definition tree the settings tab returns —
 * every one of the seven page modules, called exactly as `getSettingDefinitions`
 * calls them — collects every declared control key, and asserts each resolves
 * to a defined value in the parsed defaults. A misspelled path is a failing
 * test here rather than a dead control in a released build.
 *
 * The tree is built twice: once against `DEFAULT_PLUGIN_SETTINGS` (empty
 * collections) and once against the starter pack (editors, panels, actions and
 * rules present), because the collection pages only emit their per-entity rows
 * when there is an entity to emit them for.
 *
 * `obsidian` is never imported here at runtime — the page modules reach it for
 * `Notice`/`Menu`/`Modal`, which `src/test-setup.ts` mocks globally (bun test
 * has no Obsidian). Only types are imported, and only structurally: the tree is
 * walked by `collectControlKeys`, which types it as `unknown` for that reason.
 */

import { describe, expect, it } from 'bun:test'
import type { App } from 'obsidian'
import { produce } from 'immer'
import { collectControlKeys, readControlValue } from './control-bindings'
import { DEFAULT_PLUGIN_SETTINGS, pluginSettingsSchema } from '../domain/settings/settings-schema'
import type { PluginSettingsV1 } from '../domain/settings/settings-schema'
import { seedStarterPack } from '../domain/settings/starter-pack'
import type { SettingsFacade } from './settings-facade'
import type { TabContext } from './tabs/shared'
import { backendsPageItems } from './tabs/backends-tab'
import { editorsPageItems } from './tabs/editors-tab'
import { panelsPageItems } from './tabs/panels-tab'
import { actionsPageItems } from './tabs/actions-tab'
import { voicePageItems } from './tabs/voice-tab'
import { rulesPageItems } from './tabs/rules-tab'
import { behaviorPageItems } from './tabs/behavior-tab'

/**
 * A `TabContext` over a fixed settings object. Writes go through Immer exactly
 * as the real facade does, so a page module that mutates while BUILDING its
 * definitions (it must not) shows up as a changed snapshot rather than passing
 * silently. `app` is an empty object: every page module treats a missing
 * Starter Kit / workspace as "feature absent" and degrades, which is the shape
 * a headless run has.
 */
function buildContext(initial: PluginSettingsV1): TabContext {
    let settings = initial
    const facade: SettingsFacade = {
        getSettings: () => settings,
        update: async (mutator) => {
            settings = produce(settings, mutator)
        },
        subscribe: () => () => {}
    }
    return {
        // Headless stand-in: the page modules only feature-detect on `app`.
        app: {} as unknown as App,
        facade,
        refresh: () => {}
    }
}

/**
 * The tree `AIEditorPluginSettingTab.getSettingDefinitions` returns, minus the
 * support row (it declares no control and needs the tab instance to render).
 * Kept in the same page order so a reader can line the two up.
 */
function buildDefinitions(settings: PluginSettingsV1): unknown[] {
    const ctx = buildContext(settings)
    return [
        { type: 'page', name: 'Backends', items: backendsPageItems(ctx) },
        { type: 'page', name: 'Editors', items: editorsPageItems(ctx) },
        { type: 'page', name: 'Panels', items: panelsPageItems(ctx) },
        { type: 'page', name: 'Actions', items: actionsPageItems(ctx) },
        { type: 'page', name: 'Voice & style', items: voicePageItems(ctx) },
        { type: 'page', name: 'Rules', items: rulesPageItems(ctx) },
        { type: 'page', name: 'Behavior', items: behaviorPageItems(ctx) }
    ]
}

/** The parsed defaults every declared key must address. */
const parsedDefaults = pluginSettingsSchema.parse({})

const populated = seedStarterPack(DEFAULT_PLUGIN_SETTINGS)

describe('settings definitions', () => {
    it('builds every page against the defaults', () => {
        const definitions = buildDefinitions(DEFAULT_PLUGIN_SETTINGS)
        expect(definitions).toHaveLength(7)
    })

    it('declares every control key as a resolvable path into the parsed defaults', () => {
        const keys = collectControlKeys(buildDefinitions(DEFAULT_PLUGIN_SETTINGS))

        // A tree that declares nothing would pass the loop below vacuously.
        expect(keys.length).toBeGreaterThan(0)

        const unresolvable = keys.filter(
            (key) => readControlValue(parsedDefaults, key) === undefined
        )
        expect(unresolvable).toEqual([])
    })

    it('declares every control key as resolvable with the collections populated', () => {
        // The collection pages emit their per-entity rows only when entities
        // exist, so the empty-defaults pass above never reaches them.
        expect(populated.editors.length).toBeGreaterThan(0)
        expect(populated.actions.length).toBeGreaterThan(0)

        const keys = collectControlKeys(buildDefinitions(populated))
        const unresolvable = keys.filter(
            (key) => readControlValue(parsedDefaults, key) === undefined
        )
        expect(unresolvable).toEqual([])
    })

    it('declares each control key at most once', () => {
        // Two controls bound to the same path would fight over the same value:
        // editing one leaves the other showing a stale reading until the pane
        // is rebuilt.
        const keys = collectControlKeys(buildDefinitions(populated))
        expect(keys).toEqual([...new Set(keys)])
    })

    it('builds the definitions without mutating the settings', () => {
        const ctx = buildContext(DEFAULT_PLUGIN_SETTINGS)
        backendsPageItems(ctx)
        editorsPageItems(ctx)
        panelsPageItems(ctx)
        actionsPageItems(ctx)
        voicePageItems(ctx)
        rulesPageItems(ctx)
        behaviorPageItems(ctx)
        expect(ctx.facade.getSettings()).toEqual(DEFAULT_PLUGIN_SETTINGS)
    })
})
