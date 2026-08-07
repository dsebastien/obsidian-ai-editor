import { Notice, PluginSettingTab } from 'obsidian'
import type { App, Plugin, SettingDefinitionItem } from 'obsidian'
import { BUY_ME_A_COFFEE_BADGE_DATA_URL } from '../assets/buy-me-a-coffee'
import { BUY_ME_A_COFFEE_URL, renderSupportSection } from '../ui/support-links'
import { readControlValue, writeControlValue } from './control-bindings'
import { createSettingsFacade } from './settings-facade'
import type { SettingsFacade } from './settings-facade'
import { backendsPageItems } from './tabs/backends-tab'
import { editorsPageItems } from './tabs/editors-tab'
import { panelsPageItems } from './tabs/panels-tab'
import { actionsPageItems } from './tabs/actions-tab'
import { voicePageItems } from './tabs/voice-tab'
import { rulesPageItems } from './tabs/rules-tab'
import { behaviorPageItems } from './tabs/behavior-tab'
import type { TabContext } from './tabs/shared'

/**
 * The plugin instance as the settings tab sees it. When the plugin
 * implements the facade itself (`getSettings` + `update` over the versioned
 * settings schema), the tab delegates to it; until then the tab manages
 * persistence through `loadData`/`saveData` with a fallback facade that
 * preserves foreign keys in `data.json`.
 */
export type SettingsTabPlugin = Plugin & Partial<SettingsFacade>

/**
 * Settings tab, declared rather than rendered (issue #35).
 *
 * `getSettingDefinitions` returns one `page` per former tab — Backends,
 * Editors, Panels, Actions, Voice & style, Rules, Behavior — in the order the
 * hand-built tab bar used. Obsidian owns navigation, focus and the ARIA
 * plumbing from here on, and indexes every declared `name`/`desc` so a setting
 * is reachable from the settings search without knowing which page holds it.
 *
 * Scalars declared as `control` definitions are addressed by DOT PATH into
 * `PluginSettingsV1`; `getControlValue`/`setControlValue` below are the two
 * ends of that bridge (see `control-bindings.ts`). Every write still goes
 * through the facade's `update`, the single persistence path — the declarative
 * API changed how settings are described, not how they are stored.
 *
 * NOTE: member names deliberately avoid Obsidian `SettingTab` reserved names.
 * That constraint is no longer theoretical: this class overrides `update`'s
 * callers, `getSettingDefinitions`, `getControlValue` and `setControlValue`,
 * and inherits `settingItems`, `refreshDomState`, `display` and `hide` — so a
 * private helper named after any of them would shadow framework behaviour
 * rather than merely look confusing.
 */
export class AIEditorPluginSettingTab extends PluginSettingTab {
    plugin: SettingsTabPlugin
    private readonly facade: SettingsFacade

    /** Clears review history (issue #21); wired by the plugin after load. */
    clearHistory: (() => void) | undefined

    constructor(app: App, plugin: SettingsTabPlugin) {
        super(app, plugin)
        this.plugin = plugin
        const created = createSettingsFacade(plugin)
        this.facade = created.facade
        // Settings arrive asynchronously; re-read the definitions once they do
        // so both the rendered pane and the search index reflect them.
        void created.ready.then(() => {
            this.update()
        })
    }

    override getSettingDefinitions(): SettingDefinitionItem[] {
        const ctx = this.buildContext()
        return [
            { type: 'page', name: 'Backends', items: backendsPageItems(ctx) },
            { type: 'page', name: 'Editors', items: editorsPageItems(ctx) },
            { type: 'page', name: 'Panels', items: panelsPageItems(ctx) },
            { type: 'page', name: 'Actions', items: actionsPageItems(ctx) },
            { type: 'page', name: 'Voice & style', items: voicePageItems(ctx) },
            { type: 'page', name: 'Rules', items: rulesPageItems(ctx) },
            { type: 'page', name: 'Behavior', items: behaviorPageItems(ctx) },
            this.supportItem()
        ]
    }

    /**
     * Reads the value behind a `control` key. The key is a dot path into
     * `PluginSettingsV1`; an unresolvable one yields `undefined`, which the
     * framework reads as "use the declared default" rather than throwing
     * mid-render (`control-bindings.spec.ts` is what stops that degradation
     * from going unnoticed).
     */
    override getControlValue(key: string): unknown {
        return readControlValue(this.facade.getSettings(), key)
    }

    /**
     * Persists a `control` edit through the facade — the same `update` every
     * other settings surface uses, so the value is schema-validated and
     * saved in exactly one place.
     *
     * Two distinct failures are surfaced the same way: `update` rejecting
     * (the write never landed on disk — e.g. zod refused the value, or the
     * save failed) and `writeControlValue` refusing the path (the key
     * addresses a field the schema does not define, so nothing was mutated).
     *
     * Both then REJECT the returned promise rather than resolving it. A
     * fulfilled promise tells the framework the write succeeded, so it keeps
     * the control showing a value that was never stored — the transient Notice
     * scrolls away and the pane goes on lying until something forces a
     * re-render (adversarial review, 2026-08-07). Rejecting lets the framework
     * roll the control back to `getControlValue`'s answer, which is the truth.
     */
    override async setControlValue(key: string, value: unknown): Promise<void> {
        let landed = false
        try {
            await this.facade.update((draft) => {
                landed = writeControlValue(draft, key, value)
            })
        } catch (error) {
            new Notice('AI Editor: failed to save settings.')
            throw error
        }
        if (!landed) {
            new Notice('AI Editor: failed to save settings.')
            throw new Error(`Setting "${key}" does not address a known field.`)
        }
    }

    /**
     * Everything a page module needs. Rebuilt on every `getSettingDefinitions`
     * call so `clearHistory` — wired by the plugin AFTER construction — is
     * picked up, and so `refresh` re-reads the definitions (`update`) rather
     * than re-running a render of our own: the framework owns the DOM now.
     */
    private buildContext(): TabContext {
        return {
            app: this.app,
            facade: this.facade,
            refresh: (): void => {
                this.update()
            },
            ...(this.clearHistory ? { clearHistory: this.clearHistory } : {})
        }
    }

    /**
     * The support calls to action, at the root of the tree rather than inside
     * a page: they belong to no section, so burying them in one would hide
     * them from everybody who never opens that section.
     *
     * A `render` escape hatch because `renderSupportSection` builds its own
     * `Setting` rows — wording and URLs live in `ui/support-links.ts`, the one
     * place the whole plugin collection shares, so this tab shows exactly what
     * the "What's new" tab, the README and the docs site say. Only the Buy me
     * a coffee badge is plugin-local (the image asset is), which is why it
     * arrives as a callback. The row Obsidian created for the definition is
     * removed: the section renders into the group itself.
     */
    private supportItem(): SettingDefinitionItem {
        return {
            name: 'Support',
            // Not a setting: keeping it out of search stops it answering
            // queries that are looking for something configurable.
            searchable: false,
            render: (setting, group): void => {
                renderSupportSection(group.listEl, (el) => {
                    this.renderBuyMeACoffeeBadge(el)
                })
                setting.settingEl.remove()
            }
        }
    }

    /** The Buy me a coffee badge, as an image link. */
    private renderBuyMeACoffeeBadge(contentEl: HTMLElement): void {
        const linkEl = contentEl.createEl('a', { href: BUY_ME_A_COFFEE_URL })
        const imgEl = linkEl.createEl('img')
        imgEl.src = BUY_ME_A_COFFEE_BADGE_DATA_URL
        imgEl.alt = 'Buy me a coffee'
        imgEl.width = 175
    }
}
