import type { StderrDiagnostics } from './capture'
import {
    BoundedCapture,
    DEFAULT_MAX_STDERR_BYTES,
    DEFAULT_MAX_STDOUT_BYTES,
    toStderrDiagnostics
} from './capture'
import { validateExecutablePath } from './executable'
import type { ExecutableProbe } from './executable'
import { buildCliEnv } from './env'
import { DEFAULT_KILL_GRACE_MS } from './kill'
import type { KillResult } from './kill'
import type { CreateRunDir } from './node-fs'
import { createTempRunDir, nodeExecutableProbe } from './node-fs'
import { createCliChild, killProcessTree } from './node-process'
import type { CliPlatform } from './platform'
import { currentCliPlatform } from './platform'

/**
 * The process seam: the ONE place in the plugin where a local program is
 * started.
 *
 * Spawning a process from a note-taking app is the highest-risk thing this
 * plugin does, so the shape of this function is the security design
 * (Business Rules #9). Every guarantee below is structural — enforced by the
 * signature or by code inside this module — rather than a rule a caller is
 * asked to follow:
 *
 * - **No shell, ever.** The process is created through `createCliChild`, the
 *   only door into `node:child_process` in this plugin, whose options type
 *   has no shell field. Arguments cross as an ARRAY, so no command line is
 *   assembled, no quoting rule is consulted, and there is no metacharacter to
 *   escape or injection to get wrong.
 * - **Content goes over stdin, never in argv.** `stdin` is a separate field
 *   from `args`, and arguments are length-capped so a caller who tried to
 *   pass a note as a flag value fails loudly. argv is world-readable in `ps`
 *   on a shared machine; a note is not.
 * - **The executable is the user's configured absolute path**, re-validated
 *   here so there is no path into the OS that skips the check.
 * - **The working directory is a fresh throwaway**, created and removed by
 *   this function. A caller cannot point it at the vault because a caller
 *   cannot set it at all: an agent that writes files must not land them in
 *   the user's notes.
 * - **The environment is built from empty**, so no unrelated secret in the
 *   renderer's environment travels with the request.
 * - **The whole operation is bounded** by `timeoutMs`, by the caller's
 *   `AbortSignal`, and by the output caps — and EVERY exit, a clean one
 *   included, goes through the same process-tree kill, verified rather than
 *   assumed. A tool that exits 0 having left a background descendant behind is
 *   the ordinary case for an agent, not an exotic one.
 * - **An already-cancelled run never becomes a process.** The abort check runs
 *   before anything is allocated and again immediately before the child is
 *   created, so the guarantee belongs to the boundary rather than to whichever
 *   caller remembered to pre-check.
 *
 * The one thing this module does NOT do is interpret the output. It returns
 * stdout as text; `protocol.ts` decides what a document or an event stream
 * means, and the per-tool adapters decide which of those a given tool speaks.
 */

export type CliProcessFailureCode =
    /** The configured executable path did not pass the gate. */
    | 'invalid-executable'
    /** An argument was unusable (NUL byte, or long enough to look like content). */
    | 'invalid-argument'
    /** The throwaway working directory could not be created. */
    | 'run-dir-failed'
    /** The OS refused to create the process. */
    | 'spawn-failed'
    /** `timeoutMs` elapsed. */
    | 'timeout'
    /** The caller's signal aborted. */
    | 'cancelled'
    /** The tool wrote more to stdout than the cap allows. */
    | 'stdout-overflow'
    /** The tool exited with a non-zero status. */
    | 'nonzero-exit'
    /** The tool was killed by a signal nobody here sent. */
    | 'killed'

interface CliProcessOutcomeBase {
    /** Diagnostics only — status-only by construction (see `capture.ts`). */
    readonly stderr: StderrDiagnostics
    readonly durationMs: number
    /**
     * How ending the process TREE went — on every path, including a run that
     * succeeded. It lives on the shared base rather than on the failure branch
     * because a tool can exit 0 and still leave descendants behind, and that
     * case has to be reportable too.
     *
     * `already-gone` is the normal result of a tool that cleaned up after
     * itself. `survived` means processes were left running: the one outcome
     * the boundary could not make safe, which the caller must surface whatever
     * else the run reported. `null` means no process was ever created.
     */
    readonly kill: KillResult | null
}

export type CliProcessOutcome =
    | (CliProcessOutcomeBase & {
          readonly ok: true
          /** Raw stdout. Untrusted text until `protocol.ts` has parsed it. */
          readonly stdout: string
      })
    | (CliProcessOutcomeBase & {
          readonly ok: false
          readonly code: CliProcessFailureCode
          /** Safe to show the user: status only, never output content. */
          readonly message: string
          /** Whatever stdout was captured before the failure. */
          readonly stdout: string
          readonly exitCode: number | null
          readonly termSignal: string | null
      })

/**
 * An argument this long is not a flag, it is content that belongs on stdin.
 * The cap is a structural nudge: the boundary cannot detect a note in argv,
 * but it can make the mistake fail immediately instead of silently publishing
 * the note to every process listing on the machine.
 */
export const MAX_ARGUMENT_LENGTH = 4_096

/**
 * How long to keep reading stdio after the child itself exited. A grandchild
 * that inherited the pipes can hold them open forever, so `close` alone is not
 * a completion signal we can wait on; this bounds the wait, and the leftover
 * tree is killed on the way out — see the unconditional probe in `runChild`,
 * which is what makes that sentence true rather than aspirational.
 */
const STDIO_DRAIN_MS = 1_000

export interface SpawnCliProcessInput {
    /** The user's configured absolute path. Re-validated here. */
    readonly executablePath: string
    /** Flags only. Never note content — that is what `stdin` is for. */
    readonly args: readonly string[]
    /** Delivered on the child's standard input and nowhere else. */
    readonly stdin: string
    /** Bounds the whole operation: spawn, run, and output. */
    readonly timeoutMs: number
    /** Cancellation from the run controller. */
    readonly signal?: AbortSignal
    readonly maxStdoutBytes?: number
    readonly maxStderrBytes?: number
    /** How long a tool gets to exit gracefully before it is forced. */
    readonly killGraceMs?: number
    /** Seams. Defaults are the real platform, filesystem and temp directory. */
    readonly platform?: CliPlatform
    readonly sourceEnv?: Readonly<Record<string, string | undefined>>
    readonly createRunDir?: CreateRunDir
    readonly executableProbe?: ExecutableProbe
}

function failure(
    code: CliProcessFailureCode,
    message: string,
    stderr: StderrDiagnostics,
    durationMs: number,
    extra?: Partial<{
        stdout: string
        exitCode: number | null
        termSignal: string | null
        kill: KillResult | null
    }>
): CliProcessOutcome {
    return {
        ok: false,
        code,
        message,
        stdout: extra?.stdout ?? '',
        exitCode: extra?.exitCode ?? null,
        termSignal: extra?.termSignal ?? null,
        kill: extra?.kill ?? null,
        stderr,
        durationMs
    }
}

const EMPTY_STDERR = toStderrDiagnostics(new BoundedCapture(0, 'keep-tail'))

/** Pure argument check, so the refusal is spec-covered without a process. */
export function validateCliArguments(
    args: readonly string[]
): { readonly ok: true } | { readonly ok: false; readonly message: string } {
    for (const arg of args) {
        if (arg.includes('\0')) {
            return {
                ok: false,
                message: 'A command-line argument contains an invalid character.'
            }
        }
        if (arg.length > MAX_ARGUMENT_LENGTH) {
            return {
                ok: false,
                message:
                    `A command-line argument is longer than ${MAX_ARGUMENT_LENGTH} characters. ` +
                    'Note content is sent on standard input, never as an argument.'
            }
        }
    }
    return { ok: true }
}

/**
 * Runs one CLI tool to completion and returns everything it produced.
 *
 * Never throws: every failure — including a programming error inside the
 * boundary — comes back as a typed outcome, because the caller is a review
 * run that has to end in exactly one terminal state.
 */
export async function spawnCliProcess(input: SpawnCliProcessInput): Promise<CliProcessOutcome> {
    const startedAt = Date.now()
    const elapsed = (): number => Date.now() - startedAt
    const platform = input.platform ?? currentCliPlatform()

    // Cancelled before we were called: the OS is never asked to create a
    // process for a run that is already over. The check lives HERE, above
    // every allocation, rather than in the caller that happens to do it today
    // — "an aborted signal never starts a program" has to be a property of the
    // boundary, not a habit of one executor.
    if (input.signal?.aborted === true) {
        return failure('cancelled', 'The run was cancelled.', EMPTY_STDERR, elapsed())
    }

    const argCheck = validateCliArguments(input.args)
    if (!argCheck.ok) {
        return failure('invalid-argument', argCheck.message, EMPTY_STDERR, elapsed())
    }

    const executable = validateExecutablePath({
        platform,
        path: input.executablePath,
        probe: input.executableProbe ?? nodeExecutableProbe
    })
    if (!executable.ok) {
        return failure('invalid-executable', executable.message, EMPTY_STDERR, elapsed())
    }

    let runDir
    try {
        runDir = await (input.createRunDir ?? createTempRunDir)()
    } catch {
        return failure(
            'run-dir-failed',
            'A temporary working directory for the tool could not be created.',
            EMPTY_STDERR,
            elapsed()
        )
    }

    try {
        return await runChild({
            input,
            platform,
            executablePath: executable.path,
            env: buildCliEnv({
                platform,
                sourceEnv: input.sourceEnv ?? process.env,
                runDir: runDir.path
            }),
            cwd: runDir.path,
            startedAt
        })
    } finally {
        // The directory dies with the run whether or not the tool behaved.
        // A failure to clean up must not replace the outcome the caller needs.
        await runDir.dispose().catch(() => undefined)
    }
}

/** Why a run stopped. `exit` means the child ended on its own terms. */
type EndReason = 'exit' | 'timeout' | 'cancelled' | 'stdout-overflow' | 'spawn-failed'

interface RunChildInput {
    readonly input: SpawnCliProcessInput
    readonly platform: CliPlatform
    readonly executablePath: string
    readonly env: Record<string, string>
    readonly cwd: string
    readonly startedAt: number
}

/**
 * The process lifecycle itself.
 *
 * Listener attachment order is load-bearing: a short-lived child can exit
 * before the next microtask, so `error`/`exit`/`close` are subscribed
 * synchronously with the spawn call. Anything registered after an `await`
 * would miss the event and hang until the timeout.
 */
async function runChild(context: RunChildInput): Promise<CliProcessOutcome> {
    const { input, platform, cwd, env, executablePath, startedAt } = context
    const elapsed = (): number => Date.now() - startedAt

    const stdout = new BoundedCapture(input.maxStdoutBytes ?? DEFAULT_MAX_STDOUT_BYTES, 'stop')
    const stderr = new BoundedCapture(input.maxStderrBytes ?? DEFAULT_MAX_STDERR_BYTES, 'keep-tail')

    // Second reading of the same rule, because creating the run directory is
    // an await: a cancel that lands in that window must still not reach the
    // OS. The last statement before `createCliChild` is the only place that
    // can promise it.
    if (input.signal?.aborted === true) {
        return failure(
            'cancelled',
            'The run was cancelled.',
            toStderrDiagnostics(stderr),
            elapsed()
        )
    }

    let child
    try {
        child = createCliChild(executablePath, input.args, {
            cwd,
            env,
            // POSIX: the child leads its own process group, so cancellation
            // reaches every descendant and liveness can be probed for the
            // whole tree at once.
            detached: platform !== 'win32'
        })
    } catch {
        return failure(
            'spawn-failed',
            'The tool could not be started.',
            toStderrDiagnostics(stderr),
            elapsed()
        )
    }

    /**
     * How the run ended: why, and what the OS reported. Held on an object
     * rather than in locals on purpose — every write happens inside a listener
     * the compiler's flow analysis cannot see, and plain locals would stay
     * narrowed to their initializers, typing every real branch below as
     * unreachable. Property reads are re-widened after any call.
     */
    const ending: {
        reason: EndReason
        exitCode: number | null
        termSignal: string | null
        kill: KillResult | null
    } = { reason: 'exit', exitCode: null, termSignal: null, kill: null }
    let settled = false

    let resolveDone: () => void = () => {}
    const done = new Promise<void>((resolve) => {
        resolveDone = resolve
    })
    const settle = (): void => {
        if (settled) {
            return
        }
        settled = true
        resolveDone()
    }

    // --- subscribed synchronously with the spawn -----------------------------
    child.on('error', () => {
        // ENOENT/EACCES surface here rather than as a throw.
        ending.reason = 'spawn-failed'
        settle()
    })
    child.on('exit', (code, signal) => {
        ending.exitCode = code
        ending.termSignal = signal
        // `close` is preferred (it means the pipes drained too) but a
        // grandchild can hold them open indefinitely, so `exit` starts a
        // bounded drain and settles regardless.
        setTimeout(settle, STDIO_DRAIN_MS)
    })
    child.on('close', (code, signal) => {
        ending.exitCode = ending.exitCode ?? code
        ending.termSignal = ending.termSignal ?? signal
        settle()
    })
    child.stdout?.on('data', (chunk: Uint8Array) => {
        if (!stdout.push(chunk)) {
            ending.reason = 'stdout-overflow'
            settle()
        }
    })
    child.stderr?.on('data', (chunk: Uint8Array) => {
        stderr.push(chunk)
    })
    // A tool that exits without draining its input makes the pipe error; that
    // is the tool's business, not a plugin crash.
    child.stdin?.on('error', () => undefined)

    const timer = setTimeout(() => {
        ending.reason = 'timeout'
        settle()
    }, input.timeoutMs)

    const onAbort = (): void => {
        ending.reason = 'cancelled'
        settle()
    }
    input.signal?.addEventListener('abort', onAbort, { once: true })

    // Content goes here and only here.
    try {
        child.stdin?.end(input.stdin, 'utf8')
    } catch {
        // Same EPIPE story as above.
    }

    try {
        await done
    } finally {
        clearTimeout(timer)
        input.signal?.removeEventListener('abort', onAbort)
    }

    // EVERY path ends with the tree probed and, if anything is still there,
    // gone — including a clean `exit 0`.
    //
    // The state of the process we hold a handle to says nothing about its
    // descendants. A tool that starts an MCP server, a watcher or a language
    // server and then exits successfully leaves those running: still holding
    // the note text that went in on stdin, still able to make network calls,
    // and about to have their temp directory deleted underneath them by the
    // `finally` in `spawnCliProcess`. Deciding on `child.exitCode` (the
    // previous rule here) meant that exact case was never killed and never
    // reported.
    //
    // The probe is cheap on the common path: `runKillEscalation` opens with a
    // liveness check, so a tool that genuinely finished costs one
    // `kill(-pid, 0)` and comes back `already-gone`.
    const pid = child.pid
    ending.kill =
        typeof pid === 'number'
            ? await killProcessTree({
                  platform,
                  pid,
                  graceMs: input.killGraceMs ?? DEFAULT_KILL_GRACE_MS,
                  ...(input.sourceEnv ? { sourceEnv: input.sourceEnv } : {})
              })
            : null

    const diagnostics = toStderrDiagnostics(stderr)
    const common = {
        stdout: stdout.text(),
        exitCode: ending.exitCode,
        termSignal: ending.termSignal,
        kill: ending.kill
    }

    switch (ending.reason) {
        case 'spawn-failed':
            return failure(
                'spawn-failed',
                'The tool could not be started.',
                diagnostics,
                elapsed(),
                common
            )
        case 'timeout':
            return failure(
                'timeout',
                `The tool did not finish within ${Math.round(input.timeoutMs / 1_000)} s.`,
                diagnostics,
                elapsed(),
                common
            )
        case 'cancelled':
            return failure('cancelled', 'The run was cancelled.', diagnostics, elapsed(), common)
        case 'stdout-overflow':
            return failure(
                'stdout-overflow',
                'The tool produced more output than the plugin accepts.',
                diagnostics,
                elapsed(),
                common
            )
        case 'exit':
            break
    }

    if (ending.termSignal !== null) {
        return failure(
            'killed',
            `The tool was stopped by the system (${ending.termSignal}).`,
            diagnostics,
            elapsed(),
            common
        )
    }
    if (ending.exitCode !== 0) {
        return failure(
            'nonzero-exit',
            `The tool exited with status ${String(ending.exitCode)}.`,
            diagnostics,
            elapsed(),
            common
        )
    }
    return {
        ok: true,
        stdout: stdout.text(),
        stderr: diagnostics,
        durationMs: elapsed(),
        kill: ending.kill
    }
}
