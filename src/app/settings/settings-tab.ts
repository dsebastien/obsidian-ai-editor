import { PluginSettingTab } from 'obsidian'
import type { App, Plugin } from 'obsidian'
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
            cls: 'ai-editor-settings-tabbar',
            attr: { 'role': 'tablist', 'aria-label': 'AI Editor settings sections' }
        })
        const content = containerEl.createDiv({ cls: 'ai-editor-settings-content' })

        for (const tab of SETTINGS_TABS) {
            const isActive = tab.id === this.activeTabId
            const button = tabBar.createEl('button', {
                cls: isActive ? 'ai-editor-settings-tab is-active' : 'ai-editor-settings-tab',
                text: tab.label,
                attr: { 'role': 'tab', 'type': 'button', 'aria-selected': String(isActive) }
            })
            button.addEventListener('click', () => {
                if (this.activeTabId === tab.id) {
                    return
                }
                this.activeTabId = tab.id
                this.renderAll()
            })
        }

        const activeTab =
            SETTINGS_TABS.find((tab) => tab.id === this.activeTabId) ?? SETTINGS_TABS[0]
        if (!activeTab) {
            return
        }
        const ctx: TabContext = {
            app: this.app,
            facade: this.facade,
            refresh: () => this.renderAll()
        }
        activeTab.render(content, ctx)
    }
}
