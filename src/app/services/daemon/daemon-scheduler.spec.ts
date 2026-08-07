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

describe('DaemonScheduler.recordEditorActivity', () => {
    it('postpones a pending arm — the window measures quiet, not just no-typing', () => {
        const scheduler = makeScheduler()
        scheduler.recordEdit(PATH, 1_000)
        expect(scheduler.nextDueAt(PATH)).toEqual(1_000 + IDLE_MS)
        scheduler.recordEditorActivity(PATH, 10_000)
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
        scheduler.recordEditorActivity(PATH, 1_000)
        expect(scheduler.nextDueAt(PATH)).toBeNull()
        expect(scheduler.fire(PATH, 1_000 + IDLE_MS, clearProbe())).toEqual({
            action: 'skip',
            reason: 'not-armed'
        })
    })

    it('a fresh edit supersedes older activity (latest signal wins)', () => {
        const scheduler = makeScheduler()
        scheduler.recordEdit(PATH, 1_000)
        scheduler.recordEditorActivity(PATH, 5_000)
        scheduler.recordEdit(PATH, 8_000)
        expect(scheduler.nextDueAt(PATH)).toEqual(8_000 + IDLE_MS)
    })

    it('is ignored while a run is in flight and does not leak into the re-arm', () => {
        const scheduler = makeScheduler()
        scheduler.recordEdit(PATH, 1_000)
        scheduler.syncRunState(PATH, true, 2_000)
        scheduler.recordEditorActivity(PATH, 50_000)
        scheduler.recordEdit(PATH, 51_000) // coalesces into the settle re-arm
        scheduler.syncRunState(PATH, false, 60_000)
        // Re-armed from settle time; the mid-run activity must not postpone.
        expect(scheduler.nextDueAt(PATH)).toEqual(60_000 + IDLE_MS)
    })

    it('does nothing while disabled and keeps files independent', () => {
        const disabled = makeScheduler(false)
        disabled.recordEditorActivity(PATH, 1_000)
        expect(disabled.nextDueAt(PATH)).toBeNull()

        const scheduler = makeScheduler()
        scheduler.recordEdit(PATH, 1_000)
        scheduler.recordEdit(OTHER, 1_000)
        scheduler.recordEditorActivity(OTHER, 20_000)
        expect(scheduler.nextDueAt(PATH)).toEqual(1_000 + IDLE_MS)
        expect(scheduler.nextDueAt(OTHER)).toEqual(20_000 + IDLE_MS)
    })

    it('stale activity is cleared once the arm is consumed', () => {
        const scheduler = makeScheduler()
        scheduler.recordEdit(PATH, 1_000)
        scheduler.recordEditorActivity(PATH, 2_000)
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
// Two-tier activity: triage never postpones (carve-out, 2026-08-06)
// ---------------------------------------------------------------------------

describe('DaemonScheduler.recordTriageActivity', () => {
    it('does NOT postpone a pending arm — the due time stays at the edit', () => {
        const scheduler = makeScheduler()
        scheduler.recordEdit(PATH, 1_000)
        scheduler.recordTriageActivity(PATH)
        expect(scheduler.nextDueAt(PATH)).toEqual(1_000 + IDLE_MS)
        // The refresh dispatches at the original due time even though the
        // user was triaging the whole window.
        expect(scheduler.fire(PATH, 1_000 + IDLE_MS, clearProbe())).toEqual({
            action: 'dispatch'
        })
    })

    it('editor activity postpones where triage does not (tier contrast)', () => {
        const editorSide = makeScheduler()
        editorSide.recordEdit(PATH, 1_000)
        editorSide.recordEditorActivity(PATH, 2_000)
        expect(editorSide.nextDueAt(PATH)).toEqual(2_000 + IDLE_MS)

        const triageSide = makeScheduler()
        triageSide.recordEdit(PATH, 1_000)
        triageSide.recordTriageActivity(PATH)
        expect(triageSide.nextDueAt(PATH)).toEqual(1_000 + IDLE_MS)
    })

    it('never arms by itself, exactly like editor activity', () => {
        const scheduler = makeScheduler()
        scheduler.recordTriageActivity(PATH)
        expect(scheduler.nextDueAt(PATH)).toBeNull()
        expect(scheduler.fire(PATH, IDLE_MS, clearProbe())).toEqual({
            action: 'skip',
            reason: 'not-armed'
        })
    })

    it('an edit → triage burst fires one idle window after the edit', () => {
        // Bug B's user story: type (arm), then accept/dismiss findings for
        // a while — the refresh must fire idleMs after the EDIT, not after
        // the last triage click.
        const scheduler = makeScheduler()
        scheduler.recordEdit(PATH, 1_000)
        scheduler.recordTriageActivity(PATH)
        scheduler.recordTriageActivity(PATH)
        expect(scheduler.fire(PATH, 1_000 + IDLE_MS, clearProbe())).toEqual({
            action: 'dispatch'
        })
    })
})

describe('DaemonScheduler.recordTriageEdit', () => {
    it('does NOT move an armed window — accepting at the end of a quiet window keeps the deadline', () => {
        // The adversarial-review scenario: type (arm), wait almost the whole
        // window, then accept a finding. The accept CHANGES the doc, so it
        // reaches the edit stream — but it must not restart the countdown.
        const scheduler = makeScheduler()
        scheduler.recordEdit(PATH, 1_000)
        scheduler.recordTriageEdit(PATH, 1_000 + IDLE_MS - 1)
        expect(scheduler.nextDueAt(PATH)).toEqual(1_000 + IDLE_MS)
        expect(scheduler.fire(PATH, 1_000 + IDLE_MS, clearProbe())).toEqual({
            action: 'dispatch'
        })
    })

    it('a keystroke restarts the window where a triage edit does not (tier contrast)', () => {
        const editSide = makeScheduler()
        editSide.recordEdit(PATH, 1_000)
        editSide.recordEdit(PATH, 10_000)
        expect(editSide.nextDueAt(PATH)).toEqual(10_000 + IDLE_MS)

        const triageSide = makeScheduler()
        triageSide.recordEdit(PATH, 1_000)
        triageSide.recordTriageEdit(PATH, 10_000)
        expect(triageSide.nextDueAt(PATH)).toEqual(1_000 + IDLE_MS)
    })

    it('ARMS an unarmed note — unlike triage activity, the text changed and must refresh', () => {
        // Accepting a finding with no window pending (e.g. right after a run
        // settled with no further edits): the accepted text is new text, so
        // the note arms exactly like an edit would.
        const scheduler = makeScheduler()
        scheduler.recordTriageEdit(PATH, 5_000)
        expect(scheduler.nextDueAt(PATH)).toEqual(5_000 + IDLE_MS)
        expect(scheduler.fire(PATH, 5_000 + IDLE_MS, clearProbe())).toEqual({
            action: 'dispatch'
        })
    })

    it('arming clears stale editor activity, exactly like an edit', () => {
        const scheduler = makeScheduler()
        scheduler.recordEdit(PATH, 1_000)
        scheduler.recordEditorActivity(PATH, 4_000)
        // The activity was recorded while armed; consume the arm via fire,
        // then a fresh triage-edit arm must not resurrect it.
        scheduler.fire(PATH, 4_000 + IDLE_MS, clearProbe())
        scheduler.recordTriageEdit(PATH, 100_000)
        expect(scheduler.nextDueAt(PATH)).toEqual(100_000 + IDLE_MS)
    })

    it('keeps an armed window with recorded activity where it was — the postponed due time stands', () => {
        const scheduler = makeScheduler()
        scheduler.recordEdit(PATH, 1_000)
        scheduler.recordEditorActivity(PATH, 5_000)
        scheduler.recordTriageEdit(PATH, 9_000)
        expect(scheduler.nextDueAt(PATH)).toEqual(5_000 + IDLE_MS)
    })

    it('coalesces during a run exactly like an edit: one re-arm at settle', () => {
        const scheduler = makeScheduler()
        scheduler.recordEdit(PATH, 1_000)
        scheduler.syncRunState(PATH, true, 2_000)
        scheduler.recordTriageEdit(PATH, 3_000)
        expect(scheduler.nextDueAt(PATH)).toBeNull()
        scheduler.syncRunState(PATH, false, 10_000)
        // Re-armed from settle time — the triage edit was not lost.
        expect(scheduler.nextDueAt(PATH)).toEqual(10_000 + IDLE_MS)
    })

    it('is a no-op while disabled', () => {
        const scheduler = makeScheduler(false)
        scheduler.recordTriageEdit(PATH, 1_000)
        expect(scheduler.nextDueAt(PATH)).toBeNull()
        expect(scheduler.armedPaths()).toEqual([])
    })
})

// ---------------------------------------------------------------------------
// Rename remapping (a rename is not a close — adversarial review 2026-08-06)
// ---------------------------------------------------------------------------

describe('DaemonScheduler.filesRenamedUnder', () => {
    it('moves a pending arm to the renamed path — due time intact', () => {
        const scheduler = makeScheduler()
        scheduler.recordEdit(PATH, 1_000)
        const moved = scheduler.filesRenamedUnder(PATH, 'Renamed/A.md')
        expect(moved).toEqual(['Renamed/A.md'])
        expect(scheduler.nextDueAt(PATH)).toBeNull()
        expect(scheduler.nextDueAt('Renamed/A.md')).toEqual(1_000 + IDLE_MS)
        expect(scheduler.fire('Renamed/A.md', 1_000 + IDLE_MS, clearProbe())).toEqual({
            action: 'dispatch'
        })
    })

    it('remaps a whole folder, sparing prefix look-alikes', () => {
        const scheduler = makeScheduler()
        scheduler.recordEdit('Notes/A.md', 1_000)
        scheduler.recordEdit('Notes/Sub/B.md', 2_000)
        scheduler.recordEdit('NotesArchive/C.md', 3_000)
        scheduler.filesRenamedUnder('Notes', 'Moved')
        expect(scheduler.armedPaths().sort()).toEqual([
            'Moved/A.md',
            'Moved/Sub/B.md',
            'NotesArchive/C.md'
        ])
    })

    it('the oversized once-per-file log marker follows the file', () => {
        const scheduler = makeScheduler()
        scheduler.recordEdit(PATH, 1_000)
        expect(scheduler.fire(PATH, 1_000 + IDLE_MS, clearProbe({ oversized: true }))).toEqual({
            action: 'skip',
            reason: 'oversized',
            logOversized: true
        })
        scheduler.filesRenamedUnder(PATH, 'Renamed/A.md')
        scheduler.recordEdit('Renamed/A.md', 90_000)
        // Same note, new name: no second log line.
        expect(
            scheduler.fire('Renamed/A.md', 90_000 + IDLE_MS, clearProbe({ oversized: true }))
        ).toEqual({ action: 'skip', reason: 'oversized', logOversized: false })
    })

    it('DROPS the pause marker: the controller clears findings-hidden on rename, so a remapped pause would stick forever', () => {
        const scheduler = makeScheduler()
        scheduler.recordEdit(PATH, 1_000)
        scheduler.pause(PATH)
        scheduler.filesRenamedUnder(PATH, 'Renamed/A.md')
        // The arm moved AND is live — nothing is left paused at either path.
        expect(scheduler.nextDueAt('Renamed/A.md')).toEqual(1_000 + IDLE_MS)
        expect(scheduler.nextDueAt(PATH)).toBeNull()
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

// ---------------------------------------------------------------------------
// Immediate arm on enable (Sébastien, 2026-08-07)
// ---------------------------------------------------------------------------

describe('DaemonScheduler armImmediate', () => {
    it('is due at once, with no idle window to wait out', () => {
        const scheduler = makeScheduler()
        scheduler.armImmediate(PATH, 1_000)
        expect(scheduler.nextDueAt(PATH)).toEqual(1_000)
        expect(scheduler.fire(PATH, 1_000, clearProbe())).toEqual({ action: 'dispatch' })
    })

    it('reviews a never-reviewed note on enable', () => {
        const scheduler = makeScheduler()
        scheduler.armImmediate(PATH, 1_000)
        expect(scheduler.fire(PATH, 1_000, clearProbe({ lastRunHash: null }))).toEqual({
            action: 'dispatch'
        })
    })

    it('spends no request when the note was already reviewed unchanged', () => {
        const scheduler = makeScheduler()
        scheduler.armImmediate(PATH, 1_000)
        expect(
            scheduler.fire(PATH, 1_000, clearProbe({ currentHash: 'h', lastRunHash: 'h' }))
        ).toEqual({ action: 'skip', reason: 'unchanged' })
    })

    it('still honours every other fire gate', () => {
        const notReviewable = makeScheduler()
        notReviewable.armImmediate(PATH, 1_000)
        expect(notReviewable.fire(PATH, 1_000, clearProbe({ reviewable: false }))).toEqual({
            action: 'skip',
            reason: 'not-reviewable'
        })

        const oversized = makeScheduler()
        oversized.armImmediate(PATH, 1_000)
        expect(oversized.fire(PATH, 1_000, clearProbe({ oversized: true }))).toEqual({
            action: 'skip',
            reason: 'oversized',
            logOversized: true
        })

        const paused = makeScheduler()
        paused.armImmediate(PATH, 1_000)
        paused.pause(PATH)
        expect(paused.nextDueAt(PATH)).toBeNull()
        expect(paused.fire(PATH, 1_000, clearProbe())).toEqual({
            action: 'skip',
            reason: 'paused'
        })
    })

    it('no-ops while disabled and while a run is in flight', () => {
        const disabled = makeScheduler(false)
        disabled.armImmediate(PATH, 1_000)
        expect(disabled.nextDueAt(PATH)).toBeNull()

        // A run in flight IS the review the enable gesture asks for.
        const running = makeScheduler()
        running.syncRunState(PATH, true, 500)
        running.armImmediate(PATH, 1_000)
        expect(running.nextDueAt(PATH)).toBeNull()
        // ...and it must not fabricate a re-arm at settle either.
        running.syncRunState(PATH, false, 2_000)
        expect(running.nextDueAt(PATH)).toBeNull()
    })

    it('reverts to the normal idle window on the next edit', () => {
        const scheduler = makeScheduler()
        scheduler.armImmediate(PATH, 1_000)
        scheduler.recordEdit(PATH, 2_000)
        expect(scheduler.nextDueAt(PATH)).toEqual(2_000 + IDLE_MS)
    })

    it('does not survive resume: un-hiding waits the full quiet window', () => {
        const scheduler = makeScheduler()
        scheduler.armImmediate(PATH, 1_000)
        scheduler.pause(PATH)
        scheduler.resume(PATH, 5_000)
        expect(scheduler.nextDueAt(PATH)).toEqual(5_000 + IDLE_MS)
    })

    it('is consumed by its own fire — a second timer finds nothing armed', () => {
        const scheduler = makeScheduler()
        scheduler.armImmediate(PATH, 1_000)
        expect(scheduler.fire(PATH, 1_000, clearProbe())).toEqual({ action: 'dispatch' })
        expect(scheduler.nextDueAt(PATH)).toBeNull()
        expect(scheduler.fire(PATH, 1_500, clearProbe())).toEqual({
            action: 'skip',
            reason: 'not-armed'
        })
    })
})
