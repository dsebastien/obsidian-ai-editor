import { describe, expect, it } from 'bun:test'
import type { FetchFn } from '../backends/resolve-fetch'
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
import { Semaphore } from '../orchestration/semaphore'
import { distillEditorMemory } from './memory-distiller'
import { MemoryJournal } from './memory-journal'
import type { MemoryJournalEventInput } from './memory-journal'

// ---------------------------------------------------------------------------
// Fixtures (thread-service.spec.ts pattern: real executor, fake transport)
// ---------------------------------------------------------------------------

const NOTE_PATH = 'Notes/Test.md'
const MEMORY_NOTE_PATH = 'Meta/Concision memory.md'

function makeBackend(overrides: Partial<ApiBackend> = {}): ApiBackend {
    return apiBackendSchema.parse({
        id: 'backend-1',
        family: 'api',
        kind: 'anthropic',
        label: 'Claude',
        apiKey: 'sk-distill-secret',
        defaultModel: 'claude-test-1',
        ...overrides
    })
}

function makeEditor(overrides: Record<string, unknown> = {}): EditorConfig {
    return editorConfigSchema.parse({
        id: 'editor-1',
        name: 'Concision',
        prompt: { text: 'You are a ruthless concision editor.', notePaths: [], followLinks: false },
        memory: 'settings',
        memoryText: 'Old rule: avoid adverbs.',
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
    /**
     * Paths whose metadata resolves to `null`, like the real
     * `ObsidianVaultReader` answers for a MISSING file or a cold cache. The
     * blanket empty-metadata default below is a fixture convenience for
     * journal-event notes; tests exercising the fail-closed null branch opt
     * in per path.
     */
    readonly nullMetadataPaths = new Set<string>()

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
        if (this.nullMetadataPaths.has(path)) {
            return null
        }
        return this.metadata.get(path) ?? { tags: [], frontmatter: {} }
    }

    getNoteTypeIds(): readonly string[] {
        return []
    }
}

function journalWith(...events: Partial<MemoryJournalEventInput>[]): MemoryJournal {
    const journal = new MemoryJournal()
    for (const event of events) {
        journal.record({
            editorId: 'editor-1',
            notePath: NOTE_PATH,
            quote: 'quick brown',
            critique: 'Too generic',
            severity: 'suggestion',
            decision: 'rejected',
            thread: [],
            ...event
        })
    }
    return journal
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

function userMessageOf(request: CapturedRequest | undefined): string {
    const messages = (request?.body['messages'] ?? []) as Array<{ content: string }>
    return messages[0]?.content ?? ''
}

interface DistillOverrides {
    settings?: PluginSettingsV1
    vault?: FakeVault
    journal?: MemoryJournal
    editorId?: string
    fetchImpl?: FetchFn
    gate?: Semaphore
}

async function distill(overrides: DistillOverrides = {}): ReturnType<typeof distillEditorMemory> {
    return distillEditorMemory({
        settings: overrides.settings ?? makeSettings(),
        vault: overrides.vault ?? new FakeVault(),
        journal: overrides.journal ?? journalWith({}),
        requestGate: overrides.gate ?? new Semaphore(() => 1),
        editorId: overrides.editorId ?? 'editor-1',
        signal: new AbortController().signal,
        ...(overrides.fetchImpl ? { fetchImpl: overrides.fetchImpl } : {})
    })
}

// ---------------------------------------------------------------------------
// Specs
// ---------------------------------------------------------------------------

describe('distillEditorMemory — success', () => {
    it('sends current settings-memory + events and returns the proposed memory', async () => {
        const { fetchImpl, requests } = capturingFetch(
            anthropicResultBody({ kind: 'distill-memory', memory: 'New rule: keep adverbs out.' })
        )
        const journal = journalWith(
            { decision: 'accepted' },
            {
                decision: 'conceded',
                critique: 'Passive voice',
                thread: [
                    { role: 'user', content: 'This passive is deliberate' },
                    { role: 'editor', content: 'Conceded, withdrawing' }
                ]
            }
        )
        const outcome = await distill({ journal, fetchImpl })
        expect(outcome).toEqual({
            status: 'distilled',
            editor: makeEditor(),
            previousMemory: 'Old rule: avoid adverbs.',
            proposedMemory: 'New rule: keep adverbs out.',
            eventCount: 2,
            droppedEvents: 0,
            // Newest snapshotted seq — what the save path clears up to.
            snapshotSeq: 2
        })

        expect(requests).toHaveLength(1)
        const body = requests[0]?.body ?? {}
        // Persona-addressed system prompt: the distiller preamble + the
        // editor's DIRECT persona text — no voice profile, no note context.
        expect(String(body['system'])).toContain('learning memory')
        expect(String(body['system'])).toContain('You are a ruthless concision editor.')
        const message = userMessageOf(requests[0])
        expect(message).toContain('<current-memory>\nOld rule: avoid adverbs.\n</current-memory>')
        expect(message).toContain('<decision>\naccepted\n</decision>')
        expect(message).toContain('<decision>\nconceded\n</decision>')
        expect(message).toContain('This passive is deliberate')
        expect(message).toContain('"kind" set to "distill-memory"')

        // The journal is NOT cleared here — only a confirmed save clears it.
        expect(journal.countFor('editor-1')).toEqual(2)
    })

    it('sends "(empty)" for a blank current memory', async () => {
        const { fetchImpl, requests } = capturingFetch(
            anthropicResultBody({ kind: 'distill-memory', memory: 'First rules.' })
        )
        const settings = makeSettings({ editors: [makeEditor({ memoryText: '' })] })
        const outcome = await distill({ settings, fetchImpl })
        expect(outcome.status).toEqual('distilled')
        expect(userMessageOf(requests[0])).toContain('<current-memory>\n(empty)\n</current-memory>')
    })

    it('releases the shared request gate afterwards', async () => {
        const { fetchImpl } = capturingFetch(
            anthropicResultBody({ kind: 'distill-memory', memory: 'Rules.' })
        )
        const gate = new Semaphore(() => 1)
        await distill({ fetchImpl, gate })
        expect(gate.activeCount()).toEqual(0)
        expect(gate.queuedCount()).toEqual(0)
    })
})

describe('distillEditorMemory — note-mode current memory', () => {
    it('reads the memory note body with frontmatter stripped', async () => {
        const { fetchImpl, requests } = capturingFetch(
            anthropicResultBody({ kind: 'distill-memory', memory: 'Rewritten.' })
        )
        const vault = new FakeVault()
        vault.notes.set(MEMORY_NOTE_PATH, '---\ntags: [ai]\n---\nNote-stored rule.\n')
        const settings = makeSettings({
            editors: [makeEditor({ memory: 'note', memoryNotePath: MEMORY_NOTE_PATH })]
        })
        const outcome = await distill({ settings, vault, fetchImpl })
        expect(outcome.status).toEqual('distilled')
        if (outcome.status === 'distilled') {
            expect(outcome.previousMemory).toEqual('Note-stored rule.\n')
        }
        const message = userMessageOf(requests[0])
        expect(message).toContain('Note-stored rule.')
        expect(message).not.toContain('tags: [ai]')
    })

    it('treats a missing memory note as empty current memory', async () => {
        const { fetchImpl, requests } = capturingFetch(
            anthropicResultBody({ kind: 'distill-memory', memory: 'First rules.' })
        )
        const settings = makeSettings({
            editors: [makeEditor({ memory: 'note', memoryNotePath: MEMORY_NOTE_PATH })]
        })
        const outcome = await distill({ settings, fetchImpl })
        expect(outcome.status).toEqual('distilled')
        expect(userMessageOf(requests[0])).toContain('<current-memory>\n(empty)\n</current-memory>')
    })

    it('a NEVER-created memory note distills under default settings despite null metadata', async () => {
        // Regression (adversarial review 2026-08-07): the real vault reader
        // answers null metadata for a missing file, and the default
        // `respectFrontmatterOptOut: true` made the fail-closed exclusion
        // branch swallow the documented create-on-save flow entirely.
        const { fetchImpl, requests } = capturingFetch(
            anthropicResultBody({ kind: 'distill-memory', memory: 'First rules.' })
        )
        const vault = new FakeVault()
        vault.nullMetadataPaths.add(MEMORY_NOTE_PATH)
        const settings = makeSettings({
            editors: [makeEditor({ memory: 'note', memoryNotePath: MEMORY_NOTE_PATH })]
        })
        expect(settings.behavior.respectFrontmatterOptOut).toBeTrue()
        const outcome = await distill({ settings, vault, fetchImpl })
        expect(outcome.status).toEqual('distilled')
        expect(userMessageOf(requests[0])).toContain('<current-memory>\n(empty)\n</current-memory>')
    })

    it('a missing memory note under an excluded FOLDER still refuses (path checks survive)', async () => {
        const vault = new FakeVault()
        vault.nullMetadataPaths.add(MEMORY_NOTE_PATH)
        const settings = makeSettings({
            behavior: { excludedFolders: ['Meta'] },
            editors: [makeEditor({ memory: 'note', memoryNotePath: MEMORY_NOTE_PATH })]
        })
        const outcome = await distill({
            settings,
            vault,
            fetchImpl: (() => {
                throw new Error('must not dispatch')
            }) as unknown as FetchFn
        })
        expect(outcome).toEqual({ status: 'memory-note-excluded', notePath: MEMORY_NOTE_PATH })
    })

    it('an EXISTING memory note with unresolved metadata still fails closed (cold cache)', async () => {
        const vault = new FakeVault()
        vault.notes.set(MEMORY_NOTE_PATH, 'Might carry a #private tag.')
        vault.nullMetadataPaths.add(MEMORY_NOTE_PATH)
        const settings = makeSettings({
            editors: [makeEditor({ memory: 'note', memoryNotePath: MEMORY_NOTE_PATH })]
        })
        const outcome = await distill({
            settings,
            vault,
            fetchImpl: (() => {
                throw new Error('must not dispatch')
            }) as unknown as FetchFn
        })
        expect(outcome).toEqual({ status: 'memory-note-excluded', notePath: MEMORY_NOTE_PATH })
    })

    it('refuses a traversal path before any vault access', async () => {
        const settings = makeSettings({
            editors: [makeEditor({ memory: 'note', memoryNotePath: '../outside' })]
        })
        expect(await distill({ settings })).toEqual({
            status: 'invalid-memory-note-path',
            notePath: '../outside'
        })
    })

    it('refuses an absolute path before any vault access', async () => {
        const settings = makeSettings({
            editors: [makeEditor({ memory: 'note', memoryNotePath: '/etc/passwd' })]
        })
        expect(await distill({ settings })).toEqual({
            status: 'invalid-memory-note-path',
            notePath: '/etc/passwd'
        })
    })

    it('refuses when the memory note is excluded (BR #7 — its content would be sent)', async () => {
        const vault = new FakeVault()
        vault.notes.set(MEMORY_NOTE_PATH, 'Secret rules.')
        vault.metadata.set(MEMORY_NOTE_PATH, { tags: ['private'], frontmatter: {} })
        const settings = makeSettings({
            behavior: { excludedTags: ['private'] },
            editors: [makeEditor({ memory: 'note', memoryNotePath: MEMORY_NOTE_PATH })]
        })
        const outcome = await distill({
            settings,
            vault,
            fetchImpl: (() => {
                throw new Error('must not dispatch')
            }) as unknown as FetchFn
        })
        expect(outcome).toEqual({ status: 'memory-note-excluded', notePath: MEMORY_NOTE_PATH })
    })

    it('refuses note mode without a configured note path', async () => {
        const settings = makeSettings({
            editors: [makeEditor({ memory: 'note', memoryNotePath: '' })]
        })
        expect(await distill({ settings })).toEqual({ status: 'no-memory-note-path' })
    })

    it('normalizes a stray-space, extension-less path to the real .md note', async () => {
        const { fetchImpl } = capturingFetch(
            anthropicResultBody({ kind: 'distill-memory', memory: 'Rewritten.' })
        )
        const vault = new FakeVault()
        vault.notes.set(MEMORY_NOTE_PATH, 'Note-stored rule.\n')
        const settings = makeSettings({
            editors: [makeEditor({ memory: 'note', memoryNotePath: ' Meta/Concision memory ' })]
        })
        const outcome = await distill({ settings, vault, fetchImpl })
        expect(outcome.status).toEqual('distilled')
        if (outcome.status === 'distilled') {
            expect(outcome.previousMemory).toEqual('Note-stored rule.\n')
        }
    })

    it('a whitespace-only path is no path at all', async () => {
        const settings = makeSettings({
            editors: [makeEditor({ memory: 'note', memoryNotePath: '   ' })]
        })
        expect(await distill({ settings })).toEqual({ status: 'no-memory-note-path' })
    })
})

describe('distillEditorMemory — event filtering (BR #7 at consume time)', () => {
    it('drops events whose note is NOW excluded and reports the drop', async () => {
        const { fetchImpl, requests } = capturingFetch(
            anthropicResultBody({ kind: 'distill-memory', memory: 'Rules.' })
        )
        const vault = new FakeVault()
        vault.metadata.set('Private/Diary.md', { tags: ['private'], frontmatter: {} })
        const settings = makeSettings({ behavior: { excludedTags: ['private'] } })
        const journal = journalWith(
            { notePath: 'Private/Diary.md', critique: 'Secret critique' },
            { critique: 'Public critique' }
        )
        const outcome = await distill({ settings, vault, journal, fetchImpl })
        expect(outcome.status).toEqual('distilled')
        if (outcome.status === 'distilled') {
            expect(outcome.eventCount).toEqual(1)
            expect(outcome.droppedEvents).toEqual(1)
            // The snapshot covers dropped events too: they were CONSIDERED,
            // so a confirmed save may clear them.
            expect(outcome.snapshotSeq).toEqual(2)
        }
        const message = userMessageOf(requests[0])
        expect(message).toContain('Public critique')
        expect(message).not.toContain('Secret critique')
    })

    it('drops events on rule-disabled notes (plan §4b kill switch)', async () => {
        const settings = makeSettings({
            rules: [
                {
                    id: 'r1',
                    name: 'No AI here',
                    match: { matchType: 'folder', value: 'Vetoed' },
                    effect: 'disabled'
                }
            ]
        })
        const journal = journalWith({ notePath: 'Vetoed/Note.md' })
        const outcome = await distill({ settings, journal })
        expect(outcome).toEqual({ status: 'nothing-to-distill', droppedEvents: 1 })
    })

    it('returns nothing-to-distill when every event is on an excluded note', async () => {
        const settings = makeSettings({ behavior: { excludedFolders: ['Notes'] } })
        const outcome = await distill({ settings, journal: journalWith({}, {}) })
        expect(outcome).toEqual({ status: 'nothing-to-distill', droppedEvents: 2 })
    })

    it('returns nothing-to-distill for an empty journal', async () => {
        expect(await distill({ journal: new MemoryJournal() })).toEqual({
            status: 'nothing-to-distill',
            droppedEvents: 0
        })
    })
})

describe('distillEditorMemory — editor and backend refusals', () => {
    it('refuses an unknown editor id', async () => {
        expect(await distill({ editorId: 'ghost' })).toEqual({ status: 'no-editor', skip: null })
    })

    it('refuses a disabled editor', async () => {
        const settings = makeSettings({ editors: [makeEditor({ enabled: false })] })
        expect(await distill({ settings })).toEqual({
            status: 'no-editor',
            skip: { editorId: 'editor-1', editorName: 'Concision', reason: 'editor-disabled' }
        })
    })

    it('refuses an editor whose memory is off', async () => {
        const settings = makeSettings({ editors: [makeEditor({ memory: 'off' })] })
        expect(await distill({ settings })).toEqual({ status: 'memory-off' })
    })

    it('refuses when no backend resolves (typed EditorSkip vocabulary)', async () => {
        const settings = makeSettings({ defaultBackend: null })
        expect(await distill({ settings })).toEqual({
            status: 'no-editor',
            skip: {
                editorId: 'editor-1',
                editorName: 'Concision',
                reason: 'no-backend-configured'
            }
        })
    })
})

describe('distillEditorMemory — failure keeps the signal', () => {
    it('returns failed on an invalid result and does NOT clear the journal', async () => {
        // The memory ceiling is a hard reject: >50k characters fails the
        // contract, and the auto-retry (1 retry on invalid-output) receives
        // the same payload again.
        const { fetchImpl } = capturingFetch(
            anthropicResultBody({ kind: 'distill-memory', memory: 'x'.repeat(50_001) })
        )
        const journal = journalWith({})
        const outcome = await distill({ journal, fetchImpl })
        expect(outcome.status).toEqual('failed')
        expect(journal.countFor('editor-1')).toEqual(1)
    })

    it('redacts the API key from failure messages (BR #12)', async () => {
        const fetchImpl = (() =>
            Promise.resolve(
                new Response('key sk-distill-secret rejected', { status: 401 })
            )) as unknown as FetchFn
        const outcome = await distill({ fetchImpl })
        expect(outcome.status).toEqual('failed')
        if (outcome.status === 'failed') {
            expect(outcome.message).not.toContain('sk-distill-secret')
        }
    })
})
