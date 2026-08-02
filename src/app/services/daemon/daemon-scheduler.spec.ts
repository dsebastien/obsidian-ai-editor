import { describe, expect, it } from 'bun:test'
import { DaemonScheduler } from './daemon-scheduler'
import type { DaemonFireProbe } from './daemon-scheduler'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const IDLE_MS = 30_000
const PATH = 'Notes/A.md'
const OTHER = 'Notes/B.md'

function makeScheduler(enabled = true, idleMs = IDLE_MS): DaemonScheduler {
    const scheduler = new DaemonScheduler()
    scheduler.setConfig({ enabled, idleMs })
    return scheduler
}

/** All-clear probe: fire should dispatch unless the schedule says otherwise. */
function clearProbe(overrides: Partial<DaemonFireProbe> = {}): DaemonFireProbe {
    return {
        runInFlight: false,
        reviewable: true,
        oversized: false,
        currentHash: 'hash-current',
        lastRunHash: 'hash-previous',
        ...overrides
    }
}

// ---------------------------------------------------------------------------
// Enable/disable gating
// ---------------------------------------------------------------------------

describe('DaemonScheduler config gating', () => {
    it('ignores edits and never arms while disabled', () => {
        const scheduler = makeScheduler(false)
        scheduler.recordEdit(PATH, 1_000)
        expect(scheduler.nextDueAt(PATH)).toBeNull()
        expect(scheduler.fire(PATH, 1_000 + IDLE_MS, clearProbe())).toEqual({
            action: 'skip',
            reason: 'disabled'
        })
    })

    it('clears every pending arm when daemon mode turns off mid-arm', () => {
        const scheduler = makeScheduler()
        scheduler.recordEdit(PATH, 1_000)
        scheduler.recordEdit(OTHER, 2_000)
        expect(scheduler.armedPaths()).toEqual([PATH, OTHER])
        scheduler.setConfig({ enabled: false, idleMs: IDLE_MS })
        expect(scheduler.armedPaths()).toEqual([])
        // Re-enabling starts from a clean slate: the old arms do not revive.
        scheduler.setConfig({ enabled: true, idleMs: IDLE_MS })
        expect(scheduler.nextDueAt(PATH)).toBeNull()
        expect(scheduler.fire(PATH, 1_000 + IDLE_MS, clearProbe())).toEqual({
            action: 'skip',
            reason: 'not-armed'
        })
    })

    it('applies an idle-delay change to a pending arm immediately', () => {
        const scheduler = makeScheduler()
        scheduler.recordEdit(PATH, 1_000)
        expect(scheduler.nextDueAt(PATH)).toEqual(1_000 + IDLE_MS)
        scheduler.setConfig({ enabled: true, idleMs: 5_000 })
        expect(scheduler.nextDueAt(PATH)).toEqual(6_000)
    })
})

// ---------------------------------------------------------------------------
// Idle windows
// ---------------------------------------------------------------------------

describe('DaemonScheduler idle windows', () => {
    it('arms on an edit and fires once the idle window elapsed', () => {
        const scheduler = makeScheduler()
        scheduler.recordEdit(PATH, 1_000)
        expect(scheduler.nextDueAt(PATH)).toEqual(1_000 + IDLE_MS)
        expect(scheduler.fire(PATH, 1_000 + IDLE_MS, clearProbe())).toEqual({
            action: 'dispatch'
        })
    })

    it('restarts the window on every further edit (last edit wins)', () => {
        const scheduler = makeScheduler()
        scheduler.recordEdit(PATH, 1_000)
        scheduler.recordEdit(PATH, 20_000)
        expect(scheduler.nextDueAt(PATH)).toEqual(20_000 + IDLE_MS)
        // A timer armed off the FIRST edit fires early → wait with the moved
        // due time, and the arm is kept.
        expect(scheduler.fire(PATH, 1_000 + IDLE_MS, clearProbe())).toEqual({
            action: 'wait',
            dueAt: 20_000 + IDLE_MS
        })
        expect(scheduler.fire(PATH, 20_000 + IDLE_MS, clearProbe())).toEqual({
            action: 'dispatch'
        })
    })

    it('consumes the arm on dispatch — no refire without a new edit', () => {
        const scheduler = makeScheduler()
        scheduler.recordEdit(PATH, 1_000)
        expect(scheduler.fire(PATH, 1_000 + IDLE_MS, clearProbe()).action).toEqual('dispatch')
        expect(scheduler.nextDueAt(PATH)).toBeNull()
        expect(scheduler.fire(PATH, 1_000 + 2 * IDLE_MS, clearProbe())).toEqual({
            action: 'skip',
            reason: 'not-armed'
        })
    })

    it('never fires a file that was not edited', () => {
        const scheduler = makeScheduler()
        expect(scheduler.nextDueAt(PATH)).toBeNull()
        expect(scheduler.fire(PATH, 99_000, clearProbe())).toEqual({
            action: 'skip',
            reason: 'not-armed'
        })
    })
})

// ---------------------------------------------------------------------------
// Run-in-flight coalescing — a daemon dispatch must NEVER cancel a run
// ---------------------------------------------------------------------------

describe('DaemonScheduler run coalescing', () => {
    it('consumes the arm when a run starts (the run reviews the current text)', () => {
        const scheduler = makeScheduler()
        scheduler.recordEdit(PATH, 1_000)
        scheduler.syncRunState(PATH, true, 2_000)
        expect(scheduler.nextDueAt(PATH)).toBeNull()
    })

    it('does not arm on edits made while a run is in flight', () => {
        const scheduler = makeScheduler()
        scheduler.syncRunState(PATH, true, 1_000)
        scheduler.recordEdit(PATH, 2_000)
        expect(scheduler.nextDueAt(PATH)).toBeNull()
    })

    it('re-arms ONCE at settle when edits happened during the run', () => {
        const scheduler = makeScheduler()
        scheduler.syncRunState(PATH, true, 1_000)
        scheduler.recordEdit(PATH, 2_000)
        scheduler.recordEdit(PATH, 3_000)
        scheduler.syncRunState(PATH, false, 60_000)
        // The window restarts at settle time — the full idle delay elapses
        // again, never an immediate back-to-back dispatch.
        expect(scheduler.nextDueAt(PATH)).toEqual(60_000 + IDLE_MS)
        expect(scheduler.fire(PATH, 60_000 + IDLE_MS, clearProbe()).action).toEqual('dispatch')
    })

    it('stays disarmed at settle when nothing was edited during the run', () => {
        const scheduler = makeScheduler()
        scheduler.recordEdit(PATH, 1_000)
        scheduler.syncRunState(PATH, true, 2_000)
        scheduler.syncRunState(PATH, false, 60_000)
        expect(scheduler.nextDueAt(PATH)).toBeNull()
    })

    it('refuses to dispatch when the live probe reports a run in flight, and re-arms after settle', () => {
        // Race: a user summon started between the timer firing and the
        // decision. Dispatching would route through startRun, which CANCELS
        // the user's run — the probe check guarantees that can never happen.
        const scheduler = makeScheduler()
        scheduler.recordEdit(PATH, 1_000)
        expect(scheduler.fire(PATH, 1_000 + IDLE_MS, clearProbe({ runInFlight: true }))).toEqual({
            action: 'skip',
            reason: 'run-in-flight'
        })
        expect(scheduler.nextDueAt(PATH)).toBeNull()
        // The refused fire counts as edited-during-run: the settle re-arms.
        scheduler.syncRunState(PATH, false, 90_000)
        expect(scheduler.nextDueAt(PATH)).toEqual(90_000 + IDLE_MS)
    })

    it('tracks a run that started without any prior edit (user summon), re-arming only on mid-run edits', () => {
        const scheduler = makeScheduler()
        scheduler.syncRunState(PATH, true, 1_000)
        scheduler.recordEdit(PATH, 5_000)
        scheduler.syncRunState(PATH, false, 10_000)
        expect(scheduler.nextDueAt(PATH)).toEqual(10_000 + IDLE_MS)
    })

    it('ignores a settle for a file it never tracked', () => {
        const scheduler = makeScheduler()
        scheduler.syncRunState(PATH, false, 1_000)
        expect(scheduler.nextDueAt(PATH)).toBeNull()
    })
})

// ---------------------------------------------------------------------------
// Fire-time gates: reviewability, changed-hash, oversized
// ---------------------------------------------------------------------------

describe('DaemonScheduler fire-time gates', () => {
    it('skips (and disarms) when the note is no longer reviewable', () => {
        const scheduler = makeScheduler()
        scheduler.recordEdit(PATH, 1_000)
        expect(scheduler.fire(PATH, 1_000 + IDLE_MS, clearProbe({ reviewable: false }))).toEqual({
            action: 'skip',
            reason: 'not-reviewable'
        })
        expect(scheduler.nextDueAt(PATH)).toBeNull()
    })

    it('skips (and disarms) when the text hash equals the last run snapshot — undo back to same', () => {
        const scheduler = makeScheduler()
        scheduler.recordEdit(PATH, 1_000)
        expect(
            scheduler.fire(
                PATH,
                1_000 + IDLE_MS,
                clearProbe({ currentHash: 'same', lastRunHash: 'same' })
            )
        ).toEqual({ action: 'skip', reason: 'unchanged' })
        expect(scheduler.nextDueAt(PATH)).toBeNull()
    })

    it('dispatches a never-reviewed note (no last run hash) after idle', () => {
        const scheduler = makeScheduler()
        scheduler.recordEdit(PATH, 1_000)
        expect(
            scheduler.fire(PATH, 1_000 + IDLE_MS, clearProbe({ lastRunHash: null })).action
        ).toEqual('dispatch')
    })

    it('silently skips oversized notes, flagging the log exactly once per file', () => {
        const scheduler = makeScheduler()
        scheduler.recordEdit(PATH, 1_000)
        expect(scheduler.fire(PATH, 1_000 + IDLE_MS, clearProbe({ oversized: true }))).toEqual({
            action: 'skip',
            reason: 'oversized',
            logOversized: true
        })
        scheduler.recordEdit(PATH, 60_000)
        expect(scheduler.fire(PATH, 60_000 + IDLE_MS, clearProbe({ oversized: true }))).toEqual({
            action: 'skip',
            reason: 'oversized',
            logOversized: false
        })
        // A different file logs independently.
        scheduler.recordEdit(OTHER, 60_000)
        expect(
            scheduler.fire(OTHER, 60_000 + IDLE_MS, clearProbe({ oversized: true })).action
        ).toEqual('skip')
        expect(
            scheduler.fire(OTHER, 60_000 + IDLE_MS, clearProbe({ oversized: true }))
        ).toMatchObject({ reason: 'not-armed' })
    })
})

// ---------------------------------------------------------------------------
// Lifecycle & multi-file independence
// ---------------------------------------------------------------------------

describe('DaemonScheduler lifecycle', () => {
    it('filesClosedUnder drops a whole folder, sparing prefix look-alikes', () => {
        // Obsidian reports a folder rename/delete as ONE event: without the
        // prefix sweep the daemon keeps a schedule for notes that are gone.
        const scheduler = makeScheduler()
        scheduler.recordEdit('Notes/A.md', 1_000)
        scheduler.recordEdit('Notes/Sub/B.md', 1_000)
        scheduler.recordEdit('NotesArchive/C.md', 1_000)
        scheduler.filesClosedUnder('Notes')
        expect(scheduler.armedPaths()).toEqual(['NotesArchive/C.md'])
    })

    it('drops all state when a file closes (arm + oversized log memory)', () => {
        const scheduler = makeScheduler()
        scheduler.recordEdit(PATH, 1_000)
        scheduler.fire(PATH, 1_000 + IDLE_MS, clearProbe({ oversized: true }))
        scheduler.fileClosed(PATH)
        expect(scheduler.nextDueAt(PATH)).toBeNull()
        expect(scheduler.armedPaths()).toEqual([])
        // Re-opened and edited again: the oversized log fires afresh.
        scheduler.recordEdit(PATH, 90_000)
        expect(scheduler.fire(PATH, 90_000 + IDLE_MS, clearProbe({ oversized: true }))).toEqual({
            action: 'skip',
            reason: 'oversized',
            logOversized: true
        })
    })

    it('keeps per-file schedules fully independent', () => {
        const scheduler = makeScheduler()
        scheduler.recordEdit(PATH, 1_000)
        scheduler.recordEdit(OTHER, 10_000)
        scheduler.syncRunState(OTHER, true, 11_000)
        // PATH fires on schedule even though OTHER has a run in flight.
        expect(scheduler.fire(PATH, 1_000 + IDLE_MS, clearProbe()).action).toEqual('dispatch')
        expect(scheduler.nextDueAt(OTHER)).toBeNull()
        scheduler.recordEdit(OTHER, 12_000)
        scheduler.syncRunState(OTHER, false, 20_000)
        expect(scheduler.nextDueAt(OTHER)).toEqual(20_000 + IDLE_MS)
    })

    it('lists exactly the armed files', () => {
        const scheduler = makeScheduler()
        scheduler.recordEdit(PATH, 1_000)
        scheduler.recordEdit(OTHER, 1_000)
        scheduler.syncRunState(OTHER, true, 2_000)
        expect(scheduler.armedPaths()).toEqual([PATH])
    })
})

// ---------------------------------------------------------------------------
// Activity reset (issue #20)
// ---------------------------------------------------------------------------

describe('DaemonScheduler.recordActivity', () => {
    it('postpones a pending arm — the window measures quiet, not just no-typing', () => {
        const scheduler = makeScheduler()
        scheduler.recordEdit(PATH, 1_000)
        expect(scheduler.nextDueAt(PATH)).toEqual(1_000 + IDLE_MS)
        scheduler.recordActivity(PATH, 10_000)
        expect(scheduler.nextDueAt(PATH)).toEqual(10_000 + IDLE_MS)
        // A fire at the ORIGINAL due time comes back as wait-for-the-new-one.
        expect(scheduler.fire(PATH, 1_000 + IDLE_MS, clearProbe())).toEqual({
            action: 'wait',
            dueAt: 10_000 + IDLE_MS
        })
        // Still armed; quiet after the last activity dispatches.
        expect(scheduler.fire(PATH, 10_000 + IDLE_MS, clearProbe())).toEqual({
            action: 'dispatch'
        })
    })

    it('never arms by itself — the changed-text gate stays edit-only', () => {
        const scheduler = makeScheduler()
        scheduler.recordActivity(PATH, 1_000)
        expect(scheduler.nextDueAt(PATH)).toBeNull()
        expect(scheduler.fire(PATH, 1_000 + IDLE_MS, clearProbe())).toEqual({
            action: 'skip',
            reason: 'not-armed'
        })
    })

    it('a fresh edit supersedes older activity (latest signal wins)', () => {
        const scheduler = makeScheduler()
        scheduler.recordEdit(PATH, 1_000)
        scheduler.recordActivity(PATH, 5_000)
        scheduler.recordEdit(PATH, 8_000)
        expect(scheduler.nextDueAt(PATH)).toEqual(8_000 + IDLE_MS)
    })

    it('is ignored while a run is in flight and does not leak into the re-arm', () => {
        const scheduler = makeScheduler()
        scheduler.recordEdit(PATH, 1_000)
        scheduler.syncRunState(PATH, true, 2_000)
        scheduler.recordActivity(PATH, 50_000)
        scheduler.recordEdit(PATH, 51_000) // coalesces into the settle re-arm
        scheduler.syncRunState(PATH, false, 60_000)
        // Re-armed from settle time; the mid-run activity must not postpone.
        expect(scheduler.nextDueAt(PATH)).toEqual(60_000 + IDLE_MS)
    })

    it('does nothing while disabled and keeps files independent', () => {
        const disabled = makeScheduler(false)
        disabled.recordActivity(PATH, 1_000)
        expect(disabled.nextDueAt(PATH)).toBeNull()

        const scheduler = makeScheduler()
        scheduler.recordEdit(PATH, 1_000)
        scheduler.recordEdit(OTHER, 1_000)
        scheduler.recordActivity(OTHER, 20_000)
        expect(scheduler.nextDueAt(PATH)).toEqual(1_000 + IDLE_MS)
        expect(scheduler.nextDueAt(OTHER)).toEqual(20_000 + IDLE_MS)
    })

    it('stale activity is cleared once the arm is consumed', () => {
        const scheduler = makeScheduler()
        scheduler.recordEdit(PATH, 1_000)
        scheduler.recordActivity(PATH, 2_000)
        // Consume the arm (not-reviewable skip).
        expect(scheduler.fire(PATH, 2_000 + IDLE_MS, clearProbe({ reviewable: false }))).toEqual({
            action: 'skip',
            reason: 'not-reviewable'
        })
        // A new arm derives its window from the new edit alone.
        scheduler.recordEdit(PATH, 100_000)
        expect(scheduler.nextDueAt(PATH)).toEqual(100_000 + IDLE_MS)
    })
})

// ---------------------------------------------------------------------------
// Pause / resume (issue #29 — findings hidden)
// ---------------------------------------------------------------------------

describe('DaemonScheduler pause/resume', () => {
    it('reports nothing due while paused, and a stray fire keeps the arm', () => {
        const scheduler = makeScheduler()
        scheduler.recordEdit(PATH, 1_000)
        scheduler.pause(PATH)
        expect(scheduler.nextDueAt(PATH)).toBeNull()
        expect(scheduler.armedPaths()).toEqual([])
        expect(scheduler.fire(PATH, 1_000 + IDLE_MS, clearProbe())).toEqual({
            action: 'skip',
            reason: 'paused'
        })
        // The arm survived: resuming re-derives the window from resume time.
        scheduler.resume(PATH, 50_000)
        expect(scheduler.nextDueAt(PATH)).toEqual(50_000 + IDLE_MS)
    })

    it('edits made while paused arm silently and fire after resume', () => {
        const scheduler = makeScheduler()
        scheduler.pause(PATH)
        scheduler.recordEdit(PATH, 5_000)
        expect(scheduler.nextDueAt(PATH)).toBeNull()
        scheduler.resume(PATH, 20_000)
        expect(scheduler.nextDueAt(PATH)).toEqual(20_000 + IDLE_MS)
        expect(scheduler.fire(PATH, 20_000 + IDLE_MS, clearProbe())).toEqual({
            action: 'dispatch'
        })
    })

    it('resuming a note that never armed stays unarmed — the changed-text gate is untouched', () => {
        const scheduler = makeScheduler()
        scheduler.pause(PATH)
        scheduler.resume(PATH, 10_000)
        expect(scheduler.nextDueAt(PATH)).toBeNull()
    })

    it('pause is per note and cleared by close and by disable', () => {
        const scheduler = makeScheduler()
        scheduler.recordEdit(PATH, 1_000)
        scheduler.recordEdit(OTHER, 1_000)
        scheduler.pause(PATH)
        expect(scheduler.nextDueAt(PATH)).toBeNull()
        expect(scheduler.nextDueAt(OTHER)).toEqual(1_000 + IDLE_MS)
        // Close drops the pause with the rest of the file state.
        scheduler.fileClosed(PATH)
        scheduler.recordEdit(PATH, 2_000)
        expect(scheduler.nextDueAt(PATH)).toEqual(2_000 + IDLE_MS)
        // Disable clears every pause; re-enabling starts clean.
        scheduler.pause(PATH)
        scheduler.setConfig({ enabled: false, idleMs: IDLE_MS })
        scheduler.setConfig({ enabled: true, idleMs: IDLE_MS })
        scheduler.recordEdit(PATH, 3_000)
        expect(scheduler.nextDueAt(PATH)).toEqual(3_000 + IDLE_MS)
    })
})
