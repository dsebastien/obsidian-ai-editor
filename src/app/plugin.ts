import { Notice, Plugin } from 'obsidian'
import { produce } from 'immer'
import type { Draft } from 'immer'
import { DEFAULT_PLUGIN_SETTINGS, pluginSettingsSchema } from './domain/settings/settings-schema'
import type { PluginSettingsV1 } from './domain/settings/settings-schema'
import { bootstrapSettings } from './settings/settings-bootstrap'
import type { SettingsFacade } from './settings/settings-facade'
import { AIEditorPluginSettingTab } from './settings/settings-tab'
import { RunController } from './services/orchestration/run-controller'
import { findingCardExtension } from './ui/editor/finding-card'
import { findingDecorationsField } from './ui/editor/finding-decorations'
import { ReviewController } from './ui/review-controller'
import { REVIEW_PANEL_VIEW_TYPE, ReviewSidePanelView } from './ui/side-panel'
import { findingCountLabel } from './ui/status-bar'
import { registerReviewCommands } from './commands/review-current-note'
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

    private runController: RunController | null = null

    private reviewController: ReviewController | null = null

    override async onload(): Promise<void> {
        log('Initializing', 'debug')
        // Must run before anything can call saveData (fresh-install detection)
        registerWhatsNewDialog(this)
        await this.loadPluginSettings()

        this.addSettingTab(new AIEditorPluginSettingTab(this.app, this))

        this.statusBarEl = this.addStatusBarItem()
        this.setFindingCount(0)

        // Review pipeline: run orchestration + per-view UI glue. The finding
        // StateField maps decorations through document changes on every
        // transaction; the controller's update listener feeds the same
        // changes to the domain anchor store; the card extension makes the
        // highlights clickable (Accept routed through the FindingStore
        // precondition via the controller's lookup, Business Rules #3).
        this.runController = new RunController()
        const reviewController = new ReviewController({
            app: this.app,
            plugin: this,
            getSettings: () => this.settings,
            runController: this.runController,
            setFindingCount: (count) => this.setFindingCount(count)
        })
        this.reviewController = reviewController
        this.registerEditorExtension([
            findingDecorationsField,
            reviewController.editorExtension(),
            findingCardExtension(reviewController.findingLookup())
        ])
        this.registerReviewPanelView(reviewController)
        reviewController.initialize()
        registerReviewCommands(this, reviewController)
    }

    /**
     * Registers the side-panel view, healing the double-load race: when two
     * loads overlap (hot-reload + manual reload), the dying instance's view
     * registration can still be up, and `registerView` throws — which used
     * to abort `onload` and leave the plugin dead. If that happens, drop the
     * stale registration (private `viewRegistry` API, guarded defensively)
     * and retry once so the creator is bound to THIS instance.
     */
    private registerReviewPanelView(reviewController: ReviewController): void {
        const doRegister = (): void => {
            this.registerView(
                REVIEW_PANEL_VIEW_TYPE,
                (leaf) => new ReviewSidePanelView(leaf, () => reviewController.getPanelBinding())
            )
        }
        try {
            doRegister()
        } catch (error) {
            log(
                `View type still registered from a previous load — healing (${String(error)})`,
                'warn'
            )
            const registry = (
                this.app as unknown as {
                    viewRegistry?: { unregisterView?: (type: string) => void }
                }
            ).viewRegistry
            if (typeof registry?.unregisterView === 'function') {
                registry.unregisterView(REVIEW_PANEL_VIEW_TYPE)
                doRegister()
            }
            // Without the private API the panel stays bound to the dead
            // instance for this session; everything else keeps working.
        }
    }

    override onunload(): void {
        // Rails, subscriptions and timers go first; then abort every
        // in-flight backend request so nothing outlives the plugin.
        this.reviewController?.dispose()
        this.reviewController = null
        this.runController?.cancelAll()
        this.runController = null
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
        if (boot.regeneratedIds.length > 0) {
            // Sync-merge artifact: duplicated entity ids can route note
            // content and the wrong API key to a different endpoint than
            // the UI displays — resolved keep-first, later ids regenerated.
            log(`Duplicate entity ids regenerated: ${boot.regeneratedIds.join(', ')}`, 'warn')
            new Notice(
                `AI Editor: duplicate entity ids were found in the saved settings (likely a sync conflict) and were repaired (${boot.regeneratedIds.join(
                    ', '
                )}). Review the plugin settings — especially backend assignments.`
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
