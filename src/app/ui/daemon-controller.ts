import { isPathUnder, remapKeysUnder } from '../domain/path-scope'
import { disabledEditorIds } from './editor-visibility'
import type { PluginSettingsV1 } from '../domain/settings/settings-schema'
import {
    DaemonFailureTracker,
    DAEMON_DISABLE_AFTER
} from '../services/daemon/daemon-failure-tracker'
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
 * - The settings observer calls `settingsChanged` (always-on default + idle
 *   delay apply live; flipping `daemonAlwaysOn` drops every per-note session
 *   choice, and "nothing enabled anywhere" clears every timer).
 * - Daemon mode is PER NOTE (Sébastien, 2026-08-06): `isEnabledFor` /
 *   `setEnabledFor` hold runtime-only per-note state defaulting to
 *   `behavior.daemonAlwaysOn` (off by default). The rail toggle and the
 *   palette command flip the CURRENT note; the choice dies when the note's
 *   last view closes.
 * - Timers are keyed by file PATH, never by view — popouts and split panes
 *   share one schedule per file (`fileClosed` fires only when the last view
 *   showing the file goes away, plus on vault delete; a vault RENAME remaps
 *   every per-note state to the new path via `filesRenamedUnder` — the note
 *   never closed).
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
    /**
     * Flips daemon mode OFF — for every note, and persisting
     * `daemonAlwaysOn` off when it was on — and tells the user why (issue
     * #23): called after repeated consecutive daemon refreshes failed
     * outright. Daemon runs are the ones nobody watches — an unattended
     * loop against a dead key or an exhausted quota would retry forever and
     * bill every attempt. Manual actions stay available; re-enabling (per
     * note or via the always-on setting) is the "I fixed it" gesture.
     */
    disableDaemonMode(reason: string): void
}

export interface DaemonControllerDeps {
    readonly getSettings: () => PluginSettingsV1
    readonly runController: RunController
    readonly port: DaemonReviewPort
    /** Armed-state changed for some file — refresh the rail indicator. */
    readonly onStateChange: () => void
    readonly now?: () => number
    /**
     * Timer seam (same pattern as `CommentJobRegistry`): defaults to
     * `window.setTimeout`/`window.clearTimeout`; specs inject manual-fire
     * fakes (Bun has no `window`).
     */
    readonly setTimer?: (callback: () => void, ms: number) => number
    readonly clearTimer?: (handle: number) => void
}

export class DaemonController {
    private readonly deps: DaemonControllerDeps
    private readonly scheduler = new DaemonScheduler()
    private readonly timers = new Map<string, number>()
    private readonly now: () => number
    private readonly setTimerFn: (callback: () => void, ms: number) => number
    private readonly clearTimerFn: (handle: number) => void
    private disposed = false
    /** Consecutive fully-failed refreshes → auto-disable (issue #23). */
    private readonly failureTracker = new DaemonFailureTracker()
    /**
     * Per-note runtime enablement (Sébastien, 2026-08-06): daemon mode is a
     * PER-NOTE, per-open choice, never persisted. Absent = the note follows
     * `behavior.daemonAlwaysOn` (off by default). An entry overrides that
     * default for one open note and dies with it (`fileClosed`), so a
     * reopened note always starts from the default again. Cleared whenever
     * `daemonAlwaysOn` itself flips — the setting is the authoritative
     * cost decision and stale per-note session choices must not outlive it.
     */
    private readonly noteOverrides = new Map<string, boolean>()
    /**
     * Runtime kill latch (issue #23): set by `disableAllNotes` so the
     * auto-disable stops every automatic refresh IMMEDIATELY and even when
     * persisting `daemonAlwaysOn` off fails (disk full, sync conflict) —
     * otherwise the always-on default would re-arm every open note and the
     * broken backend would keep billing. Cleared by the explicit "try again"
     * gestures: a per-note enable (`setEnabledFor(path, true)`) or the
     * `daemonAlwaysOn` flip in `settingsChanged`.
     */
    private suspended = false
    /** Last seen `daemonAlwaysOn` — detects the flip in `settingsChanged`. */
    private lastAlwaysOn: boolean

    constructor(deps: DaemonControllerDeps) {
        this.deps = deps
        this.now = deps.now ?? ((): number => Date.now())
        this.setTimerFn =
            deps.setTimer ?? ((callback, ms): number => window.setTimeout(callback, ms))
        this.clearTimerFn =
            deps.clearTimer ??
            ((handle): void => {
                window.clearTimeout(handle)
            })
        this.lastAlwaysOn = this.deps.getSettings().behavior.daemonAlwaysOn
        this.scheduler.setConfig(this.readConfig())
    }

    /** Whether daemon mode is on for `path` (per-note runtime state). */
    isEnabledFor(path: string): boolean {
        if (this.suspended) {
            return false
        }
        return this.noteOverrides.get(path) ?? this.deps.getSettings().behavior.daemonAlwaysOn
    }

    /**
     * Flips daemon mode for ONE note (rail toggle / palette command).
     * Runtime-only: the choice lasts while the note stays open and is never
     * persisted — reopening starts from the `daemonAlwaysOn` default again.
     * Turning a note OFF drops its pending arm and timer (the cost
     * kill-switch semantics of the retired global toggle, now per note);
     * turning it ON starts from a clean slate — only new edits arm — and
     * resets the failure streak (the toggle is the "try again" gesture,
     * issue #23).
     */
    setEnabledFor(path: string, enabled: boolean): void {
        if (this.disposed || this.isEnabledFor(path) === enabled) {
            return
        }
        if (enabled) {
            // The explicit enable is the "I fixed it" gesture: it lifts the
            // issue #23 suspension latch (see `suspended`).
            this.suspended = false
        }
        if (enabled === this.deps.getSettings().behavior.daemonAlwaysOn) {
            this.noteOverrides.delete(path)
        } else {
            this.noteOverrides.set(path, enabled)
        }
        if (enabled) {
            this.failureTracker.reset()
        } else {
            this.scheduler.fileClosed(path)
            this.clearTimer(path)
        }
        this.scheduler.setConfig(this.readConfig())
        this.deps.onStateChange()
    }

    /**
     * Daemon off for EVERY note at once (issue #23 auto-disable). Clears
     * every override, every pending arm and every timer, and latches
     * `suspended` so the kill holds synchronously and unconditionally —
     * with `daemonAlwaysOn` ON the default would otherwise read enabled
     * again immediately (and forever, if persisting the setting off fails).
     */
    disableAllNotes(): void {
        if (this.disposed) {
            return
        }
        this.suspended = true
        this.noteOverrides.clear()
        this.scheduler.setConfig(this.readConfig())
        for (const path of [...this.timers.keys()]) {
            this.clearTimer(path)
        }
        this.deps.onStateChange()
    }

    /** One document change of `path` (canonical view, exactly once). */
    recordEdit(path: string): void {
        if (this.disposed || !this.isEnabledFor(path)) {
            return
        }
        this.scheduler.recordEdit(path, this.now())
        this.syncTimer(path)
    }

    /**
     * EDITOR-tier non-edit interaction with `path` (issue #20):
     * cursor/selection movement, modals composing the next request.
     * Postpones a pending refresh; never arms one. The timer resync is
     * cheap and keeps the real timer honest, but even without it an early
     * fire comes back as `wait` and re-arms — the scheduler is the
     * authority on the due time.
     */
    recordEditorActivity(path: string): void {
        if (this.disposed || !this.isEnabledFor(path)) {
            return
        }
        this.scheduler.recordEditorActivity(path, this.now())
        this.syncTimer(path)
    }

    /**
     * TRIAGE-tier interaction with `path` (accept/dismiss, panel
     * scroll/click, threads, reference adds): forwarded to the scheduler,
     * where it is deliberately a no-op — triage must not postpone a pending
     * refresh (two-tier carve-out, 2026-08-06). Kept as a real seam so call
     * sites state their tier and a future policy change has one place to go.
     */
    recordTriageActivity(path: string): void {
        if (this.disposed) {
            return
        }
        this.scheduler.recordTriageActivity(path)
    }

    /**
     * A plugin-originated TRIAGE-tier DOCUMENT edit of `path` (accepting a
     * finding's proposal — single or bulk — or adding a reference; marked by
     * `triageEditAnnotation` on the dispatch). Unlike a keystroke it never
     * POSTPONES an armed idle window — accepting at the end of a quiet
     * window must not push the refresh back by the full delay — but like an
     * edit it arms an unarmed note: the text changed and the eventual
     * refresh must see it (two-tier carve-out, 2026-08-06).
     */
    recordTriageEdit(path: string): void {
        if (this.disposed || !this.isEnabledFor(path)) {
            return
        }
        this.scheduler.recordTriageEdit(path, this.now())
        this.syncTimer(path)
    }

    /**
     * Findings hidden for `path` (issue #29): automatic refreshes stop for
     * that note — refreshing what the user asked not to see is pure cost.
     * The global daemon mode is untouched.
     */
    pause(path: string): void {
        if (this.disposed) {
            return
        }
        this.scheduler.pause(path)
        this.syncTimer(path)
        this.deps.onStateChange()
    }

    /** Findings shown again for `path`: refreshes resume (issue #29). */
    resume(path: string): void {
        if (this.disposed) {
            return
        }
        this.scheduler.resume(path, this.now())
        this.syncTimer(path)
        this.deps.onStateChange()
    }

    /** Live run state for `path` (reported on every refresh cycle). */
    syncRunState(path: string, inFlight: boolean): void {
        if (this.disposed || !this.isEnabledFor(path)) {
            return
        }
        this.scheduler.syncRunState(path, inFlight, this.now())
        this.syncTimer(path)
    }

    /** Last view showing `path` closed, or the file was deleted. */
    fileClosed(path: string): void {
        // The per-note choice dies with the note: reopening starts from the
        // `daemonAlwaysOn` default again (per-note enable never persists).
        this.noteOverrides.delete(path)
        this.scheduler.fileClosed(path)
        this.clearTimer(path)
    }

    /**
     * `fileClosed` for a path AND everything under it — a FOLDER delete,
     * which Obsidian reports as one vault event with no per-child ones.
     * Without it the schedule (and its real timer) outlives the notes.
     * Renames go through `filesRenamedUnder` instead — they close nothing.
     */
    filesClosedUnder(path: string): void {
        this.scheduler.filesClosedUnder(path)
        for (const tracked of [...this.noteOverrides.keys()]) {
            if (isPathUnder(tracked, path)) {
                this.noteOverrides.delete(tracked)
            }
        }
        for (const tracked of [...this.timers.keys()]) {
            if (isPathUnder(tracked, path)) {
                this.clearTimer(tracked)
            }
        }
    }

    /**
     * A vault RENAME of `oldPath` — a note, or a folder with notes under it.
     * A rename is NOT a close: the views stay open and follow the file, so
     * every per-note daemon state moves to the new path instead of dying
     * with the old one — the runtime enablement override (deleting it
     * silently flipped an explicitly disabled note back to the always-on
     * default, and an explicitly enabled note back off — adversarial review
     * 2026-08-06), the scheduler's pending arm, and the real timer backing
     * it. Deletion stays the close/delete contract (`fileClosed` /
     * `filesClosedUnder`).
     */
    filesRenamedUnder(oldPath: string, newPath: string): void {
        if (this.disposed) {
            return
        }
        remapKeysUnder(this.noteOverrides, oldPath, newPath)
        // Old-path timers first: their scheduler state is about to move, so
        // they could only fire into `not-armed` skips.
        for (const tracked of [...this.timers.keys()]) {
            if (isPathUnder(tracked, oldPath)) {
                this.clearTimer(tracked)
            }
        }
        this.scheduler.filesRenamedUnder(oldPath, newPath)
        // Re-derive a real timer for every arm that moved. `armedPaths` (not
        // the remap's return) is authoritative: it already applies the
        // paused/run-in-flight gates.
        for (const armed of this.scheduler.armedPaths()) {
            if (isPathUnder(armed, newPath)) {
                this.syncTimer(armed)
            }
        }
        this.deps.onStateChange()
    }

    /** Settings observer entry: re-reads the daemon config live. */
    settingsChanged(): void {
        if (this.disposed) {
            return
        }
        const alwaysOn = this.deps.getSettings().behavior.daemonAlwaysOn
        if (alwaysOn !== this.lastAlwaysOn) {
            // The setting flip is authoritative: per-note session choices
            // are dropped so the new default applies to every note at once
            // (always-on OFF must actually stop every automatic refresh).
            // It also lifts the issue #23 suspension latch — the flip is an
            // explicit cost decision, whichever direction it goes.
            this.lastAlwaysOn = alwaysOn
            this.noteOverrides.clear()
            this.suspended = false
        }
        // Toggling the mode is the try-again gesture: the failure streak
        // must not survive it (issue #23).
        this.failureTracker.reset()
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
            this.clearTimerFn(timer)
        }
        this.timers.clear()
    }

    // -- Timer plumbing -------------------------------------------------------

    private readConfig(): { enabled: boolean; idleMs: number } {
        const behavior = this.deps.getSettings().behavior
        // The scheduler's global flag means "could ANY note refresh?" —
        // always-on, or at least one per-note session enable. Per-note
        // gating happens at this controller's entry points, so a disabled
        // note's events never reach the scheduler; the flag going false is
        // what clears all scheduler state when the last enabled note (or
        // the always-on setting) turns off.
        const anyOverrideOn = [...this.noteOverrides.values()].some((enabled) => enabled)
        return {
            // The suspension latch (issue #23) beats everything: while it
            // holds, no note may refresh, so the scheduler drops its arms.
            enabled: !this.suspended && (behavior.daemonAlwaysOn || anyOverrideOn),
            idleMs: behavior.daemonIdleSeconds * 1_000
        }
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
                this.setTimerFn(() => {
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
            this.clearTimerFn(timer)
            this.timers.delete(path)
        }
    }

    private fireTimer(path: string): void {
        this.timers.delete(path)
        // Defensive: turning a note off clears its timer, but a fire already
        // queued in the event loop must still respect the per-note state.
        if (this.disposed || !this.isEnabledFor(path)) {
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
                // Same editor set as the note's current run, RESOLVED AT FIRE
                // TIME against the live settings: an editor disabled since
                // that run must not be re-dispatched by the daemon (its
                // findings are hidden, not purged — hide/purge contract in
                // `editor-visibility.ts`). `startReview` re-filters the pool
                // anyway (`resolveReviewParticipants` drops disabled editors
                // silently), but resolving here keeps the daemon honest even
                // if the pipeline's pool rules change — and pins the
                // contract in `daemon-controller.spec.ts`. An all-disabled
                // set stays an EMPTY list (a silent `no-editors` refusal),
                // never null: null means "the default pool", which would
                // silently widen the run to every enabled editor. A
                // never-reviewed note runs all enabled review-capable
                // editors (null = no filter, the pipeline's default pool).
                const disabled = disabledEditorIds(this.deps.getSettings().editors)
                const editorIds = run
                    ? run
                          .getEditorStates()
                          .map((state) => state.editorId)
                          .filter((editorId) => !disabled.has(editorId))
                    : null
                // A panel run refreshes as a panel run: dropping the identity
                // would silently downgrade the note to loose editors with no
                // charter and no scorecard.
                const panelId = run?.getPanelState()?.panelId ?? null
                void this.deps.port
                    .startDaemonReview(path, editorIds, panelId)
                    .then((outcome) => {
                        if (outcome === 'started' && !this.disposed) {
                            this.observeRefreshOutcome(path)
                        }
                    })
                    .catch(() => undefined)
                this.deps.onStateChange()
                return
            }
        }
    }

    /**
     * Watches ONE daemon-dispatched run to its settle and feeds the
     * auto-disable tracker (issue #23, pure logic + spec in
     * `daemon-failure-tracker.ts`). On a `disable` verdict the port turns
     * the mode off and says why — an unattended loop must not keep billing
     * a broken backend.
     */
    private observeRefreshOutcome(path: string): void {
        const run = this.deps.runController.getRun(path)
        if (!run) {
            return
        }
        void run.settled.then(() => {
            if (this.disposed || !this.isEnabledFor(path)) {
                return
            }
            const states = run.getEditorStates()
            if (this.failureTracker.record(states) === 'continue') {
                return
            }
            const failed = states.find((state) => state.status === 'error')
            const cause = failed
                ? `${failed.editorName} — ${failed.error?.code ?? 'unknown'}`
                : 'unknown'
            this.deps.port.disableDaemonMode(
                `automatic refreshes failed ${DAEMON_DISABLE_AFTER} times in a row (last: ${cause})`
            )
        })
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
