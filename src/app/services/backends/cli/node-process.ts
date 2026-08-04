import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { validateExecutablePath } from './executable'
import type { ExecutableProbe } from './executable'
import type { KillEscalationInput, KillResult } from './kill'
import { DEFAULT_KILL_GRACE_MS, DEFAULT_KILL_POLL_MS, runKillEscalation } from './kill'
import { nodeExecutableProbe } from './node-fs'
import type { CliPlatform } from './platform'
import { sleep } from '../../../../utils/timers'

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

/** The install location Windows guarantees, used when the environment lies. */
const FALLBACK_WINDOWS_ROOT = 'C:\\Windows'

/** Appended to a Windows root to reach the tool. */
const TASKKILL_SUFFIX = '\\System32\\taskkill.exe'

/**
 * Where `taskkill` lives — resolved explicitly rather than through PATH, and
 * then put through the SAME gate as the tool the user configured.
 *
 * `SystemRoot`/`windir` come from the renderer's environment, which is exactly
 * the thing this folder refuses to trust anywhere else. A poisoned value would
 * otherwise redirect the kill at an attacker-chosen binary — so the assembled
 * path is validated, and a path that does not validate falls back to the
 * literal system location rather than being run on faith.
 *
 * Returns the validated absolute path, or null when neither candidate is a
 * runnable program (a Windows install with no `taskkill.exe` is not a machine
 * this plugin can terminate a tree on; `isTreeAlive` then reports the truth).
 */
export function resolveTaskkillPath(
    sourceEnv: Readonly<Record<string, string | undefined>>,
    probe: ExecutableProbe
): string | null {
    const roots = [sourceEnv['SystemRoot'], sourceEnv['windir'], FALLBACK_WINDOWS_ROOT]
    for (const root of roots) {
        if (typeof root !== 'string' || root.length === 0) {
            continue
        }
        const candidate = `${root}${TASKKILL_SUFFIX}`
        const validation = validateExecutablePath({
            platform: 'win32',
            path: candidate,
            probe
        })
        if (validation.ok) {
            return validation.path
        }
    }
    return null
}

/**
 * The environment `taskkill.exe` gets: the two variables Windows needs to
 * create a process at all, derived from the path we just validated rather than
 * copied from the renderer.
 *
 * Inheriting `process.env` here — which is what this call used to do — handed
 * every token in the Obsidian process to a program spawned outside the
 * boundary's own chokepoint, for no benefit: `taskkill` is invoked by absolute
 * path and reads nothing else.
 */
export function taskkillEnv(executablePath: string): Record<string, string> {
    const root = executablePath.endsWith(TASKKILL_SUFFIX)
        ? executablePath.slice(0, executablePath.length - TASKKILL_SUFFIX.length)
        : FALLBACK_WINDOWS_ROOT
    return { SystemRoot: root, windir: root }
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
    sourceEnv: Readonly<Record<string, string | undefined>>,
    probe: ExecutableProbe
): Promise<void> {
    const executablePath = resolveTaskkillPath(sourceEnv, probe)
    if (executablePath === null) {
        // Nothing to run. `isAlive` decides the outcome, which will be
        // `survived` — the honest answer, and the one the caller surfaces.
        return
    }
    // `/T` walks the child tree, `/F` forces. There is no graceful variant
    // worth a separate call: Windows' polite path only reaches windowed
    // processes, which a headless CLI agent is not.
    //
    // Through `createCliChild` like everything else in this folder: same
    // no-shell option type, same argument array, and an environment built
    // here rather than inherited.
    await new Promise<void>((resolve) => {
        let child
        try {
            child = createCliChild(executablePath, ['/PID', String(pid), '/T', '/F'], {
                cwd: taskkillEnv(executablePath)['SystemRoot'] ?? FALLBACK_WINDOWS_ROOT,
                env: taskkillEnv(executablePath),
                detached: false
            })
        } catch {
            resolve()
            return
        }
        // Nothing reads these; draining keeps a chatty refusal from filling a
        // pipe buffer and stalling the exit we are waiting for.
        child.stdout?.resume()
        child.stderr?.resume()
        child.stdin?.end()
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
    /** Seam for the taskkill path check; defaults to the real filesystem. */
    readonly executableProbe?: ExecutableProbe
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
    const probe = input.executableProbe ?? nodeExecutableProbe
    const escalation: KillEscalationInput = {
        send:
            platform === 'win32'
                ? (): Promise<void> => sendWindows(pid, sourceEnv, probe)
                : (signal): Promise<void> => sendPosix(pid, signal),
        isAlive: () => isTreeAlive(platform, pid),
        graceMs: input.graceMs ?? DEFAULT_KILL_GRACE_MS,
        pollMs: input.pollMs ?? DEFAULT_KILL_POLL_MS,
        sleep
    }
    return runKillEscalation(escalation)
}
