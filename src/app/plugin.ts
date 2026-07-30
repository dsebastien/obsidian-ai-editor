import { Notice, Platform, Plugin, requireApiVersion } from 'obsidian'
import { produce } from 'immer'
import type { Draft } from 'immer'
import { DEFAULT_PLUGIN_SETTINGS, pluginSettingsSchema } from './domain/settings/settings-schema'
import type { PluginSettingsV1 } from './domain/settings/settings-schema'
import { bootstrapSettings } from './settings/settings-bootstrap'
import { createSettingsNotifier } from './settings/settings-facade'
import type { SettingsFacade, SettingsListener } from './settings/settings-facade'
import { AIEditorPluginSettingTab } from './settings/settings-tab'
import { RunController } from './services/orchestration/run-controller'
import { TransformController } from './services/orchestration/transform-run'
import {
    commentStoreLoadNotice,
    commentStoreLoadSummary
} from './services/comments/comment-repository'
import type { MarginCommentRepository } from './services/comments/comment-repository'
import { createCommentRepository, registerCommentStoreHooks } from './ui/comment-store'
import { CommentJobRegistry } from './services/comments/comment-job-registry'
import { BackgroundRequestGate } from './services/orchestration/background-gate'
import { CommentRunController } from './services/orchestration/comment-run'
import { findingCardExtension } from './ui/editor/finding-card'
import { findingDecorationsField } from './ui/editor/finding-decorations'
import { transformPreviewField } from './ui/editor/transform-preview'
import { registerEditorMenu } from './ui/menus/editor-menu'
import { registerFileMenu } from './ui/menus/file-menu'
import { DaemonController } from './ui/daemon-controller'
import { ReviewController } from './ui/review-controller'
import { REVIEW_PANEL_VIEW_TYPE, ReviewSidePanelView } from './ui/side-panel'
import { findingCountLabel } from './ui/status-bar'
import { SetupWizardModal } from './settings/setup-wizard-modal'
import { registerActionCommands } from './commands/action-commands'
import { registerBulkCommands } from './commands/bulk-commands'
import { registerReviewCommands } from './commands/review-commands'
import { registerSetupCommands } from './commands/setup-commands'
import { registerReviewCli } from './cli/register-review-cli'
import { registerCancelCli, registerStatusCli } from './cli/register-run-cli'
import { CANCEL_CLI_COMMAND } from './services/cli/cancel-cli'
import { REVIEW_CLI_COMMAND } from './services/cli/review-cli'
import { STATUS_CLI_COMMAND } from './services/cli/status-cli'
import { registerWhatsNewView } from './whats-new'
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

    /** Settings mutation observers, notified after every successful persist. */
    private readonly settingsNotifier = createSettingsNotifier()

    private statusBarEl: HTMLElement | null = null

    private runController: RunController | null = null

    private transformController: TransformController | null = null

    private reviewController: ReviewController | null = null

    private daemonController: DaemonController | null = null

    /** Durable margin comments (plan §5.5 / M8); sidecar, not `data.json`. */
    private commentRepository: MarginCommentRepository | null = null

    /** Background comment jobs (plan §5.5 / M8): live runs joined to the store. */
    private commentJobs: CommentJobRegistry | null = null

    private backgroundGate: BackgroundRequestGate | null = null

    override async onload(): Promise<void> {
        log('Initializing', 'debug')
        // Must run before anything can call saveData (fresh-install detection)
        registerWhatsNewView(this)
        await this.loadPluginSettings()
        await this.loadMarginComments()

        this.addSettingTab(new AIEditorPluginSettingTab(this.app, this))

        this.statusBarEl = this.addStatusBarItem()
        this.setFindingCount(0)

        // Review pipeline: run orchestration + per-view UI glue. The finding
        // StateField maps decorations through document changes on every
        // transaction; the controller's update listener feeds the same
        // changes to the domain anchor store; the card extension makes the
        // highlights clickable (Accept routed through the FindingStore
        // precondition via the controller's lookup, Business Rules #3).
        // The controller owns the plugin-wide concurrency gate: at most
        // `behavior.maxConcurrentRequests` backend requests in flight across
        // all runs. Read per acquisition, so settings changes apply to the
        // next request without a reload.
        const runController = new RunController(() => this.settings.behavior.maxConcurrentRequests)
        this.runController = runController
        // Transform/generate runs share the SAME request gate: reviews and
        // actions together never exceed `maxConcurrentRequests`.
        const transformController = new TransformController(runController.requestGate)
        this.transformController = transformController
        const commentJobs = this.createCommentJobRegistry(runController)
        this.commentJobs = commentJobs
        const reviewController = new ReviewController({
            app: this.app,
            plugin: this,
            getSettings: () => this.settings,
            runController,
            transformController,
            setFindingCount: (count) => this.setFindingCount(count),
            ...(commentJobs ? { commentJobs } : {})
        })
        this.reviewController = reviewController
        this.registerEditorExtension([
            findingDecorationsField,
            transformPreviewField,
            reviewController.editorExtension(),
            findingCardExtension(reviewController.findingLookup())
        ])
        this.registerReviewPanelView(reviewController)
        reviewController.initialize()

        // Daemon mode (plan §0, Business Rule #1 carve-out — the settings
        // toggle IS the explicit user action): pure scheduler behind
        // per-file timers; edits arrive via the controller's canonical-view
        // update listener, run state via its refresh cycle, config via the
        // settings observer (toggle + idle delay apply live, off clears all
        // timers). Created after the ReviewController because it dispatches
        // through it; `attachDaemon` closes the cycle.
        const daemonController = new DaemonController({
            getSettings: () => this.settings,
            runController,
            port: reviewController,
            onStateChange: () => reviewController.requestRefresh()
        })
        this.daemonController = daemonController
        reviewController.attachDaemon(daemonController)
        this.register(this.subscribe(() => daemonController.settingsChanged()))

        registerReviewCommands(this, reviewController, this)
        registerSetupCommands(this, this)
        this.openSetupWizardOnFirstRun()
        // Dynamic `action-<bindingId>` commands (design §3): registration
        // follows the settings via the mutation observer — add/removeCommand
        // diffing keeps the palette in sync without a reload.
        registerActionCommands(
            this,
            reviewController,
            () => this.settings,
            (listener) => this.subscribe(listener)
        )
        // Dynamic `accept-all-<editorId>` / `dismiss-all-<editorId>` commands
        // (design §3): registration follows the editor entities, availability
        // is re-checked per invocation against the active note's run.
        registerBulkCommands(
            this,
            reviewController,
            () => this.settings,
            (listener) => this.subscribe(listener)
        )
        registerEditorMenu(this, reviewController, () => this.settings)
        registerFileMenu(this, reviewController)

        // CLI surface (interaction surfaces design §4): desktop-only and
        // gated on the API release that shipped `registerCliHandler`
        // (1.12.2). Runtime-guarded so `minAppVersion` stays untouched —
        // older public releases simply have no CLI surface.
        if (Platform.isDesktop && requireApiVersion('1.12.2')) {
            // `registerCliHandler` throws when the command is still
            // registered by a dying instance (double-load race — same
            // failure mode `registerReviewPanelView` heals). There is no
            // public unregister API, so degrade per subcommand: skip that
            // CLI surface for this session instead of failing the whole
            // plugin load.
            const guardCliRegistration = (command: string, register: () => void): void => {
                try {
                    register()
                } catch (error) {
                    log(
                        `CLI command ${command} still registered from a previous load — continuing without it (${String(error)})`,
                        'warn'
                    )
                }
            }
            guardCliRegistration(REVIEW_CLI_COMMAND, () =>
                registerReviewCli({
                    plugin: this,
                    runController,
                    reviewController,
                    getSettings: () => this.settings
                })
            )
            guardCliRegistration(CANCEL_CLI_COMMAND, () =>
                registerCancelCli({ plugin: this, runController })
            )
            guardCliRegistration(STATUS_CLI_COMMAND, () =>
                registerStatusCli({ plugin: this, runController })
            )
        }
    }

    /**
     * Opens the setup wizard once, on the first load that has never seen it
     * (`onboarded === false`, plan M5).
     *
     * Deferred to `onLayoutReady`: a modal thrown up while the workspace is
     * still restoring lands behind the restoring leaves and steals focus from
     * whatever the user was doing. The wizard marks `onboarded` on ANY exit, so
     * this can never become a nag — and it never collides with the "What's new"
     * tab, which by design does not open on a fresh install.
     */
    private openSetupWizardOnFirstRun(): void {
        if (this.settings.onboarded) {
            return
        }
        this.app.workspace.onLayoutReady(() => {
            // Re-checked: a wizard run from the palette during startup, or a
            // synced data.json arriving meanwhile, may have set the flag.
            if (this.settings.onboarded) {
                return
            }
            new SetupWizardModal(this.app, this).open()
        })
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
                (leaf) => new ReviewSidePanelView(leaf, () => reviewController.getPanelState())
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
        // Background comment jobs first, and in this order: every in-flight
        // job dies with the process, so it is recorded as `interrupted` BEFORE
        // the store is flushed. A job written as `running` would come back
        // next session claiming to be alive; `interrupted` is the state that
        // offers Retry and never fakes a resumption (plan M8).
        this.commentJobs?.interruptAll()
        this.commentJobs?.dispose()
        this.commentJobs = null
        this.backgroundGate?.dispose()
        this.backgroundGate = null
        // Then the durable store: `flush` cancels the deferred write and
        // performs it now. `onunload` is synchronous in Obsidian, so this can
        // only be fire-and-forget — which is why the debounce is short.
        void this.commentRepository?.flush()
        this.commentRepository = null
        // Daemon timers next (no NEW timer can fire mid-teardown; a dispatch
        // already mid-flight in the review pipeline aborts via `abortWhen`'s
        // disposed check before it could start a run), then
        // rails/subscriptions, then abort every in-flight backend request so
        // nothing outlives the plugin.
        this.daemonController?.dispose()
        this.daemonController = null
        this.reviewController?.dispose()
        this.reviewController = null
        this.transformController?.cancelAll()
        this.transformController = null
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
     * `SettingsFacade`: mutation observer, notified after every successful
     * persist (user mutations AND load-time repairs). Dynamic surfaces
     * (command registration diffing, menus) re-derive their state from
     * `getSettings()` on each notification.
     */
    subscribe(listener: SettingsListener): () => void {
        return this.settingsNotifier.subscribe(listener)
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

    /**
     * Reads the durable margin-comment sidecar and keeps it following the
     * vault. Never fatal: an unreadable store is preserved and reported, and
     * the plugin loads with an empty one rather than not at all.
     */
    private async loadMarginComments(): Promise<void> {
        const repository = createCommentRepository(this)
        this.commentRepository = repository
        registerCommentStoreHooks(this, repository)
        const report = await repository.load()
        log(`Margin comments: ${commentStoreLoadSummary(report)}`, 'debug')
        const notice = commentStoreLoadNotice(report)
        if (notice !== null) {
            log(notice, 'warn')
            new Notice(notice)
        }
    }

    /**
     * Builds the background comment-job registry over the loaded store.
     *
     * `null` when the store could not be created at all — the plugin keeps
     * working, it simply has no background comments. The background gate wraps
     * the SAME plugin-wide request gate the reviews use, so a parked comment
     * counts against `behavior.maxConcurrentRequests` while never queueing
     * ahead of a review the user is watching.
     */
    private createCommentJobRegistry(runController: RunController): CommentJobRegistry | null {
        const repository = this.commentRepository
        if (!repository) {
            return null
        }
        const gate = new BackgroundRequestGate({
            gate: runController.requestGate,
            getLimit: () => this.settings.behavior.maxConcurrentRequests,
            // Timers per AGENTS.md: `window.*`, declared as plain numbers.
            setTimer: (callback, ms) => window.setTimeout(callback, ms),
            clearTimer: (handle) => {
                window.clearTimeout(handle)
            }
        })
        this.backgroundGate = gate
        return new CommentJobRegistry({
            repository,
            runs: new CommentRunController(gate),
            setTicker: (callback, ms) => window.setInterval(callback, ms),
            clearTicker: (handle) => {
                window.clearInterval(handle)
            }
        })
    }

    private async persistSettings(): Promise<void> {
        await this.saveData({ ...this.foreignKeys, ...this.settings })
        log('Settings saved', 'debug')
        this.settingsNotifier.notify()
    }
}
