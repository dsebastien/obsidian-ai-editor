import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import type { KillEscalationInput, KillResult } from './kill'
import { DEFAULT_KILL_GRACE_MS, DEFAULT_KILL_POLL_MS, runKillEscalation } from './kill'
import type { CliPlatform } from './platform'

/**
 * The process half of the CLI boundary's Node glue: creating a child, and
 * ending its whole tree.
 *
 * Together with `node-fs.ts` this is the complete Node surface the plugin
 * uses. Everything is thin on purpose — the decisions live in `spawn.ts`,
 * `kill.ts`, `executable.ts` and `env.ts`, which are all reachable from
 * specs without a process.
 *
 * Desktop-only (Business Rules #5): the Obsidian renderer this runs in is an
 * Electron one with Node available, and the build already treats `node:*` as
 * external.
 */

/**
 * Every process-creation option the boundary allows.
 *
 * There is no `shell` field, and `createCliChild` is the only way into
 * `node:child_process` from the rest of the plugin — so `shell: false` is not
 * a default someone could override, it is the only reachable state. That is
 * what makes command injection structurally impossible here rather than
 * merely avoided by convention.
 */
export interface CliSpawnOptions {
    readonly cwd: string
    readonly env: Record<string, string>
    /**
     * POSIX: makes the child a process-group leader so the whole tree can be
     * signalled and probed at once. Windows: has no useful group semantics,
     * so the tree is walked by `taskkill /T` instead.
     */
    readonly detached: boolean
}

/**
 * Creates the child. Arguments are copied into a fresh ARRAY, which the OS
 * receives as separate argv entries — no command line is ever assembled, so
 * no quoting rule is ever consulted and no metacharacter means anything.
 *
 * Never `unref`ed: the run waits for this process, and a detached-and-forgotten
 * agent is exactly the leak the boundary exists to prevent.
 */
export function createCliChild(
    executablePath: string,
    args: readonly string[],
    options: CliSpawnOptions
): ChildProcess {
    return spawn(executablePath, [...args], {
        cwd: options.cwd,
        env: options.env,
        detached: options.detached,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true
    })
}

/** The one field of a Node system error this module reads. */
interface ErrnoLike {
    readonly code?: string
}

/** Whether ANY process in the tree rooted at `pid` is still running. */
export function isTreeAlive(platform: CliPlatform, pid: number): boolean {
    // Signal 0 performs the permission and existence check without delivering
    // anything. On POSIX the negative pid asks about the whole process group.
    const target = platform === 'win32' ? pid : -pid
    try {
        process.kill(target, 0)
        return true
    } catch (error) {
        // EPERM means it exists but belongs to someone else — alive, and not
        // ours to kill; ESRCH (and anything else) means gone.
        return (error as ErrnoLike).code === 'EPERM'
    }
}

/** Where `taskkill` lives, resolved explicitly rather than through PATH. */
function taskkillPath(sourceEnv: Readonly<Record<string, string | undefined>>): string {
    const systemRoot = sourceEnv['SystemRoot'] ?? sourceEnv['windir'] ?? 'C:\\Windows'
    return `${systemRoot}\\System32\\taskkill.exe`
}

async function sendPosix(pid: number, signal: 'graceful' | 'forced'): Promise<void> {
    try {
        process.kill(-pid, signal === 'graceful' ? 'SIGTERM' : 'SIGKILL')
    } catch (error) {
        const code = (error as ErrnoLike).code
        if (code === 'ESRCH') {
            return
        }
        if (code === 'EPERM') {
            // The group leader is gone but a descendant changed groups, or the
            // detached spawn did not take. Fall back to the root process; a
            // partial kill beats no kill.
            try {
                process.kill(pid, signal === 'graceful' ? 'SIGTERM' : 'SIGKILL')
            } catch {
                // Nothing left to do; `isAlive` decides the outcome.
            }
            return
        }
        throw error
    }
}

async function sendWindows(
    pid: number,
    sourceEnv: Readonly<Record<string, string | undefined>>
): Promise<void> {
    // `/T` walks the child tree, `/F` forces. There is no graceful variant
    // worth a separate call: Windows' polite path only reaches windowed
    // processes, which a headless CLI agent is not.
    await new Promise<void>((resolve) => {
        const child = spawn(taskkillPath(sourceEnv), ['/PID', String(pid), '/T', '/F'], {
            stdio: 'ignore',
            windowsHide: true
        })
        child.on('error', () => {
            resolve()
        })
        child.on('exit', () => {
            resolve()
        })
    })
}

export interface KillProcessTreeInput {
    readonly platform: CliPlatform
    readonly pid: number
    readonly graceMs?: number
    readonly pollMs?: number
    /** Used only to locate `taskkill.exe`; defaults to the real environment. */
    readonly sourceEnv?: Readonly<Record<string, string | undefined>>
}

/**
 * Ends the tree rooted at `pid` and reports whether it is actually gone.
 *
 * Refuses outright on a pid that is not a plausible child — 0 addresses our
 * own process group and 1 is init; a bug that let either reach here would
 * take Obsidian (or the machine) down with the review.
 */
export async function killProcessTree(input: KillProcessTreeInput): Promise<KillResult> {
    const { pid, platform } = input
    if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid) {
        return 'already-gone'
    }
    const sourceEnv = input.sourceEnv ?? process.env
    const escalation: KillEscalationInput = {
        send:
            platform === 'win32'
                ? (): Promise<void> => sendWindows(pid, sourceEnv)
                : (signal): Promise<void> => sendPosix(pid, signal),
        isAlive: () => isTreeAlive(platform, pid),
        graceMs: input.graceMs ?? DEFAULT_KILL_GRACE_MS,
        pollMs: input.pollMs ?? DEFAULT_KILL_POLL_MS,
        sleep: (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms))
    }
    return runKillEscalation(escalation)
}
