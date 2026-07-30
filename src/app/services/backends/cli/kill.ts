/**
 * Terminating a CLI agent, and knowing that it worked.
 *
 * An agent is not one process. `claude` spawns `git`, `rg`, a language
 * server, whatever its tools need; killing the process the plugin holds a
 * handle to leaves the rest of that tree running, still holding the note's
 * text, still able to make network calls, with nothing left to cancel it. So
 * cancellation and timeout target the TREE, and the result is verified rather
 * than assumed — "we sent SIGTERM" is not the same claim as "nothing is
 * running".
 *
 * Two mechanisms, because the platforms genuinely differ:
 *
 * - **POSIX**: the child is spawned `detached`, which makes it a process-group
 *   leader whose group id equals its pid. `kill(-pid, sig)` then reaches every
 *   descendant that did not deliberately leave the group, and `kill(-pid, 0)`
 *   answers "is anything in that group still alive?" — which is exactly the
 *   verification signal we need, and the reason the group is worth having.
 * - **Windows**: there are no process groups in that sense. `taskkill /T /F`
 *   walks the job tree; verification falls back to probing the root process.
 *
 * Escalation is the same on both: ask politely, wait a bounded grace period
 * so a tool can flush and clean up, then stop asking. A tool that ignores
 * SIGTERM does not get to keep running.
 *
 * The escalation loop itself is pure — it takes "send" and "is alive" as
 * functions — so every branch (already gone, dies on TERM, needs KILL,
 * survives KILL) is a spec instead of a race. The POSIX implementations of
 * those two functions are three lines each in `node-process.ts`, and the
 * end-to-end path is exercised for real against a sleeping child.
 */

export type KillResult =
    /** Nothing was running by the time we looked. */
    | 'already-gone'
    /** Terminated after the graceful signal. */
    | 'terminated'
    /** Ignored the graceful signal; terminated after the forced one. */
    | 'force-terminated'
    /** Still alive after the forced signal — the caller must report a leak. */
    | 'survived'

export interface KillEscalationInput {
    /**
     * Sends a signal to the target. Must resolve normally when the target is
     * already gone (there is nothing to fail about) and may reject only for a
     * genuine error, which is treated as "cannot terminate".
     */
    send(signal: 'graceful' | 'forced'): Promise<void>
    /** Whether ANY process in the target tree is still running. */
    isAlive(): boolean
    /** How long to wait after each signal before escalating or giving up. */
    readonly graceMs: number
    /** How often to re-check liveness while waiting. */
    readonly pollMs: number
    /** Injected in specs so the escalation runs without real time passing. */
    sleep(ms: number): Promise<void>
}

/** Polls until the tree is gone or the budget runs out. Returns liveness. */
async function waitForDeath(input: KillEscalationInput): Promise<boolean> {
    let waited = 0
    while (waited < input.graceMs) {
        if (!input.isAlive()) {
            return false
        }
        const step = Math.min(input.pollMs, input.graceMs - waited)
        await input.sleep(step)
        waited += step
    }
    return input.isAlive()
}

/**
 * Runs the graceful-then-forced escalation and reports what actually
 * happened.
 *
 * The liveness check comes FIRST: a process that already exited must not be
 * signalled, because on POSIX its pid can be recycled and a stale `-pid` is a
 * live process group belonging to someone else.
 */
export async function runKillEscalation(input: KillEscalationInput): Promise<KillResult> {
    if (!input.isAlive()) {
        return 'already-gone'
    }
    await input.send('graceful')
    if (!(await waitForDeath(input))) {
        return 'terminated'
    }
    await input.send('forced')
    if (!(await waitForDeath(input))) {
        return 'force-terminated'
    }
    return 'survived'
}

/** Long enough for a tool to flush and clean up, short enough to be a cancel. */
export const DEFAULT_KILL_GRACE_MS = 2_000

/** Fast enough that a cancel feels instant, slow enough not to spin. */
export const DEFAULT_KILL_POLL_MS = 25
