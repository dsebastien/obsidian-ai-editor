import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CreateRunDir, RunDirHandle } from './node-fs'

/**
 * Fixtures for the conformance suite.
 *
 * The suite spawns a REAL process — `process.execPath` running an inline
 * script — rather than mocking a spawn seam. A mock would prove the module
 * calls a function; only a real child proves the things that actually matter
 * here: that content survives the stdin pipe byte for byte, that the
 * environment really is empty, that the working directory really is the
 * throwaway one, and that a sleeping grandchild really does die when the run
 * is cancelled. The runtime is Bun in tests and Electron's Node in Obsidian;
 * both accept `-e`, so the same fixture exercises the same code path.
 */

/** A child that evaluates `source`. Always argv[1..], never a shell string. */
export function inlineScript(source: string): { command: string; args: readonly string[] } {
    return { command: process.execPath, args: ['-e', source] }
}

/** Reads all of stdin, then answers. `answer` is JS evaluated with `input`. */
export const READ_STDIN_AND_ECHO = `
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { input += c; });
process.stdin.on('end', () => {
    process.stdout.write(JSON.stringify({ received: input }));
});
`

/** Reports the sandbox it was given, so the specs can assert on it. */
export const REPORT_SANDBOX = `
process.stdout.write(JSON.stringify({ cwd: process.cwd(), env: process.env, argv: process.argv.slice(1) }));
`

/** Never exits on its own; the run must end it. */
export const SLEEP_FOREVER = `setTimeout(() => {}, 600000);`

/**
 * Spawns a grandchild that also sleeps, then sleeps itself. Prints both pids
 * so a spec can check the WHOLE tree died, not just the process we hold.
 */
export const SLEEP_FOREVER_WITH_GRANDCHILD = `
const { spawn } = require('node:child_process');
const grandchild = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 600000);'], { stdio: 'ignore' });
process.stdout.write(JSON.stringify({ parent: process.pid, grandchild: grandchild.pid }) + '\\n');
setNodeTimer(() => {}, 600000);
`

/**
 * Spawns a sleeping grandchild that INHERITS the stdio pipes, then exits 0.
 *
 * The shape of an agent that leaves a background helper behind — an MCP
 * server, a watcher, a language server. The parent's exit status says the tool
 * succeeded; the descendant is still there holding the note text, and because
 * it holds the pipes the `close` event never arrives either.
 */
export const CLEAN_EXIT_WITH_INHERITING_GRANDCHILD = `
const { spawn } = require('node:child_process');
const grandchild = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 600000);'], { stdio: 'inherit' });
process.stdout.write(JSON.stringify({ parent: process.pid, grandchild: grandchild.pid }) + '\\n');
process.exit(0);
`

/**
 * Writes a marker file at `argv[1]` before doing anything else, then sleeps.
 *
 * Lets a spec assert that a program was never EXECUTED, rather than only that
 * the outcome said `cancelled` — the outcome cannot tell "refused before the
 * OS was asked" apart from "started and then killed fast enough".
 */
export const MARK_AND_SLEEP = `
require('node:fs').writeFileSync(process.argv[1], 'ran');
setNodeTimer(() => {}, 600000);
`

/** Whether a pid is still running (signal 0 delivers nothing). */
export function isProcessAlive(pid: number): boolean {
    try {
        process.kill(pid, 0)
        return true
    } catch (error) {
        return (error as { code?: string }).code === 'EPERM'
    }
}

/** Polls until `predicate` holds or the budget runs out. */
export async function waitUntil(
    predicate: () => boolean,
    budgetMs = 3_000,
    stepMs = 20
): Promise<boolean> {
    let waited = 0
    while (waited < budgetMs) {
        if (predicate()) {
            return true
        }
        await Bun.sleep(stepMs)
        waited += stepMs
    }
    return predicate()
}

/**
 * A run directory whose path the spec can inspect after the run — the real
 * one is removed on the way out, which is exactly the behaviour under test.
 */
export function trackedRunDir(): { create: CreateRunDir; paths: string[] } {
    const paths: string[] = []
    const create: CreateRunDir = () => {
        const path = mkdtempSync(join(tmpdir(), 'editor-ai-daemons-spec-'))
        paths.push(path)
        const handle: RunDirHandle = {
            path,
            dispose: async (): Promise<void> => {
                rmSync(path, { recursive: true, force: true })
            }
        }
        return Promise.resolve(handle)
    }
    return { create, paths }
}
