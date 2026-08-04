import { describe, expect, it } from 'bun:test'
import type { FetchFn } from './backends/resolve-fetch'
import type { FindingId } from '../domain/ids'
import { rawFindingSchema } from '../domain/operations/contract'
import {
    apiBackendSchema,
    editorConfigSchema,
    pluginSettingsSchema
} from '../domain/settings/settings-schema'
import type { ApiBackend, EditorConfig, PluginSettingsV1 } from '../domain/settings/settings-schema'
import { createSnapshot } from '../domain/snapshot'
import type { NoteMetadata, VaultReader } from './context/vault-reader.intf'
import { RunController } from './orchestration/run-controller'
import type { RunHandle } from './orchestration/run-controller'
import { startThreadTurn } from './thread-service'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const API_KEY = 'sk-thread-secret-9'
const NOTE_PATH = 'Notes/Test.md'
const DOC_TEXT = 'The quick brown fox jumps over the lazy dog'

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
        name: 'Devil’s Advocate',
        color: 'var(--color-red)',
        prompt: { text: 'Argue against the text.', notePaths: [], followLinks: false },
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
    readonly noteTypeIds = new Map<string, readonly string[]>()

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

    getNoteTypeIds(path: string): readonly string[] {
        return this.noteTypeIds.get(path) ?? []
    }
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

function capturingFetch(body: string): { fetchImpl: FetchFn; requests: CapturedRequest[] } {
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
    }) as unknown as FetchFn
    return { fetchImpl, requests }
}

/**
 * A settled review run holding one anchored finding on "quick brown"
 * ([4, 15) in `DOC_TEXT`), produced by `editor-1`.
 */
async function runWithFinding(
    controller: RunController,
    editorId = 'editor-1'
): Promise<{ run: RunHandle; findingId: FindingId }> {
    const run = controller.startRun({
        snapshot: createSnapshot({ filePath: NOTE_PATH, text: DOC_TEXT }),
        editors: [
            {
                editorId,
                editorName: 'Devil’s Advocate',
                execute: async function* (request) {
                    yield {
                        type: 'result',
                        runId: request.runId,
                        result: {
                            kind: 'review',
                            findings: [
                                rawFindingSchema.parse({
                                    quote: 'quick brown',
                                    critique: 'Too generic',
                                    suggestion: 'swift auburn'
                                })
                            ]
                        }
                    }
                }
            }
        ]
    })
    await run.settled
    const findingId = run.findings.list()[0]?.id
    if (!findingId) {
        throw new Error('fixture produced no finding')
    }
    return { run, findingId }
}

// ---------------------------------------------------------------------------
// Specs
// ---------------------------------------------------------------------------

describe('startThreadTurn dispatch', () => {
    it('sends the live span text and the persona prompt to the finding’s editor', async () => {
        const controller = new RunController()
        const { run, findingId } = await runWithFinding(controller)
        const { fetchImpl, requests } = capturingFetch(
            anthropicResultBody({
                kind: 'thread-turn',
                reply: 'Still reads as filler',
                concede: false
            })
        )
        // The user edited the span since the review: [4, 15) now reads
        // 'QUICK BROWN' — the turn must discuss that, not the stale quote.
        const currentText = 'The QUICK BROWN fox jumps over the lazy dog'

        const start = await startThreadTurn({
            settings: makeSettings(),
            vault: new FakeVault(),
            runController: controller,
            findingId,
            message: 'I disagree — this repetition is intentional',
            currentText,
            fetchImpl
        })
        expect(start.status).toEqual('started')
        if (start.status !== 'started') {
            return
        }
        expect(await start.settled).toEqual({
            status: 'held',
            reply: 'Still reads as filler',
            revised: false
        })

        expect(requests).toHaveLength(1)
        const body = requests[0]?.body ?? {}
        expect(String(body['system'])).toContain('Argue against the text.')
        const messages = body['messages'] as Array<{ content: string }>
        const userMessage = messages[0]?.content ?? ''
        expect(userMessage).toContain('QUICK BROWN')
        expect(userMessage).toContain('Too generic')
        expect(userMessage).toContain('I disagree — this repetition is intentional')
        // The note text never rides along in a thread turn.
        expect(userMessage).not.toContain('jumps over the lazy dog')

        // The exchange landed on the finding.
        expect(run.findings.get(findingId)?.thread).toEqual([
            { role: 'user', content: 'I disagree — this repetition is intentional' },
            { role: 'editor', content: 'Still reads as filler' }
        ])
    })

    it('applies a concede as a dismissal of the finding', async () => {
        const controller = new RunController()
        const { run, findingId } = await runWithFinding(controller)
        const { fetchImpl } = capturingFetch(
            anthropicResultBody({
                kind: 'thread-turn',
                reply: 'You are right, withdrawing it',
                concede: true
            })
        )
        const start = await startThreadTurn({
            settings: makeSettings(),
            vault: new FakeVault(),
            runController: controller,
            findingId,
            message: 'it is deliberate',
            currentText: DOC_TEXT,
            fetchImpl
        })
        if (start.status !== 'started') {
            throw new Error(`expected started, got ${start.status}`)
        }
        expect(await start.settled).toEqual({
            status: 'conceded',
            reply: 'You are right, withdrawing it'
        })
        expect(run.findings.get(findingId)?.status).toEqual('dismissed')
        expect(run.findings.get(findingId)?.conceded).toBeTrue()
    })

    it('redacts the API key from a backend failure', async () => {
        const controller = new RunController()
        const { run, findingId } = await runWithFinding(controller)
        const fetchImpl = (() =>
            Promise.resolve(
                new Response(`{"error":"bad key ${API_KEY}"}`, { status: 401 })
            )) as unknown as FetchFn
        const start = await startThreadTurn({
            settings: makeSettings(),
            vault: new FakeVault(),
            runController: controller,
            findingId,
            message: 'push',
            currentText: DOC_TEXT,
            fetchImpl
        })
        if (start.status !== 'started') {
            throw new Error(`expected started, got ${start.status}`)
        }
        const resolution = await start.settled
        expect(resolution.status).toEqual('failed')
        if (resolution.status === 'failed') {
            expect(resolution.reason).not.toContain(API_KEY)
        }
        const turn = run.findings.get(findingId)?.threadTurn
        expect(turn?.status).toEqual('failed')
        expect(turn?.message).toEqual('push')
        if (turn?.status === 'failed') {
            expect(turn.reason).not.toContain(API_KEY)
        }
    })
})

describe('startThreadTurn refusals', () => {
    it('refuses when no run tracks the finding', async () => {
        const controller = new RunController()
        expect(
            await startThreadTurn({
                settings: makeSettings(),
                vault: new FakeVault(),
                runController: controller,
                findingId: 'nope' as FindingId,
                message: 'push',
                currentText: DOC_TEXT
            })
        ).toEqual({ status: 'no-run' })
    })

    it('refuses when the run is detached while the context is assembled', async () => {
        const controller = new RunController()
        const { run, findingId } = await runWithFinding(controller)
        const { fetchImpl, requests } = capturingFetch(
            anthropicResultBody({ kind: 'thread-turn', reply: 'late', concede: false })
        )
        const pending = startThreadTurn({
            settings: makeSettings(),
            vault: new FakeVault(),
            runController: controller,
            findingId,
            message: 'push',
            currentText: DOC_TEXT,
            fetchImpl
        })
        // The note is renamed/deleted (or the review restarted) while the
        // persona context is being read: the handle is detached, so the turn
        // must not open a stream nobody can cancel.
        controller.discardRun(NOTE_PATH)
        expect(await pending).toEqual({ status: 'no-run' })
        expect(requests).toHaveLength(0)
        expect(run.findings.get(findingId)?.threadTurn).toBeNull()
    })

    it('fails closed on an excluded note before any backend call', async () => {
        const controller = new RunController()
        const { findingId } = await runWithFinding(controller)
        let calls = 0
        const fetchImpl = (() => {
            calls += 1
            return Promise.resolve(new Response('{}', { status: 200 }))
        }) as unknown as FetchFn
        const vault = new FakeVault()
        vault.metadata.set(NOTE_PATH, { tags: ['private'], frontmatter: {} })
        const start = await startThreadTurn({
            settings: makeSettings({ behavior: { excludedTags: ['private'] } }),
            vault,
            runController: controller,
            findingId,
            message: 'push',
            currentText: DOC_TEXT,
            fetchImpl
        })
        expect(start).toEqual({ status: 'excluded', notePath: NOTE_PATH })
        expect(calls).toEqual(0)
    })

    it('refuses when a binding rule added after the review disables the note', async () => {
        const controller = new RunController()
        const { findingId } = await runWithFinding(controller)
        let calls = 0
        const fetchImpl = (() => {
            calls += 1
            return Promise.resolve(new Response('{}', { status: 200 }))
        }) as unknown as FetchFn
        const start = await startThreadTurn({
            settings: makeSettings({
                rules: [
                    {
                        id: 'r1',
                        name: 'Hands off',
                        match: { matchType: 'folder', value: '/' },
                        effect: 'disabled'
                    }
                ]
            }),
            vault: new FakeVault(),
            runController: controller,
            findingId,
            message: 'push',
            currentText: DOC_TEXT,
            fetchImpl
        })
        expect(start).toEqual({
            status: 'rule-disabled',
            notePath: NOTE_PATH,
            ruleLabel: 'Hands off'
        })
        expect(calls).toEqual(0)
    })

    it('reports why the finding’s editor cannot answer', async () => {
        const controller = new RunController()
        const { findingId } = await runWithFinding(controller)
        const base = { vault: new FakeVault(), runController: controller, findingId }

        expect(
            await startThreadTurn({
                ...base,
                settings: makeSettings({ editors: [makeEditor({ enabled: false })] }),
                message: 'push',
                currentText: DOC_TEXT
            })
        ).toEqual({
            status: 'no-editor',
            skip: {
                editorId: 'editor-1',
                editorName: 'Devil’s Advocate',
                reason: 'editor-disabled'
            }
        })

        expect(
            await startThreadTurn({
                ...base,
                settings: makeSettings({
                    editors: [
                        makeEditor({
                            capabilities: { review: false, rewrite: true, research: false }
                        })
                    ]
                }),
                message: 'push',
                currentText: DOC_TEXT
            })
        ).toEqual({
            status: 'no-editor',
            skip: {
                editorId: 'editor-1',
                editorName: 'Devil’s Advocate',
                reason: 'no-review-capability'
            }
        })

        expect(
            await startThreadTurn({
                ...base,
                settings: makeSettings({ backends: [], defaultBackend: null }),
                message: 'push',
                currentText: DOC_TEXT
            })
        ).toEqual({
            status: 'no-editor',
            skip: {
                editorId: 'editor-1',
                editorName: 'Devil’s Advocate',
                reason: 'no-backend-configured'
            }
        })
    })

    it('surfaces store refusals (blank message, turn in flight)', async () => {
        const controller = new RunController()
        const { run, findingId } = await runWithFinding(controller)
        expect(
            await startThreadTurn({
                settings: makeSettings(),
                vault: new FakeVault(),
                runController: controller,
                findingId,
                message: '   ',
                currentText: DOC_TEXT
            })
        ).toEqual({ status: 'refused', reason: 'blank-message' })

        run.findings.beginThreadTurn(findingId, 'already going')
        expect(
            await startThreadTurn({
                settings: makeSettings(),
                vault: new FakeVault(),
                runController: controller,
                findingId,
                message: 'second',
                currentText: DOC_TEXT
            })
        ).toEqual({ status: 'refused', reason: 'in-flight' })
    })
})
