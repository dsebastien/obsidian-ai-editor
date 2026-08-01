/**
 * Daemon-mode scheduler core (Architecture.md § Run lifecycle beyond the first
 * pass; Business Rule #1 carve-out, decided
 * 2026-07-29): the pure state machine deciding WHEN a file's review should be
 * refreshed automatically. Time is always passed in explicitly and no timers
 * are owned here — the Obsidian glue (`ui/daemon-controller.ts`) feeds events
 * (edits, run state transitions, file closes, settings changes), arms one
 * real timer per file off `nextDueAt`, and asks `fire` for the decision when
 * a timer elapses. Everything user-visible about the trigger contract is
 * therefore unit-testable without CM6 or a workspace.
 *
 * Trigger contract enforced here (each clause spec-pinned):
 * - Nothing happens while daemon mode is off (`setConfig`), and turning it
 *   off clears every armed file (Business Rule #1 carve-out: the toggle IS
 *   the explicit user action authorizing automatic dispatches).
 * - A file arms on an edit and fires only after `idleMs` of inactivity;
 *   every further edit restarts the window.
 * - Never while a run (or per-editor retry) is in flight for the file: a
 *   daemon dispatch goes through the regular `startRun`, which CANCELS the
 *   file's previous run — so dispatching mid-run would steal the user's
 *   explicit summon/retry. Edits made during a run coalesce into ONE re-arm
 *   when the run settles; a fire that races a fresh run is refused and
 *   re-armed the same way (`run-in-flight`).
 * - Only when the text actually CHANGED since the last run's snapshot (hash
 *   compare): an undo back to the reviewed text must not refire.
 * - Reviewability (exclusions, editor availability) is re-checked at fire
 *   time via the probe; oversized notes are SILENTLY skipped — the glue logs
 *   at most one line per file (`logOversized`), never a modal or Notice.
 */

import { deleteKeysUnder } from '../../domain/path-scope'

export interface DaemonConfig {
    readonly enabled: boolean
    /** Idle window in ms (`behavior.daemonIdleSeconds` × 1000). */
    readonly idleMs: number
}

/**
 * Facts about the file at fire time, supplied by the glue. Kept as plain data
 * so decision order and outcomes are fully spec-covered.
 */
export interface DaemonFireProbe {
    /** A run or per-editor retry is currently unsettled for the file. */
    readonly runInFlight: boolean
    /** `isReviewable` — exclusions + at least one dispatchable editor. */
    readonly reviewable: boolean
    /** Word count above `behavior.sizeWarningWords` (silent daemon skip). */
    readonly oversized: boolean
    /** Hash of the current live text. */
    readonly currentHash: string
    /** Snapshot hash of the file's current run; null when never reviewed. */
    readonly lastRunHash: string | null
}

export type DaemonSkipReason =
    | 'disabled'
    | 'not-armed'
    | 'run-in-flight'
    | 'not-reviewable'
    | 'unchanged'
    | 'oversized'

export type DaemonFireDecision =
    /** Dispatch a review now (the glue then reports it via `runStarted`). */
    | { readonly action: 'dispatch' }
    /** Timer fired early (idle window moved/desync): re-arm for `dueAt`. */
    | { readonly action: 'wait'; readonly dueAt: number }
    /**
     * No dispatch; the arm is consumed (except `disabled`/`not-armed`, where
     * there was nothing to consume). `logOversized` is true exactly once per
     * file — the glue's one-time-per-file log line.
     */
    | {
          readonly action: 'skip'
          readonly reason: DaemonSkipReason
          readonly logOversized?: boolean
      }

interface PathState {
    /** Timestamp of the arming event (last edit, or the settle that
     * re-armed); null = not armed. */
    armedAt: number | null
    runInFlight: boolean
    /** Edits seen while a run was in flight — coalesced into one re-arm at
     * settle time. */
    editedDuringRun: boolean
}

export class DaemonScheduler {
    private config: DaemonConfig = { enabled: false, idleMs: 30_000 }
    private readonly paths = new Map<string, PathState>()
    /** Files whose oversized skip was already logged (once per file). */
    private readonly oversizedLogged = new Set<string>()

    /**
     * Applies the current settings. Disabling clears ALL per-file state —
     * pending arms must not survive the toggle (re-enabling starts from a
     * clean slate; only new edits arm). An idle change applies to pending
     * arms immediately because due times are derived, never stored.
     */
    setConfig(config: DaemonConfig): void {
        this.config = config
        if (!config.enabled) {
            this.paths.clear()
            this.oversizedLogged.clear()
        }
    }

    /** One document change of `path` at time `now` (canonical view only). */
    recordEdit(path: string, now: number): void {
        if (!this.config.enabled) {
            return // no state accumulation while the daemon is off
        }
        const state = this.stateOf(path)
        if (state.runInFlight) {
            // Coalesce: never arm mid-run; one re-arm happens at settle.
            state.editedDuringRun = true
            return
        }
        state.armedAt = now
    }

    /**
     * Reports the file's live run state (any run: user summon, CLI, daemon).
     * Transition to in-flight consumes the arm (the run reviews the current
     * text — nothing left to refresh); transition to settled re-arms ONCE
     * when edits happened during the run.
     */
    syncRunState(path: string, inFlight: boolean, now: number): void {
        if (!this.config.enabled) {
            return
        }
        if (inFlight) {
            const state = this.stateOf(path)
            if (!state.runInFlight) {
                state.runInFlight = true
                state.armedAt = null
                state.editedDuringRun = false
            }
            return
        }
        const state = this.paths.get(path)
        if (!state || !state.runInFlight) {
            return // settled with no tracked state: nothing to re-arm
        }
        state.runInFlight = false
        if (state.editedDuringRun) {
            state.editedDuringRun = false
            // Re-arm from settle time (not the last edit): the full idle
            // window must elapse again, so a settle never triggers an
            // immediate back-to-back dispatch.
            state.armedAt = now
        }
    }

    /** Drops all state for a closed/deleted/renamed-away file. */
    fileClosed(path: string): void {
        this.paths.delete(path)
        this.oversizedLogged.delete(path)
    }

    /**
     * `fileClosed` for a path AND everything under it — a FOLDER rename or
     * delete, which Obsidian reports without per-child events. Without it a
     * deleted folder's notes stay armed, and the daemon keeps a schedule for
     * files that no longer exist.
     */
    filesClosedUnder(path: string): void {
        deleteKeysUnder(this.paths, path)
        deleteKeysUnder(this.oversizedLogged, path)
    }

    /** When the file's timer should fire, or null when nothing is armed. */
    nextDueAt(path: string): number | null {
        if (!this.config.enabled) {
            return null
        }
        const state = this.paths.get(path)
        if (!state || state.armedAt === null || state.runInFlight) {
            return null
        }
        return state.armedAt + this.config.idleMs
    }

    /** Every file with a pending arm (timer resync after settings change). */
    armedPaths(): string[] {
        return [...this.paths.keys()].filter((path) => this.nextDueAt(path) !== null)
    }

    /**
     * Timer-fire decision for `path` at `now`. Consumes the arm on every
     * outcome except `wait` (fired early — keep it) and the no-op reasons
     * (`disabled`/`not-armed`). A `dispatch` is followed by the run start,
     * which `syncRunState` observes; a `run-in-flight` race marks the file
     * edited-during-run so the settle re-arms it (coalesce rule — the daemon
     * NEVER dispatches over an unsettled run, because `startRun` would cancel
     * it and steal the user's explicit summon/cancel/retry).
     */
    fire(path: string, now: number, probe: DaemonFireProbe): DaemonFireDecision {
        if (!this.config.enabled) {
            return { action: 'skip', reason: 'disabled' }
        }
        const state = this.paths.get(path)
        if (!state || state.armedAt === null) {
            return { action: 'skip', reason: 'not-armed' }
        }
        if (state.runInFlight || probe.runInFlight) {
            // Desync guard: trust the live probe over internal bookkeeping.
            state.runInFlight = true
            state.armedAt = null
            state.editedDuringRun = true
            return { action: 'skip', reason: 'run-in-flight' }
        }
        const dueAt = state.armedAt + this.config.idleMs
        if (now < dueAt) {
            return { action: 'wait', dueAt }
        }
        state.armedAt = null // consumed — every branch below is terminal
        if (!probe.reviewable) {
            return { action: 'skip', reason: 'not-reviewable' }
        }
        if (probe.lastRunHash !== null && probe.currentHash === probe.lastRunHash) {
            // No-op edit cycle (undo back to the reviewed text): nothing to
            // refresh. `lastRunHash === null` means never reviewed — any
            // armed edit qualifies.
            return { action: 'skip', reason: 'unchanged' }
        }
        if (probe.oversized) {
            const logOversized = !this.oversizedLogged.has(path)
            this.oversizedLogged.add(path)
            return { action: 'skip', reason: 'oversized', logOversized }
        }
        return { action: 'dispatch' }
    }

    private stateOf(path: string): PathState {
        let state = this.paths.get(path)
        if (!state) {
            state = { armedAt: null, runInFlight: false, editedDuringRun: false }
            this.paths.set(path, state)
        }
        return state
    }
}
