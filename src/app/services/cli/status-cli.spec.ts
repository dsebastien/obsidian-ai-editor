import { describe, expect, it } from 'bun:test'
import { handleCancelCli } from './cancel-cli'
import { shapeRunOutput } from './review-cli'
import { FakeRunHandle, makeState } from './spec-fixtures'
import {
    STATUS_CLI_COMMAND,
    STATUS_CLI_DESCRIPTION,
    STATUS_CLI_FLAGS,
    formatStatusHeadline,
    formatStatusText,
    handleStatusCli,
    shapeStatusRun
} from './status-cli'
import type { StatusCliDeps, StatusCliOutput } from './status-cli'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeDeps(overrides: Partial<StatusCliDeps> = {}): StatusCliDeps {
    return {
        resolveFile: (file) => (file === 'Notes/Test.md' ? 'Notes/Test.md' : null),
        getRun: () => null,
        ...overrides
    }
}

function parseOutput(rendered: string): StatusCliOutput {
    return JSON.parse(rendered) as StatusCliOutput
}

// ---------------------------------------------------------------------------
// Run shaping
// ---------------------------------------------------------------------------

describe('shapeStatusRun', () => {
    it('reports settled state, editor states, findings, and summaries', () => {
        const run = new FakeRunHandle(
            [
                makeState({ summary: 'Solid draft' }),
                makeState({
                    editorId: 'editor-2',
                    editorName: 'Broken',
                    status: 'error',
                    error: { code: 'auth', message: 'HTTP 401 from backend' }
                })
            ],
            [
                {
                    editorId: 'editor-1',
                    quote: 'Hello',
                    critique: 'Too generic',
                    suggestion: 'Bonjour',
                    severity: 'warning'
                },
                { editorId: 'editor-1', quote: 'world', critique: 'Unanchored one', anchor: null }
            ]
        )
        const shaped = shapeStatusRun(run)
        expect(shaped.settled).toBe(true)
        expect(shaped.editors).toEqual([
            { id: 'editor-1', name: 'Hater', status: 'done', error: null },
            {
                id: 'editor-2',
                name: 'Broken',
                status: 'error',
                error: { code: 'auth', message: 'HTTP 401 from backend' }
            }
        ])
        expect(shaped.findings).toHaveLength(2)
        expect(shaped.findings[0]).toMatchObject({
            editor: 'Hater',
            severity: 'warning',
            quote: 'Hello',
            critique: 'Too generic',
            suggestion: 'Bonjour',
            anchor: { from: 0, to: 5, state: 'anchored' }
        })
        expect(shaped.findings[1]).toMatchObject({ suggestion: null, anchor: null })
        expect(shaped.summaryByEditor).toEqual({ Hater: 'Solid draft' })
    })

    it('reports an unsettled run with in-flight editor states', () => {
        const run = new FakeRunHandle(
            [
                makeState({ status: 'running' }),
                makeState({ editorId: 'editor-2', editorName: 'Second', status: 'pending' })
            ],
            [],
            { settled: false }
        )
        const shaped = shapeStatusRun(run)
        expect(shaped.settled).toBe(false)
        expect(shaped.editors.map((editor) => editor.status)).toEqual(['running', 'pending'])
    })

    it('reports settled from editor states during the cancel-to-settle window', () => {
        // cancelRun marks every editor terminal synchronously, but the run's
        // settle promise resolves only after the aborted loops unwind. A
        // status poll in that window must not claim the run is in progress.
        const run = new FakeRunHandle(
            [
                makeState({ status: 'cancelled' }),
                makeState({ editorId: 'editor-2', editorName: 'Second', status: 'cancelled' })
            ],
            [],
            { settled: false }
        )
        expect(shapeStatusRun(run).settled).toBe(true)
    })

    it('shapes findings byte-identically to the review output', () => {
        // Lockstep guarantee: an agent that parsed `editor-ai-daemons:review`
        // findings must be able to parse `editor-ai-daemons:status` findings with
        // the same code — both go through the shared shaping.
        const run = new FakeRunHandle(
            [makeState({ summary: 'Solid draft' })],
            [
                {
                    editorId: 'editor-1',
                    quote: 'Hello',
                    critique: 'Weak opener',
                    suggestion: 'Hi',
                    severity: 'info'
                },
                { editorId: 'editor-1', quote: 'world', critique: 'Unanchored', anchor: null }
            ]
        )
        const reviewOutput = shapeRunOutput('Notes/Test.md', run, [])
        const statusRun = shapeStatusRun(run)
        expect(statusRun.findings).toEqual(reviewOutput.findings)
        expect(statusRun.summaryByEditor).toEqual(reviewOutput.summaryByEditor)
    })
})

// ---------------------------------------------------------------------------
// Text formatting
// ---------------------------------------------------------------------------

describe('formatStatusHeadline', () => {
    it('summarizes a settled run with per-status counts and finding count', () => {
        const run = new FakeRunHandle(
            [
                makeState(),
                makeState({ editorId: 'editor-2', editorName: 'Second' }),
                makeState({
                    editorId: 'editor-3',
                    editorName: 'Broken',
                    status: 'error',
                    error: { code: 'timeout', message: 'Timed out' }
                })
            ],
            [{ editorId: 'editor-1', quote: 'Hello', critique: 'Weak opener' }]
        )
        expect(formatStatusHeadline(shapeStatusRun(run))).toBe(
            'Run settled (2 done, 1 error) — 1 finding'
        )
    })

    it('summarizes an in-flight run with a so-far finding count', () => {
        const run = new FakeRunHandle(
            [
                makeState({ status: 'running' }),
                makeState({ editorId: 'editor-2', editorName: 'Second' })
            ],
            [
                { editorId: 'editor-1', quote: 'Hello', critique: 'One' },
                { editorId: 'editor-2', quote: 'world', critique: 'Two' }
            ],
            { settled: false }
        )
        expect(formatStatusHeadline(shapeStatusRun(run))).toBe(
            'Run in progress (1 running, 1 done) — 2 findings so far'
        )
    })
})

describe('formatStatusText', () => {
    it('prints the headline plus one line per finding, matching the review line format', () => {
        const run = new FakeRunHandle(
            [makeState()],
            [
                {
                    editorId: 'editor-1',
                    quote: 'Hello\nworld',
                    critique: 'Multi\nline critique',
                    suggestion: 'Hi'
                }
            ]
        )
        const text = formatStatusText({
            ok: true,
            file: 'Notes/Test.md',
            run: shapeStatusRun(run),
            error: null
        })
        expect(text.split('\n')).toEqual([
            'Run settled (1 done) — 1 finding',
            '[suggestion] Hater 0-5: "Hello world" — Multi line critique -> Hi'
        ])
    })

    it('prints No run for the runless case and a single error line on failure', () => {
        expect(formatStatusText({ ok: true, file: 'Notes/Test.md', run: null, error: null })).toBe(
            'No run for Notes/Test.md.'
        )
        expect(
            formatStatusText({
                ok: false,
                file: 'Nope.md',
                run: null,
                error: { code: 'file-not-found', message: 'File not found: Nope.md' }
            })
        ).toBe('Error (file-not-found): File not found: Nope.md')
    })
})

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

describe('handleStatusCli', () => {
    it('returns bad-args when the file flag is missing', () => {
        const output = parseOutput(handleStatusCli({}, makeDeps()))
        expect(output).toEqual({
            ok: false,
            file: '',
            run: null,
            error: { code: 'bad-args', message: 'Missing required flag: file' }
        })
    })

    it('returns file-not-found when the file does not resolve', () => {
        const output = parseOutput(handleStatusCli({ file: 'Nope.md' }, makeDeps()))
        expect(output).toEqual({
            ok: false,
            file: 'Nope.md',
            run: null,
            error: { code: 'file-not-found', message: 'File not found: Nope.md' }
        })
    })

    it('reports run null when the note has no tracked run', () => {
        const output = parseOutput(handleStatusCli({ file: 'Notes/Test.md' }, makeDeps()))
        expect(output).toEqual({ ok: true, file: 'Notes/Test.md', run: null, error: null })
    })

    it('reports the full run document for a tracked run without mutating it', () => {
        const run = new FakeRunHandle(
            [makeState({ status: 'running', summary: 'Solid draft' })],
            [{ editorId: 'editor-1', quote: 'Hello', critique: 'Weak opener', suggestion: 'Hi' }],
            { settled: false }
        )
        const deps = makeDeps({ getRun: () => run })
        const output = parseOutput(handleStatusCli({ file: 'Notes/Test.md' }, deps))
        expect(output).toMatchObject({
            ok: true,
            file: 'Notes/Test.md',
            run: {
                settled: false,
                editors: [{ id: 'editor-1', name: 'Hater', status: 'running', error: null }],
                findings: [
                    {
                        editor: 'Hater',
                        severity: 'suggestion',
                        quote: 'Hello',
                        critique: 'Weak opener',
                        suggestion: 'Hi',
                        anchor: { from: 0, to: 5, state: 'anchored' }
                    }
                ],
                summaryByEditor: { Hater: 'Solid draft' }
            },
            error: null
        })
        expect(run.cancelCount).toBe(0)
        expect(run.findings.list()).toHaveLength(1)
    })

    it('resolves the file before looking up the run', () => {
        const lookups: string[] = []
        const deps = makeDeps({
            resolveFile: () => 'Notes/Test.md',
            getRun: (path) => {
                lookups.push(path)
                return null
            }
        })
        handleStatusCli({ file: 'Test' }, deps)
        expect(lookups).toEqual(['Notes/Test.md'])
    })

    it('renders text format when requested, json otherwise', () => {
        const run = new FakeRunHandle(
            [makeState()],
            [{ editorId: 'editor-1', quote: 'Hello', critique: 'Weak opener' }]
        )
        const deps = makeDeps({ getRun: () => run })
        const text = handleStatusCli({ file: 'Notes/Test.md', format: 'text' }, deps)
        expect(text.split('\n')).toEqual([
            'Run settled (1 done) — 1 finding',
            '[suggestion] Hater 0-5: "Hello" — Weak opener'
        ])
        const json = handleStatusCli({ file: 'Notes/Test.md', format: 'yaml' }, deps)
        expect(parseOutput(json).ok).toBe(true)
    })

    it('renders errors and the no-run case in text format too', () => {
        expect(handleStatusCli({ format: 'text' }, makeDeps())).toBe(
            'Error (bad-args): Missing required flag: file'
        )
        expect(handleStatusCli({ file: 'Notes/Test.md', format: 'text' }, makeDeps())).toBe(
            'No run for Notes/Test.md.'
        )
    })

    it('still reports the findings of a cancelled run (cancel does not discard)', () => {
        // The poll loop contract: cancel → status must keep answering with
        // the findings collected so far, because cancelling never discards
        // the run.
        const run = new FakeRunHandle(
            [makeState({ status: 'running' })],
            [{ editorId: 'editor-1', quote: 'Hello', critique: 'Weak opener' }],
            { settled: false }
        )
        const resolveFile = (file: string): string | null =>
            file === 'Notes/Test.md' ? 'Notes/Test.md' : null
        const getRun = (path: string): FakeRunHandle | null =>
            path === 'Notes/Test.md' ? run : null
        const cancelled = JSON.parse(
            handleCancelCli({ file: 'Notes/Test.md' }, { resolveFile, getRun })
        ) as { cancelled: boolean }
        expect(cancelled.cancelled).toBe(true)
        const output = parseOutput(
            handleStatusCli({ file: 'Notes/Test.md' }, { resolveFile, getRun })
        )
        expect(output.run?.findings).toHaveLength(1)
    })

    it('declares the command metadata with file required', () => {
        expect(STATUS_CLI_COMMAND).toBe('editor-ai-daemons:status')
        expect(STATUS_CLI_DESCRIPTION.length).toBeGreaterThan(0)
        expect(Object.keys(STATUS_CLI_FLAGS)).toEqual(['file', 'format'])
        expect(STATUS_CLI_FLAGS['file']?.required).toBe(true)
        expect(STATUS_CLI_FLAGS['format']?.required).toBeUndefined()
    })
})
