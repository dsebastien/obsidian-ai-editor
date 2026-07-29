import { describe, expect, it } from 'bun:test'
import { createAnchor } from '../../domain/anchoring/anchor'
import type { Anchor } from '../../domain/anchoring/anchor'
import { asFindingId, asRunId, generateId } from '../../domain/ids'
import { rawFindingSchema } from '../../domain/operations/contract'
import {
    editorConfigSchema,
    apiBackendSchema,
    pluginSettingsSchema
} from '../../domain/settings/settings-schema'
import type { EditorConfig, PluginSettingsV1 } from '../../domain/settings/settings-schema'
import { createSnapshot } from '../../domain/snapshot'
import { FindingStore } from '../orchestration/finding-store'
import type { EditorRunState, RunHandle } from '../orchestration/run-controller'
import type { EditorSkip, ReviewStart } from '../review-service'
import {
    REVIEW_CLI_FLAGS,
    formatTextOutput,
    handleReviewCli,
    parseReviewCliArgs,
    selectEditors,
    shapeRunOutput
} from './review-cli'
import type { ReviewCliDeps, ReviewCliOutput, ReviewCliRunInput } from './review-cli'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeEditor(overrides: Record<string, unknown> = {}): EditorConfig {
    return editorConfigSchema.parse({
        id: 'editor-1',
        name: 'Hater',
        color: 'var(--color-red)',
        ...overrides
    })
}

function makeSettings(overrides: Record<string, unknown> = {}): PluginSettingsV1 {
    return pluginSettingsSchema.parse({
        backends: [
            apiBackendSchema.parse({
                id: 'backend-1',
                family: 'api',
                kind: 'anthropic',
                label: 'Claude',
                apiKey: 'sk-cli-secret',
                defaultModel: 'claude-test-1'
            })
        ],
        defaultBackend: { backendId: 'backend-1', model: '' },
        editors: [makeEditor()],
        ...overrides
    })
}

function makeState(overrides: Partial<EditorRunState> = {}): EditorRunState {
    return {
        editorId: 'editor-1',
        editorName: 'Hater',
        runId: asRunId(generateId()),
        status: 'done',
        findingIds: [],
        summary: null,
        verdict: null,
        lastProgress: null,
        error: null,
        ...overrides
    }
}

interface FindingFixture {
    readonly editorId: string
    readonly quote: string
    readonly critique: string
    readonly suggestion?: string
    readonly severity?: 'info' | 'suggestion' | 'warning'
    readonly anchor?: Anchor | null
}

class FakeRunHandle implements RunHandle {
    readonly snapshot = createSnapshot({ filePath: 'Notes/Test.md', text: 'Hello world' })
    readonly findings = new FindingStore()
    readonly settled: Promise<void> = Promise.resolve()

    constructor(
        private readonly states: readonly EditorRunState[],
        findingFixtures: readonly FindingFixture[] = []
    ) {
        for (const fixture of findingFixtures) {
            this.findings.add({
                id: asFindingId(generateId()),
                runId: asRunId('run-1'),
                editorId: fixture.editorId,
                raw: rawFindingSchema.parse({
                    quote: fixture.quote,
                    critique: fixture.critique,
                    ...(fixture.suggestion === undefined ? {} : { suggestion: fixture.suggestion }),
                    ...(fixture.severity === undefined ? {} : { severity: fixture.severity })
                }),
                anchor: fixture.anchor === undefined ? createAnchor(0, 5) : fixture.anchor,
                anchoredText: fixture.anchor === null ? null : fixture.quote,
                matchStrategy: fixture.anchor === null ? null : 'exact'
            })
        }
    }

    getEditorStates(): readonly EditorRunState[] {
        return this.states
    }

    getEditorState(editorId: string): EditorRunState | null {
        return this.states.find((state) => state.editorId === editorId) ?? null
    }

    isSettled(): boolean {
        return true
    }

    subscribe(): () => void {
        return () => undefined
    }

    cancelRun(): void {
        // no-op for the fixture
    }

    applyTextChanges(): void {
        // no-op for the fixture
    }
}

function startedResult(run: RunHandle, skips: readonly EditorSkip[] = []): ReviewStart {
    return { status: 'started', run, skips, selectionFallback: false }
}

function makeDeps(overrides: Partial<ReviewCliDeps> = {}): ReviewCliDeps & {
    readonly runInputs: ReviewCliRunInput[]
} {
    const runInputs: ReviewCliRunInput[] = []
    return {
        runInputs,
        getSettings: () => makeSettings(),
        resolveFile: (file) => (file === 'Notes/Test.md' ? 'Notes/Test.md' : null),
        readNote: (path) => Promise.resolve(path === 'Notes/Test.md' ? 'Hello world' : null),
        runReview: (input): Promise<ReviewStart> => {
            runInputs.push(input)
            return Promise.resolve(startedResult(new FakeRunHandle([makeState()])))
        },
        ...overrides
    }
}

function parseOutput(rendered: string): ReviewCliOutput {
    return JSON.parse(rendered) as ReviewCliOutput
}

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

describe('parseReviewCliArgs', () => {
    it('applies defaults: json format, all editors, no confirmation', () => {
        const args = parseReviewCliArgs({ file: 'Notes/Test.md' })
        expect(args).toEqual({
            file: 'Notes/Test.md',
            editors: null,
            format: 'json',
            confirmLarge: false
        })
    })

    it('reports a missing or blank file flag as null', () => {
        expect(parseReviewCliArgs({}).file).toBeNull()
        expect(parseReviewCliArgs({ file: '   ' }).file).toBeNull()
    })

    it('trims the file value', () => {
        expect(parseReviewCliArgs({ file: '  Notes/Test.md ' }).file).toBe('Notes/Test.md')
    })

    it('splits editors on commas, trimming and dropping blanks', () => {
        const args = parseReviewCliArgs({
            file: 'a.md',
            editors: ' Hater , editor-2,, Concision Editor '
        })
        expect(args.editors).toEqual(['Hater', 'editor-2', 'Concision Editor'])
    })

    it('treats a blank editors value as all editors', () => {
        expect(parseReviewCliArgs({ file: 'a.md', editors: ' , ' }).editors).toBeNull()
    })

    it('accepts format text and falls back to json for unknown values', () => {
        expect(parseReviewCliArgs({ file: 'a.md', format: 'text' }).format).toBe('text')
        expect(parseReviewCliArgs({ file: 'a.md', format: 'yaml' }).format).toBe('json')
        expect(parseReviewCliArgs({ file: 'a.md' }).format).toBe('json')
    })

    it('treats a present confirm-large flag as confirmation', () => {
        expect(parseReviewCliArgs({ 'file': 'a.md', 'confirm-large': 'true' }).confirmLarge).toBe(
            true
        )
        expect(parseReviewCliArgs({ file: 'a.md' }).confirmLarge).toBe(false)
    })
})

// ---------------------------------------------------------------------------
// Editor selection
// ---------------------------------------------------------------------------

describe('selectEditors', () => {
    const settings = makeSettings({
        editors: [
            makeEditor(),
            makeEditor({ id: 'editor-2', name: 'Concision Editor', color: 'var(--color-blue)' })
        ]
    })

    it('passes the settings through untouched when no editors are requested', () => {
        const selection = selectEditors(settings, null)
        expect(selection.ok).toBe(true)
        if (selection.ok) {
            expect(selection.settings).toBe(settings)
        }
    })

    it('matches by id exactly and by name case-insensitively', () => {
        const selection = selectEditors(settings, ['editor-2', 'hater'])
        expect(selection.ok).toBe(true)
        if (selection.ok) {
            expect(selection.settings.editors.map((editor) => editor.id)).toEqual([
                'editor-2',
                'editor-1'
            ])
        }
    })

    it('collapses duplicate tokens onto one editor', () => {
        const selection = selectEditors(settings, ['Hater', 'editor-1'])
        expect(selection.ok).toBe(true)
        if (selection.ok) {
            expect(selection.settings.editors).toHaveLength(1)
        }
    })

    it('fails the whole selection on any unknown token', () => {
        const selection = selectEditors(settings, ['Hater', 'Nope', 'Also Nope'])
        expect(selection.ok).toBe(false)
        if (!selection.ok) {
            expect(selection.unknown).toEqual(['Nope', 'Also Nope'])
            expect(selection.disabled).toEqual([])
        }
    })

    it('fails the whole selection on an explicitly requested disabled editor', () => {
        // The pipeline silently drops disabled editors (no skip entry), so an
        // explicit request for one must be a typed error — otherwise scripts
        // get a partial review with no trace of the missing editor.
        const withDisabled = makeSettings({
            editors: [makeEditor(), makeEditor({ id: 'editor-2', name: 'Sleeper', enabled: false })]
        })
        const selection = selectEditors(withDisabled, ['Hater', 'Sleeper'])
        expect(selection.ok).toBe(false)
        if (!selection.ok) {
            expect(selection.unknown).toEqual([])
            expect(selection.disabled).toEqual(['Sleeper'])
        }
    })

    it('still passes disabled editors through when none are explicitly requested', () => {
        const withDisabled = makeSettings({
            editors: [makeEditor(), makeEditor({ id: 'editor-2', name: 'Sleeper', enabled: false })]
        })
        const selection = selectEditors(withDisabled, null)
        expect(selection.ok).toBe(true)
        if (selection.ok) {
            expect(selection.settings).toBe(withDisabled)
        }
    })
})

// ---------------------------------------------------------------------------
// Run output shaping
// ---------------------------------------------------------------------------

describe('shapeRunOutput', () => {
    it('shapes findings with editor names, severity, suggestion, and anchor', () => {
        const run = new FakeRunHandle(
            [makeState()],
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
        const output = shapeRunOutput('Notes/Test.md', run, [])
        expect(output.ok).toBe(true)
        expect(output.error).toBeNull()
        expect(output.file).toBe('Notes/Test.md')
        expect(output.findings).toHaveLength(2)
        const [first, second] = output.findings
        expect(first).toMatchObject({
            editor: 'Hater',
            severity: 'warning',
            quote: 'Hello',
            critique: 'Too generic',
            suggestion: 'Bonjour',
            anchor: { from: 0, to: 5, state: 'anchored' }
        })
        expect(typeof first?.id).toBe('string')
        expect(second).toMatchObject({ suggestion: null, anchor: null })
    })

    it('collects note-level summaries per editor name', () => {
        const run = new FakeRunHandle([
            makeState({ summary: 'Solid draft' }),
            makeState({ editorId: 'editor-2', editorName: 'Concision Editor' })
        ])
        const output = shapeRunOutput('Notes/Test.md', run, [])
        expect(output.summaryByEditor).toEqual({ Hater: 'Solid draft' })
    })

    it('keeps pre-run skips and appends post-run failures as skips', () => {
        const run = new FakeRunHandle([
            makeState(),
            makeState({
                editorId: 'editor-2',
                editorName: 'Timed Out',
                status: 'error',
                error: { code: 'timeout', message: 'Timed out' }
            }),
            makeState({ editorId: 'editor-3', editorName: 'Cancelled One', status: 'cancelled' })
        ])
        const preRun: EditorSkip[] = [
            { editorId: 'editor-4', editorName: 'No Backend', reason: 'no-backend-configured' }
        ]
        const output = shapeRunOutput('Notes/Test.md', run, preRun)
        expect(output.ok).toBe(true)
        expect(output.skips).toEqual([
            { editor: 'No Backend', reason: 'no-backend-configured' },
            { editor: 'Timed Out', reason: 'timeout' },
            { editor: 'Cancelled One', reason: 'cancelled' }
        ])
    })

    it('reports backend-error with joined redacted messages when every editor failed', () => {
        const run = new FakeRunHandle([
            makeState({
                status: 'error',
                error: { code: 'auth', message: 'HTTP 401 from backend' }
            }),
            makeState({
                editorId: 'editor-2',
                editorName: 'Second',
                status: 'error',
                error: { code: 'timeout', message: 'Timed out' }
            })
        ])
        const output = shapeRunOutput('Notes/Test.md', run, [])
        expect(output.ok).toBe(false)
        expect(output.error).toEqual({
            code: 'backend-error',
            message: 'Hater: HTTP 401 from backend; Second: Timed out'
        })
    })

    it('reports timeout when every failure was a timeout', () => {
        const run = new FakeRunHandle([
            makeState({ status: 'error', error: { code: 'timeout', message: 'Timed out' } })
        ])
        const output = shapeRunOutput('Notes/Test.md', run, [])
        expect(output.error?.code).toBe('timeout')
    })

    it('reports backend-error when the run was cancelled before any editor completed', () => {
        const run = new FakeRunHandle([makeState({ status: 'cancelled' })])
        const output = shapeRunOutput('Notes/Test.md', run, [])
        expect(output.ok).toBe(false)
        expect(output.error?.code).toBe('backend-error')
    })

    it('stays ok when at least one editor completed despite failures', () => {
        const run = new FakeRunHandle([
            makeState(),
            makeState({
                editorId: 'editor-2',
                editorName: 'Broken',
                status: 'error',
                error: { code: 'network', message: 'Network failure' }
            })
        ])
        const output = shapeRunOutput('Notes/Test.md', run, [])
        expect(output.ok).toBe(true)
        expect(output.error).toBeNull()
    })
})

// ---------------------------------------------------------------------------
// Text formatting
// ---------------------------------------------------------------------------

describe('formatTextOutput', () => {
    it('prints one line per finding with anchor range and suggestion', () => {
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
        const text = formatTextOutput(shapeRunOutput('Notes/Test.md', run, []))
        expect(text).toBe('[suggestion] Hater 0-5: "Hello world" — Multi line critique -> Hi')
    })

    it('labels unanchored findings and prints skip lines', () => {
        const run = new FakeRunHandle(
            [makeState()],
            [{ editorId: 'editor-1', quote: 'Hello', critique: 'No anchor', anchor: null }]
        )
        const skips: EditorSkip[] = [
            { editorId: 'editor-2', editorName: 'Sleeper', reason: 'backend-disabled' }
        ]
        const text = formatTextOutput(shapeRunOutput('Notes/Test.md', run, skips))
        expect(text.split('\n')).toEqual([
            '[suggestion] Hater unanchored: "Hello" — No anchor',
            'Skipped Sleeper: backend-disabled'
        ])
    })

    it('prints a single error line on failure', () => {
        const run = new FakeRunHandle([
            makeState({ status: 'error', error: { code: 'timeout', message: 'Timed out' } })
        ])
        const text = formatTextOutput(shapeRunOutput('Notes/Test.md', run, []))
        expect(text.split('\n')[0]).toBe('Error (timeout): Hater: Timed out')
    })

    it('prints No findings. for a successful empty run', () => {
        const run = new FakeRunHandle([makeState()])
        const text = formatTextOutput(shapeRunOutput('Notes/Test.md', run, []))
        expect(text).toBe('No findings.')
    })
})

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

describe('handleReviewCli', () => {
    it('returns file-not-found when the file flag is missing', async () => {
        const output = parseOutput(await handleReviewCli({}, makeDeps()))
        expect(output).toMatchObject({
            ok: false,
            file: '',
            findings: [],
            skips: [],
            summaryByEditor: {},
            error: { code: 'file-not-found', message: 'Missing required flag: file' }
        })
    })

    it('returns file-not-found when the file does not resolve', async () => {
        const output = parseOutput(await handleReviewCli({ file: 'Nope.md' }, makeDeps()))
        expect(output.error).toEqual({ code: 'file-not-found', message: 'File not found: Nope.md' })
        expect(output.file).toBe('Nope.md')
    })

    it('returns file-not-found when the note cannot be read', async () => {
        const deps = makeDeps({ readNote: () => Promise.resolve(null) })
        const output = parseOutput(await handleReviewCli({ file: 'Notes/Test.md' }, deps))
        expect(output.error).toEqual({
            code: 'file-not-found',
            message: 'File could not be read: Notes/Test.md'
        })
    })

    it('returns no-editors for unknown editor tokens without running', async () => {
        const deps = makeDeps()
        const output = parseOutput(
            await handleReviewCli({ file: 'Notes/Test.md', editors: 'Hater,Ghost' }, deps)
        )
        expect(output.error).toEqual({ code: 'no-editors', message: 'Unknown editors: Ghost' })
        expect(deps.runInputs).toHaveLength(0)
    })

    it('returns no-editors for explicitly requested disabled editors without running', async () => {
        const settings = makeSettings({
            editors: [makeEditor(), makeEditor({ id: 'editor-2', name: 'Sleeper', enabled: false })]
        })
        const deps = makeDeps({ getSettings: () => settings })
        const output = parseOutput(
            await handleReviewCli({ file: 'Notes/Test.md', editors: 'Sleeper,Ghost' }, deps)
        )
        expect(output.error?.code).toBe('no-editors')
        expect(output.error?.message).toBe(
            'Unknown editors: Ghost; Disabled editors: Sleeper — enable them in the settings'
        )
        expect(deps.runInputs).toHaveLength(0)
    })

    it('narrows the settings to the requested editors', async () => {
        const settings = makeSettings({
            editors: [makeEditor(), makeEditor({ id: 'editor-2', name: 'Concision Editor' })]
        })
        const deps = makeDeps({ getSettings: () => settings })
        await handleReviewCli({ file: 'Notes/Test.md', editors: 'concision editor' }, deps)
        expect(deps.runInputs[0]?.settings.editors.map((editor) => editor.id)).toEqual(['editor-2'])
    })

    it('returns excluded when the pipeline refuses the note', async () => {
        const deps = makeDeps({
            runReview: () => Promise.resolve({ status: 'excluded', notePath: 'Notes/Test.md' })
        })
        const output = parseOutput(await handleReviewCli({ file: 'Notes/Test.md' }, deps))
        expect(output.error?.code).toBe('excluded')
    })

    it('returns needs-confirmation with counts for oversized notes', async () => {
        const deps = makeDeps({
            runReview: () =>
                Promise.resolve({ status: 'needs-confirmation', wordCount: 12000, limit: 5000 })
        })
        const output = parseOutput(await handleReviewCli({ file: 'Notes/Test.md' }, deps))
        expect(output.error?.code).toBe('needs-confirmation')
        expect(output.error?.message).toContain('12000')
        expect(output.error?.message).toContain('5000')
        expect(output.error?.message).toContain('confirm-large')
    })

    it('passes confirm-large through to the pipeline', async () => {
        const deps = makeDeps()
        await handleReviewCli({ 'file': 'Notes/Test.md', 'confirm-large': 'true' }, deps)
        expect(deps.runInputs[0]?.confirmedLargeNote).toBe(true)
        await handleReviewCli({ file: 'Notes/Test.md' }, deps)
        expect(deps.runInputs[1]?.confirmedLargeNote).toBe(false)
    })

    it('returns no-editors with the pipeline skip report', async () => {
        const skips: EditorSkip[] = [
            { editorId: 'editor-1', editorName: 'Hater', reason: 'backend-disabled' }
        ]
        const deps = makeDeps({
            runReview: () => Promise.resolve({ status: 'no-editors', skips })
        })
        const output = parseOutput(await handleReviewCli({ file: 'Notes/Test.md' }, deps))
        expect(output.error?.code).toBe('no-editors')
        expect(output.error?.message).toContain('Hater')
        expect(output.skips).toEqual([{ editor: 'Hater', reason: 'backend-disabled' }])
    })

    it('waits for settle and returns the full JSON document on success', async () => {
        let settled = false
        const run = new FakeRunHandle(
            [makeState({ summary: 'Solid draft' })],
            [{ editorId: 'editor-1', quote: 'Hello', critique: 'Weak opener', suggestion: 'Hi' }]
        )
        Object.defineProperty(run, 'settled', {
            value: new Promise<void>((resolve) => {
                setTimeout(() => {
                    settled = true
                    resolve()
                }, 0)
            })
        })
        const deps = makeDeps({ runReview: () => Promise.resolve(startedResult(run)) })
        const output = parseOutput(await handleReviewCli({ file: 'Notes/Test.md' }, deps))
        expect(settled).toBe(true)
        expect(output).toMatchObject({
            ok: true,
            file: 'Notes/Test.md',
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
            skips: [],
            summaryByEditor: { Hater: 'Solid draft' },
            error: null
        })
    })

    it('renders text format when requested', async () => {
        const run = new FakeRunHandle(
            [makeState()],
            [{ editorId: 'editor-1', quote: 'Hello', critique: 'Weak opener' }]
        )
        const deps = makeDeps({ runReview: () => Promise.resolve(startedResult(run)) })
        const text = await handleReviewCli({ file: 'Notes/Test.md', format: 'text' }, deps)
        expect(text).toBe('[suggestion] Hater 0-5: "Hello" — Weak opener')
    })

    it('renders errors in text format too', async () => {
        const text = await handleReviewCli({ format: 'text' }, makeDeps())
        expect(text).toBe('Error (file-not-found): Missing required flag: file')
    })

    it('maps unexpected pipeline failures to a status-only backend-error', async () => {
        const deps = makeDeps({
            runReview: () => Promise.reject(new Error('secret-laden stack trace sk-123'))
        })
        const output = parseOutput(await handleReviewCli({ file: 'Notes/Test.md' }, deps))
        expect(output.error).toEqual({
            code: 'backend-error',
            message: 'The review failed unexpectedly'
        })
    })

    it('releases the settled run after the output document was shaped', async () => {
        const run = new FakeRunHandle(
            [makeState()],
            [{ editorId: 'editor-1', quote: 'Hello', critique: 'Weak opener' }]
        )
        const released: { path: string; run: unknown }[] = []
        const deps = makeDeps({
            runReview: () => Promise.resolve(startedResult(run)),
            releaseRun: (path, releasedRun) => {
                released.push({ path, run: releasedRun })
            }
        })
        const output = parseOutput(await handleReviewCli({ file: 'Notes/Test.md' }, deps))
        // Shaped BEFORE release: the findings made it into the document.
        expect(output.findings).toHaveLength(1)
        expect(released).toEqual([{ path: 'Notes/Test.md', run }])
    })

    it('does not release anything when the pipeline refused the run', async () => {
        const released: string[] = []
        const deps = makeDeps({
            runReview: () => Promise.resolve({ status: 'excluded', notePath: 'Notes/Test.md' }),
            releaseRun: (path) => {
                released.push(path)
            }
        })
        await handleReviewCli({ file: 'Notes/Test.md' }, deps)
        expect(released).toEqual([])
    })

    it('declares the documented flags with file required', () => {
        expect(REVIEW_CLI_FLAGS['file']?.required).toBe(true)
        expect(Object.keys(REVIEW_CLI_FLAGS)).toEqual([
            'file',
            'editors',
            'format',
            'confirm-large'
        ])
        for (const flag of Object.values(REVIEW_CLI_FLAGS)) {
            expect(flag.description.length).toBeGreaterThan(0)
        }
    })
})
