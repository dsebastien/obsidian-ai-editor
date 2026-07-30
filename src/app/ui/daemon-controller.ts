import type { PluginSettingsV1 } from '../domain/settings/settings-schema'
import { DaemonScheduler } from '../services/daemon/daemon-scheduler'
import type { DaemonFireProbe } from '../services/daemon/daemon-scheduler'
import type { RunController } from '../services/orchestration/run-controller'
import { log } from '../../utils/log'

/**
 * Daemon-mode Obsidian glue: owns one real timer per file over the pure
 * `DaemonScheduler` (which holds the whole trigger contract, spec-covered)
 * and dispatches refreshes through the shared review pipeline.
 *
 * Wiring (see `plugin.ts`):
 * - `ReviewController.handleEditorUpdate` — the canonical-view update
 *   listener that already sees every document change exactly once per file —
 *   calls `recordEdit`; no second CM6 listener exists.
 * - `ReviewController.refreshGlue` reports live run state (`syncRunState`) so
 *   user summons, CLI runs, daemon runs and per-editor retries all coalesce
 *   identically.
 * - The settings observer calls `settingsChanged` (toggle + idle delay apply
 *   live; turning the mode off clears every timer).
 * - Timers are keyed by file PATH, never by view — popouts and split panes
 *   share one schedule per file (`fileClosed` fires only when the last view
 *   showing the file goes away, plus on vault delete/rename).
 *
 * Everything decision-shaped lives in the scheduler; this class only probes
 * live facts (run state, reviewability, current text) and moves timers.
 */

/** The surface the daemon needs from the `ReviewController`. */
export interface DaemonReviewPort {
    /** Shared reviewability predicate (exclusions + dispatchable editors). */
    canReviewPath(path: string): boolean
    /** Live-buffer hash + word count; null when the note is not open. */
    probeDaemonNote(path: string): { readonly hash: string; readonly wordCount: number } | null
    /**
     * Dispatches a whole-note daemon review through the shared `startReview`
     * pipeline (silent: no Notices, no size modal, no panel activation).
     */
    startDaemonReview(
        path: string,
        editorIds: readonly string[] | null,
        panelId: string | null
    ): Promise<'started' | 'refused'>
}

export interface DaemonControllerDeps {
    readonly getSettings: () => PluginSettingsV1
    readonly runController: RunController
    readonly port: DaemonReviewPort
    /** Armed-state changed for some file — refresh the rail indicator. */
    readonly onStateChange: () => void
    readonly now?: () => number
}

export class DaemonController {
    private readonly deps: DaemonControllerDeps
    private readonly scheduler = new DaemonScheduler()
    private readonly timers = new Map<string, number>()
    private readonly now: () => number
    private disposed = false

    constructor(deps: DaemonControllerDeps) {
        this.deps = deps
        this.now = deps.now ?? ((): number => Date.now())
        this.scheduler.setConfig(this.readConfig())
    }

    /** One document change of `path` (canonical view, exactly once). */
    recordEdit(path: string): void {
        if (this.disposed) {
            return
        }
        this.scheduler.recordEdit(path, this.now())
        this.syncTimer(path)
    }

    /** Live run state for `path` (reported on every refresh cycle). */
    syncRunState(path: string, inFlight: boolean): void {
        if (this.disposed) {
            return
        }
        this.scheduler.syncRunState(path, inFlight, this.now())
        this.syncTimer(path)
    }

    /** Last view showing `path` closed, or the file was deleted/renamed. */
    fileClosed(path: string): void {
        this.scheduler.fileClosed(path)
        this.clearTimer(path)
    }

    /** Settings observer entry: re-reads the daemon config live. */
    settingsChanged(): void {
        if (this.disposed) {
            return
        }
        const armedBefore = this.scheduler.armedPaths()
        this.scheduler.setConfig(this.readConfig())
        // Off: the scheduler cleared its arms — drop every real timer too.
        // On/idle change: re-derive each pending timer from the new config.
        for (const path of armedBefore) {
            this.syncTimer(path)
        }
        for (const path of this.scheduler.armedPaths()) {
            this.syncTimer(path)
        }
        this.deps.onStateChange()
    }

    /** Whether a daemon refresh is armed for `path` (rail indicator). */
    isArmed(path: string): boolean {
        return this.scheduler.nextDueAt(path) !== null
    }

    /** Clears every timer; the instance must not be reused. */
    dispose(): void {
        this.disposed = true
        for (const timer of this.timers.values()) {
            window.clearTimeout(timer)
        }
        this.timers.clear()
    }

    // -- Timer plumbing -------------------------------------------------------

    private readConfig(): { enabled: boolean; idleMs: number } {
        const behavior = this.deps.getSettings().behavior
        return { enabled: behavior.daemonMode, idleMs: behavior.daemonIdleSeconds * 1_000 }
    }

    /** Re-derives the file's real timer from the scheduler's due time. */
    private syncTimer(path: string): void {
        const hadTimer = this.timers.has(path)
        this.clearTimer(path)
        const dueAt = this.scheduler.nextDueAt(path)
        if (dueAt !== null) {
            const delay = Math.max(0, dueAt - this.now())
            this.timers.set(
                path,
                window.setTimeout(() => {
                    this.fireTimer(path)
                }, delay)
            )
        }
        if (hadTimer !== this.timers.has(path)) {
            this.deps.onStateChange()
        }
    }

    private clearTimer(path: string): void {
        const timer = this.timers.get(path)
        if (timer !== undefined) {
            window.clearTimeout(timer)
            this.timers.delete(path)
        }
    }

    private fireTimer(path: string): void {
        this.timers.delete(path)
        if (this.disposed) {
            return
        }
        const decision = this.scheduler.fire(path, this.now(), this.buildProbe(path))
        switch (decision.action) {
            case 'wait':
                // Fired early (the window moved): re-arm for the new due time.
                this.syncTimer(path)
                return
            case 'skip':
                if (decision.logOversized === true) {
                    // The ONLY surface an oversized daemon skip gets: one log
                    // line per file — never a modal, never a Notice.
                    log(`Daemon skipped oversized note: ${path}`, 'info')
                }
                this.deps.onStateChange()
                return
            case 'dispatch': {
                const run = this.deps.runController.getRun(path)
                // Same editor set as the note's current run; a never-reviewed
                // note runs all enabled review-capable editors (null = no
                // filter, the pipeline's default pool).
                const editorIds = run ? run.getEditorStates().map((state) => state.editorId) : null
                // A panel run refreshes as a panel run: dropping the identity
                // would silently downgrade the note to loose editors with no
                // charter and no scorecard.
                const panelId = run?.getPanelState()?.panelId ?? null
                void this.deps.port.startDaemonReview(path, editorIds, panelId)
                this.deps.onStateChange()
                return
            }
        }
    }

    /** Live facts for the scheduler's fire-time gates. */
    private buildProbe(path: string): DaemonFireProbe {
        const run = this.deps.runController.getRun(path)
        const note = this.deps.port.probeDaemonNote(path)
        return {
            runInFlight: run !== null && run.isBusy(),
            // A note that is no longer open cannot be probed or dispatched —
            // fail closed exactly like a non-reviewable one.
            reviewable: note !== null && this.deps.port.canReviewPath(path),
            oversized:
                note !== null && note.wordCount > this.deps.getSettings().behavior.sizeWarningWords,
            currentHash: note?.hash ?? '',
            lastRunHash: run?.snapshot.hash ?? null
        }
    }
}
