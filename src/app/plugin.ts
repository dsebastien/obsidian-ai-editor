import { Notice, Plugin } from 'obsidian'
import { produce } from 'immer'
import type { Draft } from 'immer'
import { DEFAULT_PLUGIN_SETTINGS, pluginSettingsSchema } from './domain/settings/settings-schema'
import type { PluginSettingsV1 } from './domain/settings/settings-schema'
import { bootstrapSettings } from './settings/settings-bootstrap'
import type { SettingsFacade } from './settings/settings-facade'
import { AIEditorPluginSettingTab } from './settings/settings-tab'
import { findingDecorationsField } from './ui/editor/finding-decorations'
import { findingCountLabel } from './ui/status-bar'
import { registerReviewCurrentNoteCommand } from './commands/review-current-note'
import { registerWhatsNewDialog } from './whats-new'
import { log } from '../utils/log'

/**
 * Plugin lifecycle only: settings load/persist (implementing the
 * `SettingsFacade` the settings tab delegates to), CM6 extension, command
 * and status-bar registration. Feature logic lives in domain/services/ui.
 */
export class AIEditorPlugin extends Plugin implements SettingsFacade {
    /**
     * Versioned, immutable settings value. All mutations go through
     * `update` so validation and persistence happen in exactly one place.
     */
    // No `override`: `Plugin.settings` only exists in API 1.13+ typings and
    // the plugin supports older public releases.
    settings: PluginSettingsV1 = DEFAULT_PLUGIN_SETTINGS

    /**
     * data.json keys unknown to the settings schema, captured at load and
     * carried through every save so sibling features and older plugin
     * versions never lose data.
     */
    private foreignKeys: Record<string, unknown> = {}

    private statusBarEl: HTMLElement | null = null

    override async onload(): Promise<void> {
        log('Initializing', 'debug')
        // Must run before anything can call saveData (fresh-install detection)
        registerWhatsNewDialog(this)
        await this.loadPluginSettings()

        this.addSettingTab(new AIEditorPluginSettingTab(this.app, this))

        // Finding highlights: a StateField mapped through document changes on
        // every transaction; driven by the run orchestration once it lands (M2).
        this.registerEditorExtension(findingDecorationsField)

        this.statusBarEl = this.addStatusBarItem()
        this.setFindingCount(0)

        registerReviewCurrentNoteCommand(this)
    }

    override onunload(): void {
        // SEAM (M2): cancel active runs here (RunController.cancelAll) so
        // in-flight backend requests never outlive the plugin.
    }

    /** `SettingsFacade`: current immutable settings value. */
    getSettings(): PluginSettingsV1 {
        return this.settings
    }

    /**
     * `SettingsFacade`: apply an Immer mutation, validate the result against
     * the settings schema, and persist atomically. A mutation producing a
     * schema-invalid value is rejected (previous settings kept, promise
     * rejects so `commit` surfaces a Notice) — persisting invalid data would
     * make the strict load path wipe it on the next startup.
     */
    async update(mutator: (draft: Draft<PluginSettingsV1>) => void): Promise<void> {
        const next = produce(this.settings, mutator)
        const parsed = pluginSettingsSchema.safeParse(next)
        if (!parsed.success) {
            throw new Error('AI Editor: rejected a settings update that failed schema validation')
        }
        this.settings = parsed.data
        await this.persistSettings()
    }

    /**
     * Status-bar finding counter; hidden while there is nothing to count.
     * Called by the run orchestration wiring as findings arrive (M2).
     */
    setFindingCount(count: number): void {
        if (!this.statusBarEl) {
            return
        }
        const label = findingCountLabel(count)
        if (label === null) {
            this.statusBarEl.hide()
            return
        }
        this.statusBarEl.setText(label)
        this.statusBarEl.show()
    }

    /**
     * Loads persisted settings defensively and seeds the starter pack on
     * first load (persisting the seeded result immediately).
     */
    private async loadPluginSettings(): Promise<void> {
        log('Loading settings', 'debug')
        const raw: unknown = await this.loadData()
        const boot = bootstrapSettings(raw)
        this.settings = boot.settings
        this.foreignKeys = boot.foreignKeys
        if (boot.dropped.length > 0) {
            // Never silent: dropped privacy exclusions would fail-open
            // Business Rule #7, dropped backends would lose API keys.
            log(`Invalid persisted settings reset to defaults: ${boot.dropped.join(', ')}`, 'warn')
            new Notice(
                `AI Editor: some saved settings were invalid and were reset to defaults (${boot.dropped.join(
                    ', '
                )}). Review the plugin settings — especially privacy exclusions.`
            )
        }
        if (boot.needsSave) {
            await this.persistSettings()
        }
        log('Settings loaded', 'debug')
    }

    private async persistSettings(): Promise<void> {
        await this.saveData({ ...this.foreignKeys, ...this.settings })
        log('Settings saved', 'debug')
    }
}
