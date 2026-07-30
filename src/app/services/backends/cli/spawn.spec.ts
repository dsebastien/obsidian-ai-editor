import { existsSync } from 'node:fs'
import { describe, expect, it } from 'bun:test'
import { spawnCliProcess, validateCliArguments, MAX_ARGUMENT_LENGTH } from './spawn'
import {
    READ_STDIN_AND_ECHO,
    REPORT_SANDBOX,
    SLEEP_FOREVER,
    SLEEP_FOREVER_WITH_GRANDCHILD,
    inlineScript,
    isProcessAlive,
    trackedRunDir,
    waitUntil
} from './spec-fixtures'

/**
 * Conformance suite for the CLI security boundary.
 *
 * These specs run REAL processes. That is the point: the guarantees being
 * pinned (an empty environment, a throwaway working directory, content that
 * only travels over stdin, a tree that actually dies) are properties of the
 * operating system's view of the child, and a mocked spawn would assert none
 * of them. The child is `process.execPath` evaluating an inline script, so
 * there is no fixture binary to build and the same suite runs on any machine
 * that can run the test suite at all.
 */

const TIMEOUT_MS = 15_000

function run(
    source: string,
    overrides: Partial<Parameters<typeof spawnCliProcess>[0]> = {}
): ReturnType<typeof spawnCliProcess> {
    const { command, args } = inlineScript(source)
    return spawnCliProcess({
        executablePath: command,
        args,
        stdin: '',
        timeoutMs: TIMEOUT_MS,
        // The specs assert on an environment built from THIS, not from the
        // ambient one, so a developer's shell cannot make them pass.
        sourceEnv: { HOME: '/home/spec', PATH: '/usr/bin:/bin', SECRET_TOKEN: 'do-not-forward' },
        ...overrides
    })
}

interface SandboxReport {
    readonly cwd: string
    readonly env: Record<string, string>
    readonly argv: readonly string[]
}

// ---------------------------------------------------------------------------
// Argument validation (pure)
// ---------------------------------------------------------------------------

describe('validateCliArguments', () => {
    it('accepts ordinary flags', () => {
        expect(validateCliArguments(['-p', '--output-format', 'stream-json']).ok).toBe(true)
    })

    it('refuses a NUL byte', () => {
        const result = validateCliArguments(['--model', 'a\0b'])
        expect(result.ok).toBe(false)
    })

    it('refuses an argument long enough to be note content', () => {
        const result = validateCliArguments(['x'.repeat(MAX_ARGUMENT_LENGTH + 1)])
        expect(result.ok).toBe(false)
        expect(result.ok ? '' : result.message).toContain('standard input')
    })
})

// ---------------------------------------------------------------------------
// Happy path + the sandbox the child actually sees
// ---------------------------------------------------------------------------

describe('spawnCliProcess — happy path', () => {
    it('returns the tool stdout and a clean outcome', async () => {
        const outcome = await run('process.stdout.write(JSON.stringify({ findings: [] }))')
        expect(outcome.ok).toBe(true)
        expect(outcome.stdout).toBe('{"findings":[]}')
        expect(outcome.stderr.bytesSeen).toBe(0)
        expect(outcome.durationMs).toBeGreaterThanOrEqual(0)
    })

    it('runs in a throwaway directory that is removed afterwards, never the vault', async () => {
        const tracked = trackedRunDir()
        const outcome = await run(REPORT_SANDBOX, { createRunDir: tracked.create })
        expect(outcome.ok).toBe(true)

        const report = JSON.parse(outcome.stdout) as SandboxReport
        expect(tracked.paths).toHaveLength(1)
        // Node resolves symlinked temp roots (/tmp -> /private/tmp on macOS),
        // so compare on the unique directory name rather than the full path.
        const created = tracked.paths[0] ?? ''
        expect(report.cwd.endsWith(created.slice(created.lastIndexOf('ai-editor-spec-')))).toBe(
            true
        )
        expect(existsSync(created)).toBe(false)
    })

    it('gives the child an environment built from empty', async () => {
        const outcome = await run(REPORT_SANDBOX)
        const report = JSON.parse(outcome.stdout) as SandboxReport

        expect(report.env['SECRET_TOKEN']).toBeUndefined()
        expect(report.env['HOME']).toBe('/home/spec')
        expect(report.env['PATH']).toBe('/usr/bin:/bin')
        expect(report.env['NO_COLOR']).toBe('1')
        expect(Object.keys(report.env).sort()).toEqual([
            'HOME',
            'NO_COLOR',
            'PATH',
            'TERM',
            'TMPDIR'
        ])
    })

    it('points the child temp directory into the run directory', async () => {
        const tracked = trackedRunDir()
        const outcome = await run(REPORT_SANDBOX, { createRunDir: tracked.create })
        const report = JSON.parse(outcome.stdout) as SandboxReport
        expect(report.env['TMPDIR']).toBe(tracked.paths[0] ?? '')
    })

    it('passes arguments as separate argv entries, with no shell in between', async () => {
        const { command } = inlineScript('')
        const outcome = await spawnCliProcess({
            executablePath: command,
            args: ['-e', REPORT_SANDBOX, 'a b', '$(touch /tmp/pwned)', '; rm -rf /', '*'],
            stdin: '',
            timeoutMs: TIMEOUT_MS,
            sourceEnv: { HOME: '/home/spec', PATH: '/usr/bin:/bin' }
        })
        const report = JSON.parse(outcome.stdout) as SandboxReport
        // Verbatim: no word splitting, no substitution, no glob expansion.
        expect(report.argv).toEqual(['a b', '$(touch /tmp/pwned)', '; rm -rf /', '*'])
        expect(existsSync('/tmp/pwned')).toBe(false)
    })
})

// ---------------------------------------------------------------------------
// stdin delivery
// ---------------------------------------------------------------------------

describe('spawnCliProcess — stdin', () => {
    it('delivers content with newlines, quotes, and unicode byte for byte', async () => {
        const content = [
            '# A note',
            '',
            'Line with "double" and \'single\' quotes, a $VAR, a `backtick`, and a \\backslash.',
            'Unicode: é 🙂 中文 — em dash, \ttab.',
            'Trailing pipe | ampersand & semicolon ; newline follows.',
            ''
        ].join('\n')
        const outcome = await run(READ_STDIN_AND_ECHO, { stdin: content })
        expect(outcome.ok).toBe(true)
        expect((JSON.parse(outcome.stdout) as { received: string }).received).toBe(content)
    })

    it('delivers an empty document without hanging', async () => {
        const outcome = await run(READ_STDIN_AND_ECHO, { stdin: '' })
        expect((JSON.parse(outcome.stdout) as { received: string }).received).toBe('')
    })

    it('delivers content larger than a pipe buffer', async () => {
        const content = 'x'.repeat(512 * 1024)
        const outcome = await run(READ_STDIN_AND_ECHO, { stdin: content })
        expect((JSON.parse(outcome.stdout) as { received: string }).received.length).toBe(
            content.length
        )
    })

    it('survives a tool that exits without reading its input', async () => {
        const outcome = await run('process.stdout.write("done"); process.exit(0);', {
            stdin: 'y'.repeat(4 * 1024 * 1024)
        })
        // The write end breaks (EPIPE); that is the tool's business, and the
        // boundary still reports what the tool said.
        expect(outcome.stdout).toBe('done')
    })
})

// ---------------------------------------------------------------------------
// Protocol failures the boundary must report rather than paper over
// ---------------------------------------------------------------------------

describe('spawnCliProcess — output', () => {
    it('returns malformed output as-is and leaves parsing to the protocol layer', async () => {
        const outcome = await run('process.stdout.write("{not json")')
        expect(outcome.ok).toBe(true)
        expect(outcome.stdout).toBe('{not json')
    })

    it('returns success with empty stdout when the tool says nothing', async () => {
        const outcome = await run('void 0;')
        expect(outcome.ok).toBe(true)
        expect(outcome.stdout).toBe('')
    })

    it('fails when stdout exceeds the cap instead of parsing a fragment', async () => {
        const outcome = await run(
            'const line = "z".repeat(1024) + "\\n"; setInterval(() => process.stdout.write(line), 1);',
            { maxStdoutBytes: 16 * 1024 }
        )
        expect(outcome.ok).toBe(false)
        expect(outcome.ok ? '' : outcome.code).toBe('stdout-overflow')
        expect(outcome.stdout.length).toBeLessThanOrEqual(16 * 1024)
        expect(outcome.ok ? null : outcome.kill).not.toBe('survived')
    })

    it('keeps the tail of a runaway stderr without failing the run', async () => {
        const outcome = await run(
            'for (let i = 0; i < 2000; i += 1) { process.stderr.write("noise-" + i + "\\n"); } process.stdout.write("ok");',
            { maxStderrBytes: 1_024 }
        )
        expect(outcome.ok).toBe(true)
        expect(outcome.stdout).toBe('ok')
        expect(outcome.stderr.truncated).toBe(true)
        expect(outcome.stderr.reveal().length).toBeLessThanOrEqual(1_024)
        expect(outcome.stderr.reveal()).toContain('noise-1999')
    })

    it('never puts stderr content in the message the user sees', async () => {
        const outcome = await run(
            'process.stderr.write("Authorization: Bearer sk-super-secret"); process.exit(3);'
        )
        expect(outcome.ok).toBe(false)
        expect(outcome.ok ? '' : outcome.code).toBe('nonzero-exit')
        expect(outcome.ok ? '' : outcome.message).not.toContain('sk-super-secret')
        expect(outcome.stderr.summary).not.toContain('sk-super-secret')
        expect(outcome.stderr.reveal()).toContain('sk-super-secret')
    })
})

// ---------------------------------------------------------------------------
// Failure to start
// ---------------------------------------------------------------------------

describe('spawnCliProcess — refusals before anything starts', () => {
    it('refuses a bare command name', async () => {
        const outcome = await spawnCliProcess({
            executablePath: 'claude',
            args: [],
            stdin: '',
            timeoutMs: TIMEOUT_MS
        })
        expect(outcome.ok ? '' : outcome.code).toBe('invalid-executable')
    })

    it('refuses a path that does not exist', async () => {
        const outcome = await spawnCliProcess({
            executablePath: '/nonexistent/definitely/not/here',
            args: [],
            stdin: '',
            timeoutMs: TIMEOUT_MS,
            platform: 'posix'
        })
        expect(outcome.ok ? '' : outcome.code).toBe('invalid-executable')
    })

    it('refuses an environment variable that would inject code', async () => {
        const { command, args } = inlineScript('')
        const outcome = await spawnCliProcess({
            executablePath: command,
            args,
            stdin: '',
            timeoutMs: TIMEOUT_MS,
            passThroughEnvNames: ['LD_PRELOAD']
        })
        expect(outcome.ok ? '' : outcome.code).toBe('invalid-environment')
    })

    it('refuses an argument that looks like smuggled content', async () => {
        const { command } = inlineScript('')
        const outcome = await spawnCliProcess({
            executablePath: command,
            args: ['-e', 'x'.repeat(MAX_ARGUMENT_LENGTH + 1)],
            stdin: '',
            timeoutMs: TIMEOUT_MS
        })
        expect(outcome.ok ? '' : outcome.code).toBe('invalid-argument')
    })

    it('reports a non-zero exit with the status', async () => {
        const outcome = await run('process.exit(7)')
        expect(outcome.ok).toBe(false)
        expect(outcome.ok ? '' : outcome.code).toBe('nonzero-exit')
        expect(outcome.ok ? null : outcome.exitCode).toBe(7)
        expect(outcome.ok ? '' : outcome.message).toContain('7')
    })
})

// ---------------------------------------------------------------------------
// Bounding the run: timeout, cancellation, and a tree that really dies
// ---------------------------------------------------------------------------

describe('spawnCliProcess — bounds', () => {
    it('ends a slow tool at the timeout and kills it', async () => {
        const outcome = await run(SLEEP_FOREVER, { timeoutMs: 400, killGraceMs: 1_000 })
        expect(outcome.ok).toBe(false)
        expect(outcome.ok ? '' : outcome.code).toBe('timeout')
        expect(outcome.ok ? null : outcome.kill).not.toBe('survived')
    })

    it('keeps what a slow tool already said before the timeout', async () => {
        const outcome = await run(
            'process.stdout.write("partial"); setTimeout(() => {}, 600000);',
            { timeoutMs: 500, killGraceMs: 1_000 }
        )
        expect(outcome.ok ? '' : outcome.code).toBe('timeout')
        expect(outcome.stdout).toBe('partial')
    })

    it('does not time out a tool that finishes in time', async () => {
        const outcome = await run('setTimeout(() => process.stdout.write("late but fine"), 200);', {
            timeoutMs: 5_000
        })
        expect(outcome.ok).toBe(true)
        expect(outcome.stdout).toBe('late but fine')
    })

    it('cancels on the caller signal', async () => {
        const controller = new AbortController()
        const pending = run(SLEEP_FOREVER, { signal: controller.signal, killGraceMs: 1_000 })
        setTimeout(() => controller.abort(), 200)
        const outcome = await pending
        expect(outcome.ok ? '' : outcome.code).toBe('cancelled')
    })

    it('refuses immediately when the signal is already aborted', async () => {
        const controller = new AbortController()
        controller.abort()
        const outcome = await run(SLEEP_FOREVER, {
            signal: controller.signal,
            killGraceMs: 1_000
        })
        expect(outcome.ok ? '' : outcome.code).toBe('cancelled')
    })

    it('kills the WHOLE tree on cancel — a sleeping grandchild dies too', async () => {
        const controller = new AbortController()
        const tracked = trackedRunDir()
        const pending = run(SLEEP_FOREVER_WITH_GRANDCHILD, {
            signal: controller.signal,
            killGraceMs: 2_000,
            createRunDir: tracked.create
        })
        // Give the child time to report its pids, then cancel.
        setTimeout(() => controller.abort(), 700)
        const outcome = await pending

        expect(outcome.ok ? '' : outcome.code).toBe('cancelled')
        const pids = JSON.parse(outcome.stdout.trim()) as { parent: number; grandchild: number }
        expect(pids.grandchild).toBeGreaterThan(0)

        // Verified, not assumed: both processes are actually gone.
        expect(await waitUntil(() => !isProcessAlive(pids.parent))).toBe(true)
        expect(await waitUntil(() => !isProcessAlive(pids.grandchild))).toBe(true)
        expect(outcome.ok ? null : outcome.kill).not.toBe('survived')
    })

    it('kills a tool that ignores the graceful signal', async () => {
        const outcome = await run(
            'process.on("SIGTERM", () => {}); process.stdout.write("armed\\n"); setTimeout(() => {}, 600000);',
            { timeoutMs: 500, killGraceMs: 300 }
        )
        expect(outcome.ok ? '' : outcome.code).toBe('timeout')
        expect(outcome.ok ? null : outcome.kill).toBe('force-terminated')
    })

    it('reports a signal death nobody here asked for', async () => {
        const outcome = await run('process.kill(process.pid, "SIGKILL");')
        expect(outcome.ok).toBe(false)
        expect(outcome.ok ? '' : outcome.code).toBe('killed')
        expect(outcome.ok ? '' : outcome.termSignal).toBe('SIGKILL')
    })

    it('removes the run directory even when the run is cancelled', async () => {
        const tracked = trackedRunDir()
        const controller = new AbortController()
        const pending = run(SLEEP_FOREVER, {
            signal: controller.signal,
            killGraceMs: 1_000,
            createRunDir: tracked.create
        })
        setTimeout(() => controller.abort(), 200)
        await pending
        expect(existsSync(tracked.paths[0] ?? '')).toBe(false)
    })
})
