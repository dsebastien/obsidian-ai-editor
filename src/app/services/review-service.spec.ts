import { describe, expect, it } from 'bun:test'
import {
    apiBackendSchema,
    cliBackendSchema,
    editorConfigSchema,
    pluginSettingsSchema
} from '../domain/settings/settings-schema'
import type { ApiBackend, EditorConfig, PluginSettingsV1 } from '../domain/settings/settings-schema'
import { createSnapshot, hashText } from '../domain/snapshot'
import { RunController } from './orchestration/run-controller'
import type { NoteMetadata, VaultReader } from './context/vault-reader.intf'
import {
    composeSystemPrompt,
    countWords,
    createEditorSpec,
    isRequestedSelectionValid,
    resolveApiBackend,
    skipReasonLabel,
    startReview
} from './review-service'
import type { AssembledContext } from './context/context-assembler'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const API_KEY = 'sk-review-secret-42'

function makeBackend(overrides: Partial<ApiBackend> = {}): ApiBackend {
    return apiBackendSchema.parse({
        id: 'backend-1',
        family: 'api',
        kind: 'anthropic',
        label: 'Claude',
        apiKey: API_KEY,
        defaultModel: 'claude-test-1',
        ...overrides
    })
}

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
        backends: [makeBackend()],
        defaultBackend: { backendId: 'backend-1', model: '' },
        editors: [makeEditor()],
        ...overrides
    })
}

class FakeVault implements VaultReader {
    readonly notes = new Map<string, string>()
    readonly metadata = new Map<string, NoteMetadata>()

    async readNote(path: string): Promise<string | null> {
        return this.notes.get(path) ?? null
    }

    resolveLink(): string | null {
        return null
    }

    getOutgoingLinks(): string[] {
        return []
    }

    getNoteMetadata(path: string): NoteMetadata | null {
        return this.metadata.get(path) ?? { tags: [], frontmatter: {} }
    }
}

const DOC_TEXT = 'Hello world. This is a test document about writing well.'

function makeSnapshot(text = DOC_TEXT, filePath = 'Notes/Test.md') {
    return createSnapshot({ filePath, text })
}

/**
 * Anthropic-shaped SSE stream carrying a valid review result. The executor
 * streams Anthropic backends (`capabilities().streaming`), so success bodies
 * must be SSE-framed — the accumulated payload is then validated through the
 * same `parseBufferedResponse` as the buffered path.
 */
function anthropicReviewBody(): string {
    const resultInput = {
        kind: 'review',
        findings: [
            {
                quote: 'Hello world',
                critique: 'Generic opening line',
                suggestion: 'Bonjour world',
                severity: 'suggestion'
            }
        ],
        summary: 'Solid draft'
    }
    const frames = [
        {
            type: 'content_block_start',
            index: 0,
            content_block: { type: 'tool_use', name: 'emit_result', input: {} }
        },
        {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'input_json_delta', partial_json: JSON.stringify(resultInput) }
        },
        { type: 'message_stop' }
    ]
    return frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join('')
}

function fetchReturning(body: string, status = 200): typeof fetch {
    return (() => Promise.resolve(new Response(body, { status }))) as unknown as typeof fetch
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe('countWords', () => {
    it('counts whitespace-delimited words', () => {
        expect(countWords('one two  three\nfour\t five')).toBe(5)
    })

    it('returns 0 for empty or whitespace-only text', () => {
        expect(countWords('')).toBe(0)
        expect(countWords('   \n\t ')).toBe(0)
    })
})

describe('skipReasonLabel', () => {
    it('labels every reason', () => {
        const reasons = [
            'no-review-capability',
            'no-backend-configured',
            'backend-not-found',
            'backend-disabled',
            'cli-backend-unsupported',
            'no-model-configured'
        ] as const
        for (const reason of reasons) {
            expect(skipReasonLabel(reason).length).toBeGreaterThan(0)
        }
    })
})

describe('isRequestedSelectionValid', () => {
    const fresh = { hash: hashText(DOC_TEXT), text: DOC_TEXT }

    it('accepts an ordered non-empty range inside the unchanged text', () => {
        expect(isRequestedSelectionValid({ from: 0, to: 11 }, fresh.hash, fresh)).toBe(true)
        expect(isRequestedSelectionValid({ from: 0, to: DOC_TEXT.length }, fresh.hash, fresh)).toBe(
            true
        )
    })

    it('rejects degenerate and inverted ranges', () => {
        expect(isRequestedSelectionValid({ from: 5, to: 5 }, fresh.hash, fresh)).toBe(false)
        expect(isRequestedSelectionValid({ from: 11, to: 3 }, fresh.hash, fresh)).toBe(false)
    })

    it('rejects out-of-bounds offsets', () => {
        expect(isRequestedSelectionValid({ from: -1, to: 5 }, fresh.hash, fresh)).toBe(false)
        expect(
            isRequestedSelectionValid({ from: 0, to: DOC_TEXT.length + 1 }, fresh.hash, fresh)
        ).toBe(false)
    })

    it('rejects when the text changed since capture, even with fitting bounds', () => {
        const capturedHash = hashText(`EDIT! ${DOC_TEXT}`)
        expect(isRequestedSelectionValid({ from: 0, to: 11 }, capturedHash, fresh)).toBe(false)
    })
})

describe('resolveApiBackend', () => {
    it('inherits the global default backend and its default model', () => {
        const settings = makeSettings()
        const resolution = resolveApiBackend(settings, settings.editors[0]!)
        expect(resolution).toEqual({
            ok: true,
            backend: settings.backends[0] as ApiBackend,
            model: 'claude-test-1'
        })
    })

    it('prefers the editor-level backend ref and model override', () => {
        const other = makeBackend({ id: 'backend-2', label: 'Other', defaultModel: 'other-model' })
        const settings = makeSettings({
            backends: [makeBackend(), other],
            editors: [makeEditor({ backend: { backendId: 'backend-2', model: 'override' } })]
        })
        const resolution = resolveApiBackend(settings, settings.editors[0]!)
        expect(resolution).toEqual({ ok: true, backend: other, model: 'override' })
    })

    it('reports missing configuration as typed skips', () => {
        const editor = makeEditor()
        expect(resolveApiBackend(makeSettings({ defaultBackend: null }), editor)).toEqual({
            ok: false,
            reason: 'no-backend-configured'
        })
        expect(
            resolveApiBackend(
                makeSettings({ defaultBackend: { backendId: 'ghost', model: '' } }),
                editor
            )
        ).toEqual({ ok: false, reason: 'backend-not-found' })
        expect(
            resolveApiBackend(makeSettings({ backends: [makeBackend({ enabled: false })] }), editor)
        ).toEqual({ ok: false, reason: 'backend-disabled' })
        expect(
            resolveApiBackend(
                makeSettings({ backends: [makeBackend({ defaultModel: '' })] }),
                editor
            )
        ).toEqual({ ok: false, reason: 'no-model-configured' })
    })

    it('skips CLI backends until their executor exists', () => {
        const cli = cliBackendSchema.parse({
            id: 'backend-1',
            family: 'cli',
            kind: 'claude-code',
            label: 'Claude Code',
            enabled: true
        })
        const settings = makeSettings({ backends: [cli] })
        expect(resolveApiBackend(settings, settings.editors[0]!)).toEqual({
            ok: false,
            reason: 'cli-backend-unsupported'
        })
    })
})

describe('composeSystemPrompt', () => {
    it('returns the bare system prompt without attachments', () => {
        const context: AssembledContext = {
            systemPrompt: 'Be harsh.',
            attachments: [],
            preview: [],
            truncated: []
        }
        expect(composeSystemPrompt(context)).toBe('Be harsh.')
    })

    it('appends attachments as delimited context blocks', () => {
        const context: AssembledContext = {
            systemPrompt: 'Be harsh.',
            attachments: [
                { path: 'Voice "Profile".md', content: 'Voice rules', reason: 'prompt-ref' }
            ],
            preview: [],
            truncated: []
        }
        const prompt = composeSystemPrompt(context)
        expect(prompt).toStartWith('Be harsh.')
        expect(prompt).toContain('<context-note path="Voice \'Profile\'.md">')
        expect(prompt).toContain('Voice rules')
        expect(prompt).toContain('</context-note>')
    })
})

// ---------------------------------------------------------------------------
// createEditorSpec (transport/protocol behavior is covered by
// backends/api-editor-backend.spec.ts — this seam binds identity + redaction)
// ---------------------------------------------------------------------------

describe('createEditorSpec', () => {
    it('binds editor identity and the key-redaction seam', () => {
        const spec = createEditorSpec({
            editor: makeEditor(),
            backend: makeBackend(),
            model: 'claude-test-1',
            systemPrompt: 'Be harsh.',
            fetchImpl: fetchReturning(anthropicReviewBody())
        })
        expect(spec.editorId).toBe('editor-1')
        expect(spec.editorName).toBe('Hater')
        expect(spec.redactError?.(`401 body echoing ${API_KEY}`)).toBe(
            '401 body echoing [redacted]'
        )
    })
})

// ---------------------------------------------------------------------------
// startReview
// ---------------------------------------------------------------------------

describe('startReview', () => {
    it('refuses an excluded target before anything else', async () => {
        const settings = makeSettings({
            behavior: { excludedFolders: ['Private'] }
        })
        const result = await startReview({
            settings,
            snapshot: makeSnapshot(DOC_TEXT, 'Private/Secret.md'),
            vault: new FakeVault(),
            runController: new RunController(),
            fetchImpl: fetchReturning(anthropicReviewBody())
        })
        expect(result).toEqual({ status: 'excluded', notePath: 'Private/Secret.md' })
    })

    it('requires confirmation above the size warning threshold', async () => {
        const settings = makeSettings({ behavior: { sizeWarningWords: 100 } })
        const bigText = Array.from({ length: 101 }, (_, i) => `word${i}`).join(' ')
        const input = {
            settings,
            snapshot: makeSnapshot(bigText),
            vault: new FakeVault(),
            runController: new RunController(),
            fetchImpl: fetchReturning(anthropicReviewBody())
        }
        const refused = await startReview(input)
        expect(refused).toEqual({ status: 'needs-confirmation', wordCount: 101, limit: 100 })

        const confirmed = await startReview({ ...input, confirmedLargeNote: true })
        expect(confirmed.status).toBe('started')
    })

    it('returns no-editors with a full skip report when nobody can run', async () => {
        const settings = makeSettings({
            editors: [
                makeEditor({ id: 'e-1', name: 'No capability', capabilities: { review: false } }),
                makeEditor({ id: 'e-2', name: 'No backend', backend: { backendId: 'ghost' } }),
                makeEditor({ id: 'e-3', name: 'Disabled editor', enabled: false })
            ],
            defaultBackend: null
        })
        const result = await startReview({
            settings,
            snapshot: makeSnapshot(),
            vault: new FakeVault(),
            runController: new RunController(),
            fetchImpl: fetchReturning(anthropicReviewBody())
        })
        if (result.status !== 'no-editors') {
            throw new Error(`Expected no-editors, got ${result.status}`)
        }
        expect(result.skips).toEqual([
            { editorId: 'e-1', editorName: 'No capability', reason: 'no-review-capability' },
            { editorId: 'e-2', editorName: 'No backend', reason: 'backend-not-found' }
        ])
    })

    it('runs the full pipeline: context, backend call, anchored findings', async () => {
        const settings = makeSettings()
        const runController = new RunController()
        const result = await startReview({
            settings,
            snapshot: makeSnapshot(),
            vault: new FakeVault(),
            runController,
            fetchImpl: fetchReturning(anthropicReviewBody())
        })
        if (result.status !== 'started') {
            throw new Error(`Expected started, got ${result.status}`)
        }
        expect(result.skips).toEqual([])
        await result.run.settled
        const state = result.run.getEditorState('editor-1')
        expect(state?.status).toBe('done')
        expect(state?.summary).toBe('Solid draft')
        const findings = result.run.findings.list()
        expect(findings).toHaveLength(1)
        expect(findings[0]?.anchor).toEqual({
            from: DOC_TEXT.indexOf('Hello world'),
            to: DOC_TEXT.indexOf('Hello world') + 'Hello world'.length,
            state: 'anchored'
        })
        expect(runController.getRun('Notes/Test.md')).toBe(result.run)
    })

    it('starts the run on the refreshed snapshot taken right before startRun', async () => {
        // Simulates the user typing while context assembly awaited vault
        // reads: the refreshed text has a prefix inserted before the quoted
        // passage, so anchors must land on the SHIFTED offsets.
        const editedText = `EDIT! ${DOC_TEXT}`
        const runController = new RunController()
        const result = await startReview({
            settings: makeSettings(),
            snapshot: makeSnapshot(),
            vault: new FakeVault(),
            runController,
            fetchImpl: fetchReturning(anthropicReviewBody()),
            refreshSnapshot: () => makeSnapshot(editedText)
        })
        if (result.status !== 'started') {
            throw new Error(`Expected started, got ${result.status}`)
        }
        expect(result.run.snapshot.text).toBe(editedText)
        await result.run.settled
        const findings = result.run.findings.list()
        expect(findings).toHaveLength(1)
        expect(findings[0]?.anchor).toEqual({
            from: editedText.indexOf('Hello world'),
            to: editedText.indexOf('Hello world') + 'Hello world'.length,
            state: 'anchored'
        })
    })

    it('falls back to the original snapshot when the refresh is null or foreign', async () => {
        const original = makeSnapshot()
        for (const refreshSnapshot of [
            (): null => null,
            (): ReturnType<typeof makeSnapshot> => makeSnapshot('other text', 'Notes/Other.md')
        ]) {
            const result = await startReview({
                settings: makeSettings(),
                snapshot: original,
                vault: new FakeVault(),
                runController: new RunController(),
                fetchImpl: fetchReturning(anthropicReviewBody()),
                refreshSnapshot
            })
            if (result.status !== 'started') {
                throw new Error(`Expected started, got ${result.status}`)
            }
            expect(result.run.snapshot).toBe(original)
            await result.run.settled
        }
    })

    it('reports skipped editors while running the usable ones', async () => {
        const settings = makeSettings({
            editors: [
                makeEditor(),
                makeEditor({ id: 'editor-2', name: 'Orphan', backend: { backendId: 'ghost' } })
            ]
        })
        const result = await startReview({
            settings,
            snapshot: makeSnapshot(),
            vault: new FakeVault(),
            runController: new RunController(),
            fetchImpl: fetchReturning(anthropicReviewBody())
        })
        if (result.status !== 'started') {
            throw new Error(`Expected started, got ${result.status}`)
        }
        expect(result.skips).toEqual([
            { editorId: 'editor-2', editorName: 'Orphan', reason: 'backend-not-found' }
        ])
        await result.run.settled
        expect(result.run.getEditorStates()).toHaveLength(1)
    })

    it('excludes attached context notes without failing the run', async () => {
        const vault = new FakeVault()
        vault.notes.set('Voice.md', 'Voice rules here')
        vault.notes.set('Private/Persona.md', 'secret persona')
        vault.metadata.set('Private/Persona.md', { tags: ['private'], frontmatter: {} })
        const captured: string[] = []
        const fetchImpl = ((url: string, init: { body: string }) => {
            captured.push(init.body)
            void url
            return Promise.resolve(new Response(anthropicReviewBody(), { status: 200 }))
        }) as unknown as typeof fetch
        const settings = makeSettings({
            voiceProfile: { text: 'Sound like me.', notePaths: ['Voice.md'] },
            editors: [
                makeEditor({ prompt: { text: 'Be harsh.', notePaths: ['Private/Persona.md'] } })
            ],
            behavior: { excludedTags: ['private'] }
        })
        const result = await startReview({
            settings,
            snapshot: makeSnapshot(),
            vault,
            runController: new RunController(),
            fetchImpl
        })
        expect(result.status).toBe('started')
        if (result.status === 'started') {
            await result.run.settled
        }
        const body = captured[0] ?? ''
        expect(body).toContain('Voice rules here')
        expect(body).not.toContain('secret persona')
    })

    it('maps HTTP auth failures to typed errors without leaking the key', async () => {
        const fetchImpl = fetchReturning(`{"error":"bad key ${API_KEY}"}`, 401)
        const result = await startReview({
            settings: makeSettings(),
            snapshot: makeSnapshot(),
            vault: new FakeVault(),
            runController: new RunController(),
            fetchImpl
        })
        if (result.status !== 'started') {
            throw new Error(`Expected started, got ${result.status}`)
        }
        await result.run.settled
        const state = result.run.getEditorState('editor-1')
        expect(state?.status).toBe('error')
        expect(state?.error?.code).toBe('auth')
        expect(state?.error?.message ?? '').not.toContain(API_KEY)
    })

    it('surfaces invalid backend configuration without touching the network', async () => {
        let fetchCalls = 0
        const fetchImpl = ((): Promise<Response> => {
            fetchCalls += 1
            return Promise.resolve(new Response(anthropicReviewBody(), { status: 200 }))
        }) as unknown as typeof fetch
        const result = await startReview({
            settings: makeSettings({ backends: [makeBackend({ apiKey: '' })] }),
            snapshot: makeSnapshot(),
            vault: new FakeVault(),
            runController: new RunController(),
            fetchImpl
        })
        if (result.status !== 'started') {
            throw new Error(`Expected started, got ${result.status}`)
        }
        await result.run.settled
        const state = result.run.getEditorState('editor-1')
        expect(state?.status).toBe('error')
        expect(state?.error?.code).toBe('unknown')
        expect(state?.error?.message).toContain('no API key')
        expect(fetchCalls).toBe(0)
    })

    it('cancelling the run aborts the in-flight request', async () => {
        let sawAbort = false
        const fetchImpl = ((url: string, init: { signal: AbortSignal }) => {
            void url
            return new Promise<Response>((_, reject) => {
                const onAbort = (): void => {
                    sawAbort = true
                    reject(new DOMException('aborted', 'AbortError'))
                }
                if (init.signal.aborted) {
                    onAbort()
                } else {
                    init.signal.addEventListener('abort', onAbort)
                }
            })
        }) as unknown as typeof fetch
        const result = await startReview({
            settings: makeSettings(),
            snapshot: makeSnapshot(),
            vault: new FakeVault(),
            runController: new RunController(),
            fetchImpl
        })
        if (result.status !== 'started') {
            throw new Error(`Expected started, got ${result.status}`)
        }
        result.run.cancelRun()
        await result.run.settled
        expect(sawAbort).toBe(true)
        expect(result.run.getEditorState('editor-1')?.status).toBe('cancelled')
    })

    // -- Selection scope (requestedSelection contract) -----------------------

    it('scopes the run to a valid requested selection', async () => {
        const result = await startReview({
            settings: makeSettings(),
            snapshot: makeSnapshot(),
            vault: new FakeVault(),
            runController: new RunController(),
            fetchImpl: fetchReturning(anthropicReviewBody()),
            requestedSelection: { from: 0, to: 11, capturedHash: hashText(DOC_TEXT) }
        })
        if (result.status !== 'started') {
            throw new Error(`Expected started, got ${result.status}`)
        }
        expect(result.selectionFallback).toBe(false)
        expect(result.run.snapshot.selection).toEqual({ from: 0, to: 11 })
        await result.run.settled
    })

    it('applies the requested selection to an unchanged refreshed snapshot', async () => {
        // The refresh recaptured the same text (hash equal) but a DIFFERENT
        // live selection — the synchronously captured range must win.
        const result = await startReview({
            settings: makeSettings(),
            snapshot: makeSnapshot(),
            vault: new FakeVault(),
            runController: new RunController(),
            fetchImpl: fetchReturning(anthropicReviewBody()),
            refreshSnapshot: () =>
                createSnapshot({
                    filePath: 'Notes/Test.md',
                    text: DOC_TEXT,
                    selection: { from: 3, to: 7 }
                }),
            requestedSelection: { from: 0, to: 11, capturedHash: hashText(DOC_TEXT) }
        })
        if (result.status !== 'started') {
            throw new Error(`Expected started, got ${result.status}`)
        }
        expect(result.selectionFallback).toBe(false)
        expect(result.run.snapshot.selection).toEqual({ from: 0, to: 11 })
        await result.run.settled
    })

    it('falls back to whole-note scope when the requested selection is out of bounds', async () => {
        const result = await startReview({
            settings: makeSettings(),
            snapshot: makeSnapshot(),
            vault: new FakeVault(),
            runController: new RunController(),
            fetchImpl: fetchReturning(anthropicReviewBody()),
            requestedSelection: {
                from: 0,
                to: DOC_TEXT.length + 50,
                capturedHash: hashText(DOC_TEXT)
            }
        })
        if (result.status !== 'started') {
            throw new Error(`Expected started, got ${result.status}`)
        }
        expect(result.selectionFallback).toBe(true)
        expect(result.run.snapshot.selection).toBeUndefined()
        await result.run.settled
    })

    it('falls back to whole-note scope on a degenerate (empty) requested selection', async () => {
        const result = await startReview({
            settings: makeSettings(),
            snapshot: makeSnapshot(),
            vault: new FakeVault(),
            runController: new RunController(),
            fetchImpl: fetchReturning(anthropicReviewBody()),
            requestedSelection: { from: 5, to: 5, capturedHash: hashText(DOC_TEXT) }
        })
        if (result.status !== 'started') {
            throw new Error(`Expected started, got ${result.status}`)
        }
        expect(result.selectionFallback).toBe(true)
        expect(result.run.snapshot.selection).toBeUndefined()
        await result.run.settled
    })

    it('falls back when the document changed between capture and run start', async () => {
        // Bounds still fit the edited text, but the hash mismatch proves the
        // offsets refer to stale content — whole note, stale live selection
        // stripped, and the run opens on the FRESH text.
        const editedText = `EDIT! ${DOC_TEXT}`
        const result = await startReview({
            settings: makeSettings(),
            snapshot: makeSnapshot(),
            vault: new FakeVault(),
            runController: new RunController(),
            fetchImpl: fetchReturning(anthropicReviewBody()),
            refreshSnapshot: () =>
                createSnapshot({
                    filePath: 'Notes/Test.md',
                    text: editedText,
                    selection: { from: 2, to: 8 }
                }),
            requestedSelection: { from: 0, to: 11, capturedHash: hashText(DOC_TEXT) }
        })
        if (result.status !== 'started') {
            throw new Error(`Expected started, got ${result.status}`)
        }
        expect(result.selectionFallback).toBe(true)
        expect(result.run.snapshot.selection).toBeUndefined()
        expect(result.run.snapshot.text).toBe(editedText)
        await result.run.settled
    })

    it('falls back across a size-confirmation round trip when the note was edited meanwhile', async () => {
        // Round-trip shape: the selection was captured against the ORIGINAL
        // text, the size modal delayed the run, the user edited, and the
        // caller re-snapshots AFTER the modal — so the input snapshot is
        // already the post-edit text. Validating against `snapshot.hash`
        // would compare the fresh hash with itself and pass; only the carried
        // `capturedHash` proves the offsets are stale (bounds still fit).
        const originalText = `${DOC_TEXT} tail`
        const postEditSnapshot = createSnapshot({ filePath: 'Notes/Test.md', text: DOC_TEXT })
        const result = await startReview({
            settings: makeSettings(),
            snapshot: postEditSnapshot,
            vault: new FakeVault(),
            runController: new RunController(),
            fetchImpl: fetchReturning(anthropicReviewBody()),
            requestedSelection: { from: 0, to: 11, capturedHash: hashText(originalText) }
        })
        if (result.status !== 'started') {
            throw new Error(`Expected started, got ${result.status}`)
        }
        expect(result.selectionFallback).toBe(true)
        expect(result.run.snapshot.selection).toBeUndefined()
        await result.run.settled
    })

    it('keeps the legacy snapshot-carried selection when none is requested', async () => {
        const snapshot = createSnapshot({
            filePath: 'Notes/Test.md',
            text: DOC_TEXT,
            selection: { from: 0, to: 5 }
        })
        const result = await startReview({
            settings: makeSettings(),
            snapshot,
            vault: new FakeVault(),
            runController: new RunController(),
            fetchImpl: fetchReturning(anthropicReviewBody())
        })
        if (result.status !== 'started') {
            throw new Error(`Expected started, got ${result.status}`)
        }
        expect(result.selectionFallback).toBe(false)
        expect(result.run.snapshot).toBe(snapshot)
        expect(result.run.snapshot.selection).toEqual({ from: 0, to: 5 })
        await result.run.settled
    })
})
