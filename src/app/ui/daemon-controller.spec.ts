import { beforeEach, describe, expect, it } from 'bun:test'
import { createSnapshot } from '../domain/snapshot'
import { pluginSettingsSchema } from '../domain/settings/settings-schema'
import type { PluginSettingsV1 } from '../domain/settings/settings-schema'
import type { OperationEvent } from '../domain/operations/contract'
import { RunController } from '../services/orchestration/run-controller'
import type { RunEditorSpec } from '../services/orchestration/run-controller'
import { DaemonController } from './daemon-controller'
import type { DaemonReviewPort } from './daemon-controller'

/**
 * Fire-time editor resolution (acceptance-pinned): a daemon dispatch derives
 * its editor set when the timer FIRES — from the note's current run filtered
 * against the LIVE settings — never from a set captured when the edit armed
 * the timer. An editor disabled between the run and the fire must not be
 * re-dispatched; its findings are hidden, not purged (`editor-visibility.ts`).
 *
 * The controller's timer seam (`setTimer`/`clearTimer` deps) takes a
 * manual-fire fake here — Bun has no `window`, and firing by hand is what
 * makes the idle countdown controllable.
 */

const NOTE_PATH = 'notes/test.md'

interface FakeTimers {
    readonly setTimer: (callback: () => void, ms: number) => number
    readonly clearTimer: (handle: number) => void
    fireAll(): void
    pendingCount(): number
}

function makeFakeTimers(): FakeTimers {
    const pending = new Map<number, () => void>()
    let nextId = 1
    return {
        setTimer: (callback: () => void, _ms: number): number => {
            const id = nextId
            nextId += 1
            pending.set(id, callback)
            return id
        },
        clearTimer: (id: number): void => {
            pending.delete(id)
        },
        fireAll: (): void => {
            const callbacks = [...pending.values()]
            pending.clear()
            for (const callback of callbacks) {
                callback()
            }
        },
        pendingCount: (): number => pending.size
    }
}

/** Editor whose stream settles immediately with an empty review. */
function instantEditor(editorId: string): RunEditorSpec {
    return {
        editorId,
        editorName: `Editor ${editorId}`,
        execute: async function* (request): AsyncIterable<OperationEvent> {
            await Promise.resolve()
            yield {
                type: 'result',
                runId: request.runId,
                result: { kind: 'review', findings: [] }
            }
        }
    }
}

function makeSettings(
    editors: readonly { id: string; enabled: boolean }[],
    daemonAlwaysOn = true
): PluginSettingsV1 {
    return pluginSettingsSchema.parse({
        editors: editors.map((editor) => ({
            id: editor.id,
            name: `Editor ${editor.id}`,
            enabled: editor.enabled
        })),
        // Always-on keeps the fire-time specs note-agnostic; the per-note
        // default-off contract has its own describe block below.
        behavior: { daemonAlwaysOn }
    })
}

interface DispatchCall {
    readonly path: string
    readonly editorIds: readonly string[] | null
    readonly panelId: string | null
}

function makePort(): { port: DaemonReviewPort; calls: DispatchCall[] } {
    const calls: DispatchCall[] = []
    const port: DaemonReviewPort = {
        canReviewPath: (): boolean => true,
        // A hash different from any snapshot's: the changed-text gate passes.
        probeDaemonNote: () => ({ hash: 'live-text-hash', wordCount: 10 }),
        startDaemonReview: (path, editorIds, panelId): Promise<'started' | 'refused'> => {
            calls.push({ path, editorIds, panelId })
            // 'refused' keeps the failure tracker out of these specs.
            return Promise.resolve('refused')
        },
        disableDaemonMode: (): void => {
            // Never expected here.
        }
    }
    return { port, calls }
}

describe('DaemonController fire-time editor resolution', () => {
    let timers: FakeTimers

    beforeEach(() => {
        timers = makeFakeTimers()
    })

    async function settledRun(runController: RunController, editorIds: readonly string[]) {
        const run = runController.startRun({
            snapshot: createSnapshot({ filePath: NOTE_PATH, text: 'The quick brown fox.' }),
            editors: editorIds.map((id) => instantEditor(id))
        })
        await run.settled
        return run
    }

    function makeController(
        getSettings: () => PluginSettingsV1,
        runController: RunController,
        port: DaemonReviewPort
    ): { controller: DaemonController; armAndFire: () => void } {
        // Injected clock: the edit arms at t=0, then the clock jumps past the
        // idle window before the fake timer fires — so the scheduler sees an
        // elapsed countdown and decides 'dispatch', not 'wait'.
        let t = 0
        const controller = new DaemonController({
            getSettings,
            runController,
            port,
            onStateChange: (): void => {
                // State pulses are irrelevant to these specs.
            },
            now: (): number => t,
            setTimer: timers.setTimer,
            clearTimer: timers.clearTimer
        })
        return {
            controller,
            armAndFire: (): void => {
                controller.recordEdit(NOTE_PATH)
                t += 60_000 // far past any idle window
                timers.fireAll()
            }
        }
    }

    it('drops an editor disabled AFTER the run was created: the set is resolved at fire time', async () => {
        const runController = new RunController()
        await settledRun(runController, ['e-1', 'e-2'])
        // The run knows e-1 AND e-2; by fire time the settings disable e-2.
        let settings = makeSettings([
            { id: 'e-1', enabled: true },
            { id: 'e-2', enabled: true }
        ])
        const { port, calls } = makePort()
        const { controller, armAndFire } = makeController(() => settings, runController, port)
        settings = makeSettings([
            { id: 'e-1', enabled: true },
            { id: 'e-2', enabled: false }
        ])
        armAndFire()
        expect(calls).toEqual([{ path: NOTE_PATH, editorIds: ['e-1'], panelId: null }])
        controller.dispose()
    })

    it('passes an EMPTY set (never null) when every captured editor is disabled', async () => {
        const runController = new RunController()
        await settledRun(runController, ['e-1', 'e-2'])
        const settings = makeSettings([
            { id: 'e-1', enabled: false },
            { id: 'e-2', enabled: false }
        ])
        const { port, calls } = makePort()
        const { controller, armAndFire } = makeController(() => settings, runController, port)
        armAndFire()
        // [] refuses inside the pipeline (`no-editors`) — null would widen
        // the refresh to the full default pool behind the user's back.
        expect(calls).toEqual([{ path: NOTE_PATH, editorIds: [], panelId: null }])
        controller.dispose()
    })

    it('keeps a deleted (not disabled) editor in the set: the pipeline reports it, the daemon does not judge', async () => {
        const runController = new RunController()
        await settledRun(runController, ['e-1', 'e-gone'])
        // 'e-gone' is absent from the settings entirely: not disabled.
        const settings = makeSettings([{ id: 'e-1', enabled: true }])
        const { port, calls } = makePort()
        const { controller, armAndFire } = makeController(() => settings, runController, port)
        armAndFire()
        expect(calls).toEqual([{ path: NOTE_PATH, editorIds: ['e-1', 'e-gone'], panelId: null }])
        controller.dispose()
    })

    it('sends null (the default pool) for a never-reviewed note', () => {
        const runController = new RunController()
        const settings = makeSettings([
            { id: 'e-1', enabled: true },
            { id: 'e-2', enabled: false }
        ])
        const { port, calls } = makePort()
        const { controller, armAndFire } = makeController(() => settings, runController, port)
        armAndFire()
        // The pipeline's default pool is already enabled-only
        // (`resolveReviewParticipants`); the daemon has no set to resolve.
        expect(calls).toEqual([{ path: NOTE_PATH, editorIds: null, panelId: null }])
        controller.dispose()
    })
})

/**
 * Per-note daemon mode (Sébastien, 2026-08-06): each note starts from the
 * `behavior.daemonAlwaysOn` default (off unless that setting is on), the
 * per-note toggle is runtime-only, and closing the note drops the choice.
 */
describe('DaemonController per-note enablement', () => {
    let timers: FakeTimers

    beforeEach(() => {
        timers = makeFakeTimers()
    })

    function makeController(getSettings: () => PluginSettingsV1, port: DaemonReviewPort) {
        let t = 0
        const controller = new DaemonController({
            getSettings,
            runController: new RunController(),
            port,
            onStateChange: (): void => {
                // State pulses are irrelevant to these specs.
            },
            now: (): number => t,
            setTimer: timers.setTimer,
            clearTimer: timers.clearTimer
        })
        return {
            controller,
            fireLater: (): void => {
                t += 60_000
                timers.fireAll()
            }
        }
    }

    it('defaults every note to OFF while always-on is off: edits never arm', () => {
        const settings = makeSettings([{ id: 'e-1', enabled: true }], false)
        const { port, calls } = makePort()
        const { controller, fireLater } = makeController(() => settings, port)
        expect(controller.isEnabledFor(NOTE_PATH)).toBe(false)
        controller.recordEdit(NOTE_PATH)
        expect(controller.isArmed(NOTE_PATH)).toBe(false)
        expect(timers.pendingCount()).toBe(0)
        fireLater()
        expect(calls).toEqual([])
        controller.dispose()
    })

    it('enabling ONE note arms that note only, and only from new edits', () => {
        const settings = makeSettings([{ id: 'e-1', enabled: true }], false)
        const { port, calls } = makePort()
        const { controller, fireLater } = makeController(() => settings, port)
        controller.setEnabledFor(NOTE_PATH, true)
        expect(controller.isEnabledFor(NOTE_PATH)).toBe(true)
        expect(controller.isEnabledFor('notes/other.md')).toBe(false)
        controller.recordEdit(NOTE_PATH)
        controller.recordEdit('notes/other.md')
        expect(controller.isArmed(NOTE_PATH)).toBe(true)
        expect(controller.isArmed('notes/other.md')).toBe(false)
        fireLater()
        expect(calls).toEqual([{ path: NOTE_PATH, editorIds: null, panelId: null }])
        controller.dispose()
    })

    it('turning a note OFF drops its pending arm and timer (cost kill-switch)', () => {
        const settings = makeSettings([{ id: 'e-1', enabled: true }], false)
        const { port, calls } = makePort()
        const { controller, fireLater } = makeController(() => settings, port)
        controller.setEnabledFor(NOTE_PATH, true)
        controller.recordEdit(NOTE_PATH)
        expect(timers.pendingCount()).toBe(1)
        controller.setEnabledFor(NOTE_PATH, false)
        expect(controller.isArmed(NOTE_PATH)).toBe(false)
        expect(timers.pendingCount()).toBe(0)
        fireLater()
        expect(calls).toEqual([])
        controller.dispose()
    })

    it('closing the note drops the per-note enable: reopening starts from the default', () => {
        const settings = makeSettings([{ id: 'e-1', enabled: true }], false)
        const { port, calls } = makePort()
        const { controller, fireLater } = makeController(() => settings, port)
        controller.setEnabledFor(NOTE_PATH, true)
        controller.fileClosed(NOTE_PATH)
        expect(controller.isEnabledFor(NOTE_PATH)).toBe(false)
        // "Reopened": the next edit must not arm — per-note enable never
        // persists across close/reopen.
        controller.recordEdit(NOTE_PATH)
        expect(controller.isArmed(NOTE_PATH)).toBe(false)
        fireLater()
        expect(calls).toEqual([])
        controller.dispose()
    })

    it('always-on flips the default: every note starts enabled, per-note off still wins', () => {
        const settings = makeSettings([{ id: 'e-1', enabled: true }], true)
        const { port, calls } = makePort()
        const { controller, fireLater } = makeController(() => settings, port)
        expect(controller.isEnabledFor(NOTE_PATH)).toBe(true)
        controller.setEnabledFor(NOTE_PATH, false)
        expect(controller.isEnabledFor(NOTE_PATH)).toBe(false)
        expect(controller.isEnabledFor('notes/other.md')).toBe(true)
        controller.recordEdit(NOTE_PATH)
        controller.recordEdit('notes/other.md')
        fireLater()
        expect(calls).toEqual([{ path: 'notes/other.md', editorIds: null, panelId: null }])
        // Closing the opted-out note drops the opt-out: a reopen starts
        // from the always-on default again.
        controller.fileClosed(NOTE_PATH)
        expect(controller.isEnabledFor(NOTE_PATH)).toBe(true)
        controller.dispose()
    })

    it('flipping daemonAlwaysOn clears every per-note session choice', () => {
        let settings = makeSettings([{ id: 'e-1', enabled: true }], false)
        const { port, calls } = makePort()
        const { controller, fireLater } = makeController(() => settings, port)
        controller.setEnabledFor(NOTE_PATH, true)
        controller.recordEdit(NOTE_PATH)
        expect(controller.isArmed(NOTE_PATH)).toBe(true)
        // The settings toggle is authoritative: always-on ON then OFF must
        // leave NOTHING enabled — stale per-note enables would keep billing.
        settings = makeSettings([{ id: 'e-1', enabled: true }], true)
        controller.settingsChanged()
        expect(controller.isEnabledFor(NOTE_PATH)).toBe(true)
        settings = makeSettings([{ id: 'e-1', enabled: true }], false)
        controller.settingsChanged()
        expect(controller.isEnabledFor(NOTE_PATH)).toBe(false)
        expect(controller.isArmed(NOTE_PATH)).toBe(false)
        fireLater()
        expect(calls).toEqual([])
        controller.dispose()
    })

    it('disableAllNotes turns every session enable off at once (issue #23)', () => {
        const settings = makeSettings([{ id: 'e-1', enabled: true }], false)
        const { port, calls } = makePort()
        const { controller, fireLater } = makeController(() => settings, port)
        controller.setEnabledFor(NOTE_PATH, true)
        controller.setEnabledFor('notes/other.md', true)
        controller.recordEdit(NOTE_PATH)
        controller.disableAllNotes()
        expect(controller.isEnabledFor(NOTE_PATH)).toBe(false)
        expect(controller.isEnabledFor('notes/other.md')).toBe(false)
        expect(timers.pendingCount()).toBe(0)
        fireLater()
        expect(calls).toEqual([])
        controller.dispose()
    })
})

/**
 * A vault RENAME is not a close (adversarial review 2026-08-06): the views
 * stay open and follow the file. Routing renames through `filesClosedUnder`
 * deleted the runtime per-note override — with always-on ON, an explicitly
 * DISABLED note silently became enabled again (and its next edit could
 * trigger a paid request); with always-on OFF, an explicitly ENABLED note
 * silently went dead. `filesRenamedUnder` remaps instead.
 */
describe('DaemonController rename remapping', () => {
    let timers: FakeTimers

    beforeEach(() => {
        timers = makeFakeTimers()
    })

    function makeController(getSettings: () => PluginSettingsV1, port: DaemonReviewPort) {
        let t = 0
        const controller = new DaemonController({
            getSettings,
            runController: new RunController(),
            port,
            onStateChange: (): void => {
                // State pulses are irrelevant to these specs.
            },
            now: (): number => t,
            setTimer: timers.setTimer,
            clearTimer: timers.clearTimer
        })
        return {
            controller,
            fireLater: (): void => {
                t += 60_000
                timers.fireAll()
            }
        }
    }

    it('a disabled note STAYS disabled across a rename while always-on is ON (the paid-request trap)', () => {
        const settings = makeSettings([{ id: 'e-1', enabled: true }], true)
        const { port, calls } = makePort()
        const { controller, fireLater } = makeController(() => settings, port)
        controller.setEnabledFor(NOTE_PATH, false)
        controller.filesRenamedUnder(NOTE_PATH, 'notes/renamed.md')
        expect(controller.isEnabledFor('notes/renamed.md')).toBe(false)
        // The next edit at the new path must not arm — the user said no.
        controller.recordEdit('notes/renamed.md')
        expect(controller.isArmed('notes/renamed.md')).toBe(false)
        fireLater()
        expect(calls).toEqual([])
        controller.dispose()
    })

    it('an enabled note STAYS enabled across a rename while always-on is OFF', () => {
        const settings = makeSettings([{ id: 'e-1', enabled: true }], false)
        const { port, calls } = makePort()
        const { controller, fireLater } = makeController(() => settings, port)
        controller.setEnabledFor(NOTE_PATH, true)
        controller.filesRenamedUnder(NOTE_PATH, 'notes/renamed.md')
        expect(controller.isEnabledFor('notes/renamed.md')).toBe(true)
        expect(controller.isEnabledFor(NOTE_PATH)).toBe(false)
        controller.recordEdit('notes/renamed.md')
        fireLater()
        expect(calls).toEqual([{ path: 'notes/renamed.md', editorIds: null, panelId: null }])
        controller.dispose()
    })

    it('a pending arm and its real timer follow the file', () => {
        const settings = makeSettings([{ id: 'e-1', enabled: true }], true)
        const { port, calls } = makePort()
        const { controller, fireLater } = makeController(() => settings, port)
        controller.recordEdit(NOTE_PATH)
        expect(timers.pendingCount()).toBe(1)
        controller.filesRenamedUnder(NOTE_PATH, 'notes/renamed.md')
        // Still exactly one timer, now owned by the new path.
        expect(timers.pendingCount()).toBe(1)
        expect(controller.isArmed(NOTE_PATH)).toBe(false)
        expect(controller.isArmed('notes/renamed.md')).toBe(true)
        fireLater()
        expect(calls).toEqual([{ path: 'notes/renamed.md', editorIds: null, panelId: null }])
        controller.dispose()
    })

    it('a FOLDER rename moves every override and arm under it, sparing prefix look-alikes', () => {
        const settings = makeSettings([{ id: 'e-1', enabled: true }], true)
        const { port, calls } = makePort()
        const { controller, fireLater } = makeController(() => settings, port)
        controller.setEnabledFor('folder/a.md', false)
        controller.recordEdit('folder/sub/b.md')
        controller.setEnabledFor('folderish/c.md', false)
        controller.filesRenamedUnder('folder', 'moved')
        expect(controller.isEnabledFor('moved/a.md')).toBe(false)
        expect(controller.isArmed('moved/sub/b.md')).toBe(true)
        // The look-alike sibling kept its own state where it was.
        expect(controller.isEnabledFor('folderish/c.md')).toBe(false)
        fireLater()
        expect(calls).toEqual([{ path: 'moved/sub/b.md', editorIds: null, panelId: null }])
        controller.dispose()
    })

    it('a DELETE still drops everything (the close contract is untouched)', () => {
        const settings = makeSettings([{ id: 'e-1', enabled: true }], false)
        const { port, calls } = makePort()
        const { controller, fireLater } = makeController(() => settings, port)
        controller.setEnabledFor(NOTE_PATH, true)
        controller.recordEdit(NOTE_PATH)
        controller.filesClosedUnder('notes')
        expect(controller.isEnabledFor(NOTE_PATH)).toBe(false)
        expect(timers.pendingCount()).toBe(0)
        fireLater()
        expect(calls).toEqual([])
        controller.dispose()
    })
})

/**
 * Issue #23 suspension latch: `disableAllNotes` must kill every automatic
 * refresh synchronously and unconditionally — INCLUDING while
 * `behavior.daemonAlwaysOn` is ON, where the default would otherwise read
 * "enabled" again immediately. The latch is what makes the auto-disable
 * effective even when persisting the setting off fails (disk full, sync
 * conflict): the runtime kill never depends on the write landing.
 */
describe('DaemonController issue #23 suspension latch (always-on stays on)', () => {
    let timers: FakeTimers

    beforeEach(() => {
        timers = makeFakeTimers()
    })

    function makeController(getSettings: () => PluginSettingsV1, port: DaemonReviewPort) {
        let t = 0
        // Copies of every scheduled callback survive `clearTimer`, so a
        // callback the event loop already dequeued can be replayed AFTER
        // `disableAllNotes` — the race a real timer can lose.
        const dequeued: (() => void)[] = []
        const controller = new DaemonController({
            getSettings,
            runController: new RunController(),
            port,
            onStateChange: (): void => {
                // State pulses are irrelevant to these specs.
            },
            now: (): number => t,
            setTimer: (callback, ms): number => {
                dequeued.push(callback)
                return timers.setTimer(callback, ms)
            },
            clearTimer: timers.clearTimer
        })
        return {
            controller,
            advance: (): void => {
                t += 60_000
            },
            fireLater: (): void => {
                t += 60_000
                timers.fireAll()
            },
            replayDequeued: (): void => {
                for (const callback of [...dequeued]) {
                    callback()
                }
            }
        }
    }

    it('disables every note even though the always-on default still reads enabled', () => {
        const settings = makeSettings([{ id: 'e-1', enabled: true }], true)
        const { port, calls } = makePort()
        const { controller, fireLater } = makeController(() => settings, port)
        expect(controller.isEnabledFor(NOTE_PATH)).toBe(true)
        controller.recordEdit(NOTE_PATH)
        expect(controller.isArmed(NOTE_PATH)).toBe(true)
        controller.disableAllNotes()
        expect(controller.isEnabledFor(NOTE_PATH)).toBe(false)
        expect(controller.isArmed(NOTE_PATH)).toBe(false)
        expect(timers.pendingCount()).toBe(0)
        // New edits must not re-arm: the always-on default is latched off.
        controller.recordEdit(NOTE_PATH)
        expect(controller.isArmed(NOTE_PATH)).toBe(false)
        fireLater()
        expect(calls).toEqual([])
        controller.dispose()
    })

    it('a timer callback already dequeued when the latch lands dispatches nothing', () => {
        const settings = makeSettings([{ id: 'e-1', enabled: true }], true)
        const { port, calls } = makePort()
        const { controller, advance, replayDequeued } = makeController(() => settings, port)
        controller.recordEdit(NOTE_PATH)
        advance() // past the idle window: the callback would dispatch
        controller.disableAllNotes()
        replayDequeued()
        expect(calls).toEqual([])
        controller.dispose()
    })

    it('a per-note enable lifts the latch (the "try again" gesture)', () => {
        const settings = makeSettings([{ id: 'e-1', enabled: true }], true)
        const { port, calls } = makePort()
        const { controller, fireLater } = makeController(() => settings, port)
        controller.disableAllNotes()
        expect(controller.isEnabledFor(NOTE_PATH)).toBe(false)
        controller.setEnabledFor(NOTE_PATH, true)
        expect(controller.isEnabledFor(NOTE_PATH)).toBe(true)
        controller.recordEdit(NOTE_PATH)
        expect(controller.isArmed(NOTE_PATH)).toBe(true)
        fireLater()
        expect(calls).toEqual([{ path: NOTE_PATH, editorIds: null, panelId: null }])
        controller.dispose()
    })

    it('the daemonAlwaysOn flip lifts the latch (the persisted path landing)', () => {
        let settings = makeSettings([{ id: 'e-1', enabled: true }], true)
        const { port, calls } = makePort()
        const { controller, fireLater } = makeController(() => settings, port)
        controller.disableAllNotes()
        // `setDaemonAlwaysOn(false)` persisted → the observer fires.
        settings = makeSettings([{ id: 'e-1', enabled: true }], false)
        controller.settingsChanged()
        expect(controller.isEnabledFor(NOTE_PATH)).toBe(false)
        // The user turns always-on back ON: normal behavior must be back.
        settings = makeSettings([{ id: 'e-1', enabled: true }], true)
        controller.settingsChanged()
        expect(controller.isEnabledFor(NOTE_PATH)).toBe(true)
        controller.recordEdit(NOTE_PATH)
        fireLater()
        expect(calls).toEqual([{ path: NOTE_PATH, editorIds: null, panelId: null }])
        controller.dispose()
    })

    it('while latched, an unrelated settings change does not resurrect the daemon', () => {
        const settings = makeSettings([{ id: 'e-1', enabled: true }], true)
        const { port, calls } = makePort()
        const { controller, fireLater } = makeController(() => settings, port)
        controller.disableAllNotes()
        // Same always-on value: no flip, so the latch must hold.
        controller.settingsChanged()
        expect(controller.isEnabledFor(NOTE_PATH)).toBe(false)
        controller.recordEdit(NOTE_PATH)
        expect(controller.isArmed(NOTE_PATH)).toBe(false)
        fireLater()
        expect(calls).toEqual([])
        controller.dispose()
    })
})
