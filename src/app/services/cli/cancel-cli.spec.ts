import { describe, expect, it } from 'bun:test'
import type { RunHandle } from '../orchestration/run-controller'
import {
    CANCEL_CLI_COMMAND,
    CANCEL_CLI_DESCRIPTION,
    CANCEL_CLI_FLAGS,
    handleCancelCli
} from './cancel-cli'
import type { CancelCliDeps, CancelCliOutput } from './cancel-cli'
import { FakeRunHandle, makeState } from './spec-fixtures'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeDeps(overrides: Partial<CancelCliDeps> = {}): CancelCliDeps {
    return {
        resolveFile: (file) => (file === 'Notes/Test.md' ? 'Notes/Test.md' : null),
        getRun: () => null,
        ...overrides
    }
}

function parseOutput(rendered: string): CancelCliOutput {
    return JSON.parse(rendered) as CancelCliOutput
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

describe('handleCancelCli', () => {
    it('returns bad-args when the file flag is missing', () => {
        const output = parseOutput(handleCancelCli({}, makeDeps()))
        expect(output).toEqual({
            ok: false,
            file: '',
            cancelled: false,
            error: { code: 'bad-args', message: 'Missing required flag: file' }
        })
    })

    it('returns file-not-found when the file does not resolve', () => {
        const output = parseOutput(handleCancelCli({ file: 'Nope.md' }, makeDeps()))
        expect(output).toEqual({
            ok: false,
            file: 'Nope.md',
            cancelled: false,
            error: { code: 'file-not-found', message: 'File not found: Nope.md' }
        })
    })

    it('reports no-run when the note has no tracked run', () => {
        const output = parseOutput(handleCancelCli({ file: 'Notes/Test.md' }, makeDeps()))
        expect(output).toEqual({
            ok: true,
            file: 'Notes/Test.md',
            cancelled: false,
            reason: 'no-run'
        })
    })

    it('reports already-settled without cancelling a finished run', () => {
        const run = new FakeRunHandle([makeState()], [], { settled: true })
        const deps = makeDeps({ getRun: () => run })
        const output = parseOutput(handleCancelCli({ file: 'Notes/Test.md' }, deps))
        expect(output).toEqual({
            ok: true,
            file: 'Notes/Test.md',
            cancelled: false,
            reason: 'already-settled'
        })
        expect(run.cancelCount).toBe(0)
    })

    it('cancels an unsettled run exactly once', () => {
        const run = new FakeRunHandle([makeState({ status: 'running' })], [], { settled: false })
        const deps = makeDeps({ getRun: () => run })
        const output = parseOutput(handleCancelCli({ file: 'Notes/Test.md' }, deps))
        expect(output).toEqual({ ok: true, file: 'Notes/Test.md', cancelled: true })
        expect(run.cancelCount).toBe(1)
    })

    it('resolves the file before looking up the run', () => {
        // Cancel must key the run lookup by the RESOLVED vault path, not the
        // raw user input — the RunController is keyed by vault paths.
        const run = new FakeRunHandle([makeState({ status: 'running' })], [], { settled: false })
        const lookups: string[] = []
        const deps = makeDeps({
            resolveFile: () => 'Notes/Test.md',
            getRun: (path): RunHandle | null => {
                lookups.push(path)
                return run
            }
        })
        handleCancelCli({ file: 'Test' }, deps)
        expect(lookups).toEqual(['Notes/Test.md'])
    })

    it('never discards the run: findings stay listable after the cancel', () => {
        // The deps expose no discard capability at all — this spec pins the
        // observable half: the cancelled run's finding store is untouched.
        const run = new FakeRunHandle(
            [makeState({ status: 'running' })],
            [{ editorId: 'editor-1', quote: 'Hello', critique: 'Weak opener' }],
            { settled: false }
        )
        const deps = makeDeps({ getRun: () => run })
        handleCancelCli({ file: 'Notes/Test.md' }, deps)
        expect(run.findings.list()).toHaveLength(1)
    })

    it('declares the command metadata with file required', () => {
        expect(CANCEL_CLI_COMMAND).toBe('editor-ai-daemons:cancel')
        expect(CANCEL_CLI_DESCRIPTION.length).toBeGreaterThan(0)
        expect(Object.keys(CANCEL_CLI_FLAGS)).toEqual(['file'])
        expect(CANCEL_CLI_FLAGS['file']?.required).toBe(true)
    })
})
