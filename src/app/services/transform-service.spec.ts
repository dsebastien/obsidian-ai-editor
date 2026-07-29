import { describe, expect, it } from 'bun:test'
import { getBuiltInVerb } from '../domain/actions/verb-registry'
import {
    apiBackendSchema,
    editorConfigSchema,
    pluginSettingsSchema
} from '../domain/settings/settings-schema'
import type { ApiBackend, EditorConfig, PluginSettingsV1 } from '../domain/settings/settings-schema'
import { createSnapshot } from '../domain/snapshot'
import type { NoteMetadata, VaultReader } from './context/vault-reader.intf'
import { RunController } from './orchestration/run-controller'
import { TransformController } from './orchestration/transform-run'
import { isInsertionAnchorValid, startAction } from './transform-service'
import type { StartActionInput } from './transform-service'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const API_KEY = 'sk-transform-secret-7'

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
        name: 'Concision Editor',
        color: 'var(--color-orange)',
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

const DOC_TEXT = 'Intro paragraph. The selected middle part. Closing words.'
const SELECTION = { from: 17, to: 42 } // 'The selected middle part.'

function makeSnapshot(text = DOC_TEXT, filePath = 'Notes/Test.md') {
    return createSnapshot({ filePath, text })
}

/** Anthropic-shaped SSE stream carrying one schema-valid operation result. */
function anthropicResultBody(resultInput: Record<string, unknown>): string {
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

interface CapturedRequest {
    url: string
    body: Record<string, unknown>
}

/** Fetch fake that records every request body and answers with `body`. */
function capturingFetch(body: string): { fetchImpl: typeof fetch; requests: CapturedRequest[] } {
    const requests: CapturedRequest[] = []
    const fetchImpl = ((url: string, init?: RequestInit) => {
        requests.push({
            url,
            body: JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as Record<
                string,
                unknown
            >
        })
        return Promise.resolve(new Response(body, { status: 200 }))
    }) as unknown as typeof fetch
    return { fetchImpl, requests }
}

function makeInput(overrides: Partial<StartActionInput> = {}): StartActionInput {
    const snapshot = overrides.snapshot ?? makeSnapshot()
    return {
        settings: makeSettings(),
        snapshot,
        vault: new FakeVault(),
        runController: new RunController(),
        transformController: new TransformController(),
        actionId: 'rephrase',
        editorId: 'editor-1',
        selection: { ...SELECTION, capturedHash: snapshot.hash },
        fetchImpl: capturingFetch(
            anthropicResultBody({
                kind: 'transform-selection',
                replacement: 'A better middle part.'
            })
        ).fetchImpl,
        ...overrides
    }
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe('isInsertionAnchorValid', () => {
    const fresh = makeSnapshot()

    it('accepts a caret (from === to) inside the text with a matching hash', () => {
        expect(isInsertionAnchorValid({ from: 5, to: 5 }, fresh.hash, fresh)).toBe(true)
        expect(isInsertionAnchorValid({ from: 0, to: DOC_TEXT.length }, fresh.hash, fresh)).toBe(
            true
        )
    })

    it('rejects inverted or out-of-bounds anchors', () => {
        expect(isInsertionAnchorValid({ from: 9, to: 5 }, fresh.hash, fresh)).toBe(false)
        expect(isInsertionAnchorValid({ from: -1, to: 5 }, fresh.hash, fresh)).toBe(false)
        expect(
            isInsertionAnchorValid({ from: 0, to: DOC_TEXT.length + 1 }, fresh.hash, fresh)
        ).toBe(false)
    })

    it('rejects anchors captured against different text', () => {
        expect(isInsertionAnchorValid({ from: 5, to: 5 }, 'stale-hash', fresh)).toBe(false)
    })
})

// ---------------------------------------------------------------------------
// Refusals
// ---------------------------------------------------------------------------

describe('startAction refusals', () => {
    it('refuses unknown action ids', async () => {
        const result = await startAction(makeInput({ actionId: 'not-a-verb' }))
        expect(result).toEqual({ status: 'unknown-action', actionId: 'not-a-verb' })
    })

    it('refuses excluded targets before anything else (Business Rules #7)', async () => {
        const result = await startAction(
            makeInput({
                settings: makeSettings({
                    behavior: { excludedFolders: ['Notes'] }
                })
            })
        )
        expect(result).toEqual({ status: 'excluded', notePath: 'Notes/Test.md' })
    })

    it('requires confirmation for oversized notes, then proceeds when confirmed', async () => {
        const settings = makeSettings({ behavior: { sizeWarningWords: 100 } })
        const longText = Array.from({ length: 150 }, (_, i) => `word${i}`).join(' ')
        const snapshot = makeSnapshot(longText)
        const base = makeInput({
            settings,
            snapshot,
            selection: { from: 0, to: 10, capturedHash: snapshot.hash }
        })
        const refused = await startAction(base)
        expect(refused.status).toBe('needs-confirmation')
        if (refused.status === 'needs-confirmation') {
            expect(refused.wordCount).toBe(150)
            expect(refused.limit).toBe(100)
        }
        const confirmed = await startAction({ ...base, confirmedLargeNote: true })
        expect(confirmed.status).toBe('started')
    })

    it('refuses a transform verb without a selection', async () => {
        const input = makeInput()
        const { selection: _dropped, ...rest } = input
        const result = await startAction(rest)
        expect(result).toEqual({ status: 'selection-required' })
    })

    it('refuses when the target editor is unknown or disabled', async () => {
        const unknown = await startAction(makeInput({ editorId: 'ghost' }))
        expect(unknown).toEqual({ status: 'no-editor', skips: [] })
        const disabled = await startAction(
            makeInput({ settings: makeSettings({ editors: [makeEditor({ enabled: false })] }) })
        )
        expect(disabled).toEqual({ status: 'no-editor', skips: [] })
    })

    it('reports rewrite capability off as a typed skip', async () => {
        const result = await startAction(
            makeInput({
                settings: makeSettings({
                    editors: [
                        makeEditor({
                            capabilities: { review: true, rewrite: false, research: false }
                        })
                    ]
                })
            })
        )
        expect(result).toEqual({
            status: 'no-editor',
            skips: [
                {
                    editorId: 'editor-1',
                    editorName: 'Concision Editor',
                    reason: 'no-rewrite-capability'
                }
            ]
        })
    })

    it('reports backend resolution failures as typed skips', async () => {
        const result = await startAction(
            makeInput({
                settings: makeSettings({ backends: [makeBackend({ enabled: false })] })
            })
        )
        expect(result).toEqual({
            status: 'no-editor',
            skips: [
                {
                    editorId: 'editor-1',
                    editorName: 'Concision Editor',
                    reason: 'backend-disabled'
                }
            ]
        })
    })

    it('refuses a stale selection (captured against different text)', async () => {
        const result = await startAction(
            makeInput({ selection: { ...SELECTION, capturedHash: 'stale-hash' } })
        )
        expect(result).toEqual({ status: 'selection-changed' })
    })

    it('refuses a degenerate selection for transform verbs', async () => {
        const snapshot = makeSnapshot()
        const result = await startAction(
            makeInput({ snapshot, selection: { from: 5, to: 5, capturedHash: snapshot.hash } })
        )
        expect(result).toEqual({ status: 'selection-changed' })
    })

    it('refuses when edits during context assembly invalidated the selection', async () => {
        const snapshot = makeSnapshot()
        const result = await startAction(
            makeInput({
                snapshot,
                selection: { ...SELECTION, capturedHash: snapshot.hash },
                refreshSnapshot: () => makeSnapshot(`${DOC_TEXT} edited meanwhile`)
            })
        )
        expect(result).toEqual({ status: 'selection-changed' })
    })
})

// ---------------------------------------------------------------------------
// Transform dispatch
// ---------------------------------------------------------------------------

describe('startAction transform verbs', () => {
    it('dispatches a transform-selection request and settles with the replacement', async () => {
        const { fetchImpl, requests } = capturingFetch(
            anthropicResultBody({
                kind: 'transform-selection',
                replacement: 'A better middle part.',
                rationale: 'Tighter'
            })
        )
        const result = await startAction(makeInput({ fetchImpl }))
        expect(result.status).toBe('started')
        if (result.status !== 'started') {
            return
        }
        await result.run.settled
        expect(result.run.kind).toBe('transform-selection')
        expect(result.run.getState().status).toBe('done')
        expect(result.run.getState().outcome).toEqual({
            text: 'A better middle part.',
            rationale: 'Tighter'
        })
        // The request rode the same provider adapter machinery as reviews.
        expect(requests).toHaveLength(1)
        const body = requests[0]?.body ?? {}
        const messages = body['messages'] as { content: string }[]
        const userMessage = messages[0]?.content ?? ''
        expect(userMessage).toContain('<selection>\nThe selected middle part.\n</selection>')
        expect(userMessage).toContain(getBuiltInVerb('rephrase')?.instruction ?? '!!missing')
        // The persona system prompt is composed exactly like a review's.
        expect(String(body['system'])).toBe('')
    })

    it('captures the replace-span target with the exact span text', async () => {
        const result = await startAction(makeInput())
        expect(result.status).toBe('started')
        if (result.status !== 'started') {
            return
        }
        expect(result.run.target).toMatchObject({
            kind: 'replace-span',
            from: SELECTION.from,
            to: SELECTION.to,
            spanText: 'The selected middle part.'
        })
        // The verb's UI label rides on the handle for the preview widget.
        expect(result.run.actionLabel).toBe('Rephrase')
        await result.run.settled
        const precondition = result.run.checkPrecondition(DOC_TEXT)
        expect(precondition.ok).toBe(true)
    })

    it('includes the editor persona prompt in the system prompt', async () => {
        const { fetchImpl, requests } = capturingFetch(
            anthropicResultBody({ kind: 'transform-selection', replacement: 'x' })
        )
        const result = await startAction(
            makeInput({
                fetchImpl,
                settings: makeSettings({
                    editors: [
                        makeEditor({
                            prompt: { text: 'You are ruthless about flab.', notePaths: [] }
                        })
                    ]
                })
            })
        )
        expect(result.status).toBe('started')
        if (result.status !== 'started') {
            return
        }
        await result.run.settled
        expect(String(requests[0]?.body['system'])).toContain('You are ruthless about flab.')
    })

    it('uses the refreshed snapshot when the selection survives the refresh', async () => {
        // Same text re-snapshotted (hash unchanged) — the run must open on
        // the refreshed snapshot, not the stale one.
        const snapshot = makeSnapshot()
        const refreshed = makeSnapshot()
        const result = await startAction(
            makeInput({
                snapshot,
                selection: { ...SELECTION, capturedHash: snapshot.hash },
                refreshSnapshot: () => refreshed
            })
        )
        expect(result.status).toBe('started')
        if (result.status !== 'started') {
            return
        }
        expect(result.run.snapshot.id).toBe(refreshed.id)
    })

    it('replaces the previous transform run for the same file', async () => {
        const transformController = new TransformController()
        const first = await startAction(makeInput({ transformController }))
        const second = await startAction(makeInput({ transformController }))
        expect(first.status).toBe('started')
        expect(second.status).toBe('started')
        if (first.status !== 'started' || second.status !== 'started') {
            return
        }
        await first.run.settled
        await second.run.settled
        expect(transformController.getRun('Notes/Test.md')).toBe(second.run)
    })
})

// ---------------------------------------------------------------------------
// Generate dispatch
// ---------------------------------------------------------------------------

describe('startAction generate verbs', () => {
    const insertBody = anthropicResultBody({ kind: 'insert-at', insertion: ' More prose.' })

    it('inserts after the selection when one is provided', async () => {
        const { fetchImpl, requests } = capturingFetch(insertBody)
        const result = await startAction(makeInput({ actionId: 'continue', fetchImpl }))
        expect(result.status).toBe('started')
        if (result.status !== 'started') {
            return
        }
        await result.run.settled
        expect(result.run.kind).toBe('insert-at')
        expect(result.run.target).toEqual({
            kind: 'insert-at',
            position: SELECTION.to,
            docHash: result.run.snapshot.hash
        })
        expect(result.run.getState().outcome?.text).toBe(' More prose.')
        const userMessage =
            (requests[0]?.body['messages'] as { content: string }[])[0]?.content ?? ''
        expect(userMessage).toContain(
            `<text-before-insertion-point>\n${DOC_TEXT.slice(0, SELECTION.to)}\n</text-before-insertion-point>`
        )
        expect(userMessage).toContain(getBuiltInVerb('continue')?.instruction ?? '!!missing')
    })

    it('accepts a caret anchor (from === to)', async () => {
        const snapshot = makeSnapshot()
        const result = await startAction(
            makeInput({
                actionId: 'say-more',
                snapshot,
                selection: { from: 16, to: 16, capturedHash: snapshot.hash },
                fetchImpl: capturingFetch(insertBody).fetchImpl
            })
        )
        expect(result.status).toBe('started')
        if (result.status !== 'started') {
            return
        }
        expect(result.run.target).toMatchObject({ kind: 'insert-at', position: 16 })
    })

    it('appends at the end of the note when no anchor was captured', async () => {
        const input = makeInput({
            actionId: 'continue',
            fetchImpl: capturingFetch(insertBody).fetchImpl
        })
        const { selection: _dropped, ...rest } = input
        const result = await startAction(rest)
        expect(result.status).toBe('started')
        if (result.status !== 'started') {
            return
        }
        expect(result.run.target).toMatchObject({
            kind: 'insert-at',
            position: DOC_TEXT.length
        })
    })

    it('refuses a stale generate anchor instead of guessing', async () => {
        const result = await startAction(
            makeInput({
                actionId: 'continue',
                selection: { from: 5, to: 5, capturedHash: 'stale-hash' }
            })
        )
        expect(result).toEqual({ status: 'selection-changed' })
    })
})

// ---------------------------------------------------------------------------
// Review-class delegation
// ---------------------------------------------------------------------------

describe('startAction review-class verbs', () => {
    const reviewBody = anthropicResultBody({
        kind: 'review',
        findings: [
            {
                quote: 'The selected middle part.',
                critique: 'Unsupported claim',
                severity: 'warning'
            }
        ],
        summary: 'Needs evidence'
    })

    it('runs the review pipeline with the verb instruction augmented onto the prompt', async () => {
        const { fetchImpl, requests } = capturingFetch(reviewBody)
        const result = await startAction(makeInput({ actionId: 'critique', fetchImpl }))
        expect(result.status).toBe('review')
        if (result.status !== 'review') {
            return
        }
        expect(result.review.status).toBe('started')
        if (result.review.status !== 'started') {
            return
        }
        await result.review.run.settled
        expect(result.review.run.getEditorState('editor-1')?.status).toBe('done')
        expect(result.review.run.findings.list()).toHaveLength(1)
        // The instruction rides the system prompt (ask-editor augmentation
        // seam), not the operation payload.
        const body = requests[0]?.body ?? {}
        expect(String(body['system'])).toContain(getBuiltInVerb('critique')?.instruction ?? '!!')
        expect(String(body['system'])).toContain('<user-instruction>')
    })

    it('scopes the review to a non-degenerate selection', async () => {
        const { fetchImpl, requests } = capturingFetch(reviewBody)
        const result = await startAction(makeInput({ actionId: 'identify-assumptions', fetchImpl }))
        expect(result.status).toBe('review')
        if (result.status !== 'review') {
            return
        }
        expect(result.review.status).toBe('started')
        if (result.review.status !== 'started') {
            return
        }
        await result.review.run.settled
        const userMessage =
            (requests[0]?.body['messages'] as { content: string }[])[0]?.content ?? ''
        expect(userMessage).toContain('<selection>\nThe selected middle part.\n</selection>')
    })

    it('reviews the whole note when only a caret was captured', async () => {
        const snapshot = makeSnapshot()
        const { fetchImpl, requests } = capturingFetch(reviewBody)
        const result = await startAction(
            makeInput({
                actionId: 'find-evidence',
                snapshot,
                selection: { from: 3, to: 3, capturedHash: snapshot.hash },
                fetchImpl
            })
        )
        expect(result.status).toBe('review')
        if (result.status !== 'review') {
            return
        }
        expect(result.review.status).toBe('started')
        if (result.review.status !== 'started') {
            return
        }
        expect(result.review.selectionFallback).toBe(false)
        await result.review.run.settled
        const userMessage =
            (requests[0]?.body['messages'] as { content: string }[])[0]?.content ?? ''
        expect(userMessage).not.toContain('<selection>')
    })

    it('propagates review refusals (exclusion) unchanged', async () => {
        const result = await startAction(
            makeInput({
                actionId: 'critique',
                settings: makeSettings({ behavior: { excludedFolders: ['Notes'] } })
            })
        )
        expect(result.status).toBe('review')
        if (result.status !== 'review') {
            return
        }
        expect(result.review).toEqual({ status: 'excluded', notePath: 'Notes/Test.md' })
    })
})
