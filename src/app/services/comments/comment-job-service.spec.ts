import { clearTimeout as clearNodeTimer, setTimeout as setNodeTimer } from 'node:timers'
import { describe, expect, it } from 'bun:test'
import { marginCommentSchema } from '../../domain/comments/margin-comment'
import type { MarginComment } from '../../domain/comments/margin-comment'
import {
    apiBackendSchema,
    editorConfigSchema,
    pluginSettingsSchema
} from '../../domain/settings/settings-schema'
import type {
    ApiBackend,
    EditorConfig,
    PluginSettingsV1
} from '../../domain/settings/settings-schema'
import type { NoteMetadata, VaultReader } from '../context/vault-reader.intf'
import { BackgroundRequestGate } from '../orchestration/background-gate'
import { CommentRunController } from '../orchestration/comment-run'
import { Semaphore } from '../orchestration/semaphore'
import { CommentJobRegistry } from './comment-job-registry'
import { retryCommentJob, startCommentJob } from './comment-job-service'
import type { CommentJobStart } from './comment-job-service'
import { MarginCommentRepository } from './comment-repository'
import type { CommentStorageAdapter } from './comment-repository'

const API_KEY = 'sk-comment-secret-3'
const NOTE = 'Notes/Test.md'
const DOC = 'Intro paragraph. The claim under review. Closing words.'
const SPAN = { from: 17, to: 40 } // 'The claim under review.'

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
        name: 'Fact Checker',
        color: 'var(--color-blue)',
        prompt: { text: 'Verify claims.', notePaths: [], followLinks: false },
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
    readonly metadata = new Map<string, NoteMetadata>()

    readNote(): Promise<string | null> {
        return Promise.resolve(null)
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
    getNoteTypeIds(): readonly string[] {
        return []
    }
}

class MemoryStorage implements CommentStorageAdapter {
    readonly files = new Map<string, string>()
    read(path: string): Promise<string | null> {
        return Promise.resolve(this.files.get(path) ?? null)
    }
    write(path: string, data: string): Promise<void> {
        this.files.set(path, data)
        return Promise.resolve()
    }
    exists(path: string): Promise<boolean> {
        return Promise.resolve(this.files.has(path))
    }
    rename(): Promise<void> {
        return Promise.resolve()
    }
    remove(): Promise<void> {
        return Promise.resolve()
    }
}

/** Anthropic-shaped SSE stream carrying one schema-valid review result. */
function anthropicResultBody(): string {
    const frames = [
        {
            type: 'content_block_start',
            index: 0,
            content_block: { type: 'tool_use', name: 'emit_result', input: {} }
        },
        {
            type: 'content_block_delta',
            index: 0,
            delta: {
                type: 'input_json_delta',
                partial_json: JSON.stringify({
                    kind: 'review',
                    findings: [],
                    summary: 'The claim is supported.'
                })
            }
        },
        { type: 'message_stop' }
    ]
    return frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join('')
}

function capturingFetch(): { fetchImpl: typeof fetch; bodies: Record<string, unknown>[] } {
    const bodies: Record<string, unknown>[] = []
    const fetchImpl = ((_url: string, init?: RequestInit) => {
        bodies.push(
            JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as Record<string, unknown>
        )
        return Promise.resolve(new Response(anthropicResultBody(), { status: 200 }))
    }) as unknown as typeof fetch
    return { fetchImpl, bodies }
}

interface Harness {
    registry: CommentJobRegistry
    repository: MarginCommentRepository
    vault: FakeVault
}

function setup(): Harness {
    const repository = new MarginCommentRepository({
        storage: new MemoryStorage(),
        storePath: 'plugins/editor-ai-daemons/comments.json',
        setTimer: () => 0,
        clearTimer: () => undefined,
        saveDelayMs: 10_000
    })
    const gate = new BackgroundRequestGate({
        gate: new Semaphore(() => Number.POSITIVE_INFINITY),
        getLimit: () => Number.POSITIVE_INFINITY,
        setTimer: (callback, ms) => Number(setNodeTimer(callback, ms)),
        clearTimer: (handle) => {
            clearNodeTimer(handle)
        },
        pollIntervalMs: 1
    })
    const registry = new CommentJobRegistry({
        repository,
        runs: new CommentRunController(gate),
        now: () => 1_000,
        setTicker: () => 1,
        clearTicker: () => undefined
    })
    return { registry, repository, vault: new FakeVault() }
}

function settle(): Promise<void> {
    return Bun.sleep(10)
}

function baseInput(harness: Harness, overrides: Record<string, unknown> = {}) {
    const { fetchImpl } = capturingFetch()
    return {
        settings: makeSettings(),
        vault: harness.vault,
        registry: harness.registry,
        notePath: NOTE,
        noteText: DOC,
        selection: SPAN,
        instruction: 'Is this supported?',
        editorId: 'editor-1',
        makeId: () => 'comment-1',
        now: () => 1_000,
        fetchImpl,
        ...overrides
    }
}

describe('starting a background comment job', () => {
    it('records the comment, dispatches it, and lands the answer durably', async () => {
        const harness = setup()
        const { fetchImpl, bodies } = capturingFetch()
        const result = await startCommentJob(baseInput(harness, { fetchImpl }))
        expect(result.status).toEqual('started')
        await settle()
        const stored = harness.repository.listFor(NOTE)[0]
        expect(stored?.status).toEqual('done')
        expect(stored?.reply).toEqual('The claim is supported.')
        // The question rides on the system prompt as the per-run instruction.
        const rawSystem: unknown = bodies[0]?.['system']
        const system = typeof rawSystem === 'string' ? rawSystem : ''
        expect(system).toContain('The claim under review.')
        expect(system).toContain('Is this supported?')
    })

    it('persists locating hints and no offsets (Business Rules #13)', async () => {
        const harness = setup()
        await startCommentJob(baseInput(harness))
        const stored = harness.repository.listFor(NOTE)[0]
        expect(stored?.quote).toEqual('The claim under review.')
        expect(stored?.prefix).toEqual('Intro paragraph. ')
        expect(stored?.occurrence).toEqual(0)
        expect(Object.keys(stored ?? {})).not.toContain('from')
        await settle()
    })

    it('denormalizes the editor name so the margin can name a deleted editor', async () => {
        const harness = setup()
        await startCommentJob(baseInput(harness))
        expect(harness.repository.listFor(NOTE)[0]?.editorName).toEqual('Fact Checker')
        await settle()
    })
})

describe('the gate chain, in order', () => {
    it('refuses an excluded note before anything is read (Business Rules #7)', async () => {
        const harness = setup()
        harness.vault.metadata.set(NOTE, { tags: ['#private'], frontmatter: {} })
        const settings = makeSettings({
            behavior: { excludedTags: ['private'] }
        })
        const result = await startCommentJob(baseInput(harness, { settings }))
        expect(result).toEqual({ status: 'excluded', notePath: NOTE })
        expect(harness.repository.listFor(NOTE)).toHaveLength(0)
    })

    it('refuses a note a binding rule switched the plugin off for', async () => {
        const harness = setup()
        const settings = makeSettings({
            rules: [
                {
                    id: 'rule-1',
                    name: 'No AI here',
                    match: { matchType: 'folder', value: 'Notes' },
                    effect: 'disabled'
                }
            ]
        })
        const result = await startCommentJob(baseInput(harness, { settings }))
        expect(result.status).toEqual('rule-disabled')
        expect(harness.repository.listFor(NOTE)).toHaveLength(0)
    })

    it('asks for confirmation on an oversized note before recording anything', async () => {
        const harness = setup()
        const settings = makeSettings({ behavior: { sizeWarningWords: 100 } })
        // Comfortably over the smallest configurable threshold.
        const longDoc = `${DOC} ${'filler '.repeat(150)}`
        const result = await startCommentJob(baseInput(harness, { settings, noteText: longDoc }))
        expect(result.status).toEqual('needs-confirmation')
        expect(harness.repository.listFor(NOTE)).toHaveLength(0)
        const confirmed = await startCommentJob(
            baseInput(harness, { settings, noteText: longDoc, confirmedLargeNote: true })
        )
        expect(confirmed.status).toEqual('started')
        await settle()
    })

    it('reports a disabled or missing editor as a typed skip', async () => {
        const harness = setup()
        const disabled = await startCommentJob(
            baseInput(harness, {
                settings: makeSettings({ editors: [makeEditor({ enabled: false })] })
            })
        )
        expect(disabled).toMatchObject({
            status: 'no-editor',
            skip: { reason: 'editor-disabled' }
        })
        const missing = await startCommentJob(
            baseInput(harness, { settings: makeSettings({ editors: [] }) })
        )
        expect(missing).toEqual({ status: 'no-editor', skip: null })
        expect(harness.repository.listFor(NOTE)).toHaveLength(0)
    })

    it('reports an editor without the review capability', async () => {
        const harness = setup()
        const result = await startCommentJob(
            baseInput(harness, {
                settings: makeSettings({
                    editors: [makeEditor({ capabilities: { review: false, rewrite: true } })]
                })
            })
        )
        expect(result).toMatchObject({ skip: { reason: 'no-review-capability' } })
    })

    it('refuses an empty span or an empty question instead of parking nothing', async () => {
        const harness = setup()
        expect(
            (await startCommentJob(baseInput(harness, { selection: { from: 5, to: 5 } }))).status
        ).toEqual('invalid-span')
        expect((await startCommentJob(baseInput(harness, { instruction: '   ' }))).status).toEqual(
            'invalid-span'
        )
    })
})

describe('retrying an interrupted comment', () => {
    function interrupted(overrides: Partial<MarginComment> = {}): MarginComment {
        return marginCommentSchema.parse({
            id: 'comment-1',
            quote: 'The claim under review.',
            prefix: 'Intro paragraph. ',
            suffix: ' Closing words.',
            occurrence: 0,
            instruction: 'Is this supported?',
            editorId: 'editor-1',
            editorName: 'Fact Checker',
            status: 'interrupted',
            createdAt: 1,
            updatedAt: 2,
            ...overrides
        })
    }

    function retryInput(harness: Harness, overrides: Record<string, unknown> = {}) {
        const { fetchImpl } = capturingFetch()
        return {
            settings: makeSettings(),
            vault: harness.vault,
            registry: harness.registry,
            notePath: NOTE,
            noteText: DOC,
            commentId: 'comment-1',
            now: () => 2_000,
            fetchImpl,
            ...overrides
        }
    }

    it('dispatches a brand-new request rather than resuming anything', async () => {
        const harness = setup()
        harness.repository.upsert(NOTE, interrupted())
        const result = await retryCommentJob(retryInput(harness))
        expect(result.status).toEqual('started')
        await settle()
        const stored = harness.repository.listFor(NOTE)[0]
        expect(stored?.status).toEqual('done')
        expect(stored?.reply).toEqual('The claim is supported.')
    })

    it('re-anchors the span against the live note before asking again', async () => {
        const harness = setup()
        harness.repository.upsert(NOTE, interrupted())
        const edited = `New opening. ${DOC}`
        const { fetchImpl, bodies } = capturingFetch()
        const result = await retryCommentJob(retryInput(harness, { noteText: edited, fetchImpl }))
        expect(result.status).toEqual('started')
        await settle()
        const stored = harness.repository.listFor(NOTE)[0]
        // Hints were recomputed against the edited note.
        expect(stored?.prefix).toEqual('New opening. Intro paragraph. ')
        // ...and the request was scoped to the span where it now lives.
        expect(bodies[0]?.['messages']).toBeDefined()
    })

    it('refuses when the span the question was about is gone', async () => {
        const harness = setup()
        harness.repository.upsert(NOTE, interrupted())
        const result = await retryCommentJob(
            retryInput(harness, { noteText: 'Something else entirely.' })
        )
        expect(result).toEqual({ status: 'orphaned' })
        // The comment is KEPT, still interrupted, still retryable later.
        expect(harness.repository.listFor(NOTE)[0]?.status).toEqual('interrupted')
    })

    it('refuses to retry a comment that already has an answer', async () => {
        const harness = setup()
        harness.repository.upsert(NOTE, interrupted({ status: 'done' }))
        expect((await retryCommentJob(retryInput(harness))).status).toEqual('not-retryable')
    })

    it('refuses to retry a comment that is not there', async () => {
        const harness = setup()
        expect((await retryCommentJob(retryInput(harness))).status).toEqual('unknown-comment')
    })

    it('leaves the stored status untouched when a gate refuses the retry', async () => {
        // The mirror of the start-path gate specs above: a refusal must not
        // move the durable record. A comment stranded in `submitted` offers no
        // Retry, cancels nothing, and has lost its failure message — a dead
        // end until the next restart normalizes it to `interrupted`.
        const cases: {
            name: CommentJobStart['status']
            overrides: Record<string, unknown>
        }[] = [
            {
                name: 'excluded',
                overrides: {
                    settings: makeSettings({ behavior: { excludedTags: ['private'] } }),
                    excludeNote: true
                }
            },
            {
                name: 'rule-disabled',
                overrides: {
                    settings: makeSettings({
                        rules: [
                            {
                                id: 'rule-1',
                                name: 'No AI here',
                                match: { matchType: 'folder', value: 'Notes' },
                                effect: 'disabled'
                            }
                        ]
                    })
                }
            },
            {
                name: 'needs-confirmation',
                overrides: {
                    settings: makeSettings({ behavior: { sizeWarningWords: 100 } }),
                    noteText: `${DOC} ${'filler '.repeat(150)}`
                }
            },
            {
                name: 'no-editor',
                overrides: { settings: makeSettings({ editors: [makeEditor({ enabled: false })] }) }
            }
        ]
        for (const testCase of cases) {
            const harness = setup()
            harness.repository.upsert(NOTE, interrupted({ status: 'failed', error: 'boom' }))
            const { excludeNote, ...overrides } = testCase.overrides
            if (excludeNote === true) {
                harness.vault.metadata.set(NOTE, { tags: ['#private'], frontmatter: {} })
            }
            const result = await retryCommentJob(retryInput(harness, overrides))
            expect(result.status).toEqual(testCase.name)
            const stored = harness.repository.listFor(NOTE)[0]
            expect(stored?.status).toEqual('failed')
            expect(stored?.error).toEqual('boom')
        }
    })

    it('re-asks with the re-anchored hints once every gate has passed', async () => {
        const harness = setup()
        harness.repository.upsert(NOTE, interrupted({ status: 'failed', error: 'boom' }))
        const result = await retryCommentJob(retryInput(harness))
        expect(result.status).toEqual('started')
        // The restart cleared the failure and the hints came from the live note.
        const stored = harness.repository.listFor(NOTE)[0]
        expect(stored?.error).toBeUndefined()
        expect(stored?.quote).toEqual('The claim under review.')
        await settle()
    })

    it('still honours the exclusion gate on a retry', async () => {
        const harness = setup()
        harness.repository.upsert(NOTE, interrupted())
        harness.vault.metadata.set(NOTE, { tags: ['#private'], frontmatter: {} })
        const result = await retryCommentJob(
            retryInput(harness, {
                settings: makeSettings({ behavior: { excludedTags: ['private'] } })
            })
        )
        expect(result).toEqual({ status: 'excluded', notePath: NOTE })
    })
})
