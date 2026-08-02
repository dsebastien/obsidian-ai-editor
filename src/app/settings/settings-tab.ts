import { PluginSettingTab } from 'obsidian'
import type { App, Plugin } from 'obsidian'
import { BUY_ME_A_COFFEE_BADGE_DATA_URL } from '../assets/buy-me-a-coffee'
import { BUY_ME_A_COFFEE_URL, renderSupportSection } from '../ui/support-links'
import { createSettingsFacade } from './settings-facade'
import type { SettingsFacade } from './settings-facade'
import { renderBackendsTab } from './tabs/backends-tab'
import { renderEditorsTab } from './tabs/editors-tab'
import { renderPanelsTab } from './tabs/panels-tab'
import { renderActionsTab } from './tabs/actions-tab'
import { renderVoiceTab } from './tabs/voice-tab'
import { renderRulesTab } from './tabs/rules-tab'
import { renderBehaviorTab } from './tabs/behavior-tab'
import type { TabContext } from './tabs/shared'
import { isTabNavigationKey, nextTabIndex } from './tab-keyboard'

/**
 * The plugin instance as the settings tab sees it. When the plugin
 * implements the facade itself (`getSettings` + `update` over the versioned
 * settings schema), the tab delegates to it; until then the tab manages
 * persistence through `loadData`/`saveData` with a fallback facade that
 * preserves foreign keys in `data.json`.
 */
export type SettingsTabPlugin = Plugin & Partial<SettingsFacade>

interface SettingsTabDefinition {
    readonly id: string
    readonly label: string
    readonly render: (containerEl: HTMLElement, ctx: TabContext) => void
}

const SETTINGS_TABS: readonly SettingsTabDefinition[] = [
    { id: 'backends', label: 'Backends', render: renderBackendsTab },
    { id: 'editors', label: 'Editors', render: renderEditorsTab },
    { id: 'panels', label: 'Panels', render: renderPanelsTab },
    { id: 'actions', label: 'Actions', render: renderActionsTab },
    { id: 'voice', label: 'Voice & style', render: renderVoiceTab },
    { id: 'rules', label: 'Rules', render: renderRulesTab },
    { id: 'behavior', label: 'Behavior', render: renderBehaviorTab }
]

/** DOM id of one tab button — the `aria-labelledby` target of its panel. */
function tabDomId(tabId: string): string {
    return `editor-ai-daemons-settings-tab-${tabId}`
}

/**
 * DOM id of the ONE tab panel. Constant on purpose: `renderAll` creates a
 * single panel element and re-renders its contents on every tab change, so a
 * per-tab id would make six of the seven `aria-controls` point at ids that are
 * not in the document — a dangling reference on every inactive tab, which is
 * worse than none. The panel says which tab it belongs to through
 * `aria-labelledby`, re-pointed at the active tab button each render.
 */
const SETTINGS_PANEL_DOM_ID = 'editor-ai-daemons-settings-panel'

/**
 * Tabbed settings tab (Backends / Editors / Panels / Actions / Voice & style
 * / Rules / Behavior). The active tab lives in memory only — reopening the
 * settings within a session restores it; restarting Obsidian resets it.
 *
 * NOTE: member names deliberately avoid Obsidian `SettingTab` reserved names
 * (`update`, `settingItems`, `getControlValue`, …) — see AGENTS.md.
 */
export class AIEditorPluginSettingTab extends PluginSettingTab {
    plugin: SettingsTabPlugin
    private readonly facade: SettingsFacade
    private activeTabId: string
    private tabVisible = false
    /** True while a re-render was caused by the user moving between tabs. */
    private pendingTabFocus = false

    constructor(app: App, plugin: SettingsTabPlugin) {
        super(app, plugin)
        this.plugin = plugin
        const created = createSettingsFacade(plugin)
        this.facade = created.facade
        this.activeTabId = SETTINGS_TABS[0]?.id ?? 'backends'
        // Re-render once persisted settings are loaded, if the tab is open.
        void created.ready.then(() => {
            if (this.tabVisible) {
                this.renderAll()
            }
        })
    }

    override display(): void {
        this.tabVisible = true
        this.renderAll()
    }

    override hide(): void {
        this.tabVisible = false
        super.hide()
    }

    private renderAll(): void {
        const { containerEl } = this
        containerEl.empty()

        const tabBar = containerEl.createDiv({
            cls: 'editor-ai-daemons-settings-tabbar',
            attr: { 'role': 'tablist', 'aria-label': 'AI Editor settings sections' }
        })
        const activeIndex = Math.max(
            0,
            SETTINGS_TABS.findIndex((tab) => tab.id === this.activeTabId)
        )
        const content = containerEl.createDiv({
            cls: 'editor-ai-daemons-settings-content',
            attr: {
                'role': 'tabpanel',
                // Programmatically focusable so activating a tab can put focus
                // on the section it just revealed — see `selectTab`.
                'tabindex': '-1',
                'id': SETTINGS_PANEL_DOM_ID,
                'aria-labelledby': tabDomId(this.activeTabId)
            }
        })

        let activeButton: HTMLElement | null = null
        SETTINGS_TABS.forEach((tab, index) => {
            const isActive = index === activeIndex
            const button = tabBar.createEl('button', {
                cls: isActive
                    ? 'editor-ai-daemons-settings-tab is-active'
                    : 'editor-ai-daemons-settings-tab',
                text: tab.label,
                attr: {
                    'role': 'tab',
                    'type': 'button',
                    'id': tabDomId(tab.id),
                    'aria-selected': String(isActive),
                    'aria-controls': SETTINGS_PANEL_DOM_ID,
                    // Roving tabindex: ONE stop for the whole bar. Tab moves
                    // past the tablist to the settings themselves, arrows move
                    // within it — the ARIA tabs pattern, and the reason the
                    // arrow handler below is not optional once `role=tab` is
                    // on these buttons.
                    'tabindex': isActive ? '0' : '-1'
                }
            })
            if (isActive) {
                activeButton = button
            }
            button.addEventListener('click', () => {
                this.selectTab(tab.id)
            })
            button.addEventListener('keydown', (event: KeyboardEvent) => {
                if (!isTabNavigationKey(event.key)) {
                    return
                }
                event.preventDefault()
                const target = nextTabIndex(event.key, index, SETTINGS_TABS.length)
                const next = SETTINGS_TABS[target]
                if (next) {
                    this.selectTab(next.id)
                }
            })
        })

        const activeTab = SETTINGS_TABS[activeIndex]
        if (activeTab) {
            const ctx: TabContext = {
                app: this.app,
                facade: this.facade,
                refresh: () => this.renderAll()
            }
            activeTab.render(content, ctx)
        }

        // Outside the tab panel on purpose: the support section belongs to no
        // section, so putting it in one would hide it from everybody who never
        // opens that section — and would make it part of the panel a screen
        // reader announces for the tab.
        this.renderSupport(containerEl)

        this.restoreTabFocus(activeButton)
    }

    /**
     * The support calls to action. Wording and URLs live in
     * `ui/support-links.ts` — the one place the whole plugin collection shares
     * — so this tab renders exactly what the "What's new" tab, the README and
     * the docs site say. Only the Buy me a coffee badge is plugin-local (the
     * image asset is), which is why it arrives as a callback.
     */
    private renderSupport(containerEl: HTMLElement): void {
        renderSupportSection(containerEl, (el) => {
            this.renderBuyMeACoffeeBadge(el)
        })
    }

    /** The Buy me a coffee badge, as an image link. */
    private renderBuyMeACoffeeBadge(contentEl: HTMLElement): void {
        const linkEl = contentEl.createEl('a', { href: BUY_ME_A_COFFEE_URL })
        const imgEl = linkEl.createEl('img')
        imgEl.src = BUY_ME_A_COFFEE_BADGE_DATA_URL
        imgEl.alt = 'Buy me a coffee'
        imgEl.width = 175
    }

    /**
     * Switches tabs and re-renders. Selection FOLLOWS focus (the pattern's
     * default for a bar whose panels are cheap to build), so an arrow key
     * both moves and activates — one gesture, and the panel under the tab is
     * always the one being announced.
     */
    private selectTab(tabId: string): void {
        if (this.activeTabId === tabId) {
            return
        }
        this.activeTabId = tabId
        this.pendingTabFocus = true
        this.renderAll()
    }

    /**
     * `renderAll` empties the whole container, so the element the user was
     * standing on is destroyed along with everything else — focus falls back
     * to the document and a keyboard user loses the bar entirely after one
     * arrow press. Focus is put back on the tab they moved to, and only when
     * the re-render came from THEIR action (never on the load-time re-render,
     * which would steal focus from wherever they had got to).
     */
    private restoreTabFocus(activeButton: HTMLElement | null): void {
        if (!this.pendingTabFocus) {
            return
        }
        this.pendingTabFocus = false
        activeButton?.focus()
    }
}
