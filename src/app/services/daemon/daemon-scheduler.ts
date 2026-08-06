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
 * - The idle window measures "has the user paused EDITING?" (issue #20,
 *   narrowed 2026-08-06): editor activity — cursor/selection movement,
 *   undo/redo, anything read-write about the text — postpones the window
 *   via `recordEditorActivity`, but only an EDIT can arm it. TRIAGE
 *   activity (accepting, dismissing, panel scrolling and clicks, threads,
 *   reference adds) deliberately does NOT postpone
 *   (`recordTriageActivity`): triaging findings is working WITH the
 *   review, and postponing the refresh for it delayed re-reviews by the
 *   whole triage session. Mere activity never satisfies the changed-text
 *   gate, so neither tier can trigger a review of unchanged text.
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

import { deleteKeysUnder, remapKeysUnder, remapMembersUnder } from '../../domain/path-scope'

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
    /** Findings hidden for this note (issue #29): the arm is KEPT, not consumed. */
    | 'paused'
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
    /**
     * Timestamp of the last EDITOR-tier interaction while armed (issue #20;
     * triage never records here); null = none since arming. Postpones the
     * due time, never arms — cleared whenever the arm is consumed or
     * (re)set.
     */
    lastActivityAt: number | null
    runInFlight: boolean
    /** Edits seen while a run was in flight — coalesced into one re-arm at
     * settle time. */
    editedDuringRun: boolean
}

export class DaemonScheduler {
    private config: DaemonConfig = { enabled: false, idleMs: 3_000 }
    private readonly paths = new Map<string, PathState>()
    /** Files whose oversized skip was already logged (once per file). */
    private readonly oversizedLogged = new Set<string>()
    /**
     * Files whose findings are hidden (issue #29): no timer is due and no
     * dispatch fires, but edits keep ARMING silently — refreshing findings
     * the user asked not to see is pure cost, while forgetting that the text
     * changed would make un-hiding lose the pending refresh.
     */
    private readonly paused = new Set<string>()

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
            this.paused.clear()
        }
    }

    /**
     * Suspends automatic refreshes for `path` (issue #29: findings hidden).
     * The pending arm is KEPT — edits made while paused keep arming — but
     * `nextDueAt` reports nothing due and a stray timer fire skips without
     * consuming, so no request is spent on a result the user cannot see.
     */
    pause(path: string): void {
        if (!this.config.enabled) {
            return
        }
        this.paused.add(path)
    }

    /**
     * Resumes automatic refreshes (issue #29: findings shown again). A note
     * that armed before or during the pause re-arms from NOW — the full
     * quiet window must elapse after un-hiding (same rationale as the
     * settle re-arm), and the changed-hash gate at fire time still decides
     * whether the text actually needs a refresh.
     */
    resume(path: string, now: number): void {
        if (!this.paused.delete(path)) {
            return
        }
        const state = this.paths.get(path)
        if (state && state.armedAt !== null && !state.runInFlight) {
            state.armedAt = now
            state.lastActivityAt = null
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
        // The edit IS the latest activity; older activity must not linger.
        state.lastActivityAt = null
    }

    /**
     * EDITOR-tier interaction with the note at time `now` (issue #20):
     * cursor/selection movement, undo/redo, modals composing the next edit.
     * Postpones a PENDING arm's due time and does nothing else — activity
     * alone never arms (the changed-text gate stays edit-only) and never
     * touches an in-flight run's coalescing state.
     */
    recordEditorActivity(path: string, now: number): void {
        if (!this.config.enabled) {
            return
        }
        const state = this.paths.get(path)
        if (!state || state.armedAt === null || state.runInFlight) {
            return
        }
        state.lastActivityAt = now
    }

    /**
     * TRIAGE-tier interaction (accept/dismiss, panel scroll/click, threads,
     * reference adds): deliberately a no-op — triage must NOT postpone a
     * pending refresh (two-tier carve-out, 2026-08-06). The method exists so
     * every interaction surface still reports its tier explicitly and the
     * non-postponing contract is pinned by spec rather than by absence of a
     * call.
     */
    recordTriageActivity(_path: string): void {
        // Intentionally empty: triage never moves the idle window.
    }

    /**
     * A plugin-originated TRIAGE-tier DOCUMENT edit at `now` — accepting a
     * finding's proposal (single or bulk), adding a reference. The text
     * changed, so the note must eventually refresh — but triage never moves
     * an armed idle window (two-tier carve-out, 2026-08-06): accepting the
     * last finding at the end of a quiet window must not postpone the
     * refresh by the full delay the way a keystroke would. So: armed → the
     * existing deadline stands (the change is folded into the pending
     * refresh); NOT armed → arms exactly like an edit (the change must not
     * be silently lost); run in flight → coalesces into the settle re-arm
     * exactly like an edit.
     */
    recordTriageEdit(path: string, now: number): void {
        if (!this.config.enabled) {
            return
        }
        const state = this.stateOf(path)
        if (state.runInFlight) {
            state.editedDuringRun = true
            return
        }
        if (state.armedAt === null) {
            state.armedAt = now
            state.lastActivityAt = null
        }
        // Armed: deliberately untouched — triage never moves the idle window.
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
                state.lastActivityAt = null
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
            state.lastActivityAt = null
        }
    }

    /** Drops all state for a closed or deleted file. */
    fileClosed(path: string): void {
        this.paths.delete(path)
        this.oversizedLogged.delete(path)
        this.paused.delete(path)
    }

    /**
     * `fileClosed` for a path AND everything under it — a FOLDER delete,
     * which Obsidian reports without per-child events. Without it a deleted
     * folder's notes stay armed, and the daemon keeps a schedule for files
     * that no longer exist. Renames go through `filesRenamedUnder`.
     */
    filesClosedUnder(path: string): void {
        deleteKeysUnder(this.paths, path)
        deleteKeysUnder(this.oversizedLogged, path)
        deleteKeysUnder(this.paused, path)
    }

    /**
     * A vault RENAME of `oldPath` (note or folder): the notes are still open
     * and their views follow the file, so pending arms and the once-per-file
     * oversized log marker follow too — a rename is NOT a close (adversarial
     * review 2026-08-06; deleting the state here silently dropped pending
     * refreshes). The `paused` marker is deliberately DROPPED, not remapped:
     * it mirrors the controller's findings-hidden state, which a rename
     * clears along with the cancelled run — a remapped pause would suppress
     * refreshes at the new path with no findings-shown gesture left to lift
     * it. Returns the remapped (new) paths so the glue can re-derive timers.
     */
    filesRenamedUnder(oldPath: string, newPath: string): string[] {
        const moved = remapKeysUnder(this.paths, oldPath, newPath)
        remapMembersUnder(this.oversizedLogged, oldPath, newPath)
        deleteKeysUnder(this.paused, oldPath)
        return moved
    }

    /** When the file's timer should fire, or null when nothing is armed. */
    nextDueAt(path: string): number | null {
        if (!this.config.enabled) {
            return null
        }
        const state = this.paths.get(path)
        if (!state || state.armedAt === null || state.runInFlight || this.paused.has(path)) {
            return null
        }
        return this.dueAtOf(state.armedAt, state.lastActivityAt)
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
        if (this.paused.has(path)) {
            // Defensive: no timer should exist while paused (`nextDueAt` is
            // null). The arm is deliberately NOT consumed — resume re-derives
            // the window from it.
            return { action: 'skip', reason: 'paused' }
        }
        if (state.runInFlight || probe.runInFlight) {
            // Desync guard: trust the live probe over internal bookkeeping.
            state.runInFlight = true
            state.armedAt = null
            state.lastActivityAt = null
            state.editedDuringRun = true
            return { action: 'skip', reason: 'run-in-flight' }
        }
        const dueAt = this.dueAtOf(state.armedAt, state.lastActivityAt)
        if (now < dueAt) {
            return { action: 'wait', dueAt }
        }
        state.armedAt = null // consumed — every branch below is terminal
        state.lastActivityAt = null
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

    /**
     * The armed window's expiry: `idleMs` after the LATEST of the arming edit
     * and any interaction recorded since (issue #20) — quiet means "no edits
     * AND no activity", not merely "no keystrokes".
     */
    private dueAtOf(armedAt: number, lastActivityAt: number | null): number {
        return Math.max(armedAt, lastActivityAt ?? armedAt) + this.config.idleMs
    }

    private stateOf(path: string): PathState {
        let state = this.paths.get(path)
        if (!state) {
            state = {
                armedAt: null,
                lastActivityAt: null,
                runInFlight: false,
                editedDuringRun: false
            }
            this.paths.set(path, state)
        }
        return state
    }
}
