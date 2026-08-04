import { describe, expect, it } from 'bun:test'
import type { FetchFn } from './backends/resolve-fetch'
import {
    apiBackendSchema,
    editorConfigSchema,
    pluginSettingsSchema
} from '../domain/settings/settings-schema'
import type { ApiBackend, EditorConfig, PluginSettingsV1 } from '../domain/settings/settings-schema'
import { createSnapshot } from '../domain/snapshot'
import { previewEditorContext } from './context-preview-service'
import type { NoteMetadata, VaultReader } from './context/vault-reader.intf'
import { RunController } from './orchestration/run-controller'
import { startReview } from './review-service'

const API_KEY = 'sk-preview-secret-1'
const NOTE_PATH = 'Articles/Draft.md'
const NOTE_TEXT = 'Hello world. This draft needs work.'

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
        prompt: { text: 'Be harsh.', notePaths: ['Meta/Persona.md'] },
        ...overrides
    })
}

function makeSettings(overrides: Record<string, unknown> = {}): PluginSettingsV1 {
    return pluginSettingsSchema.parse({
        backends: [makeBackend()],
        defaultBackend: { backendId: 'backend-1', model: '' },
        editors: [makeEditor()],
        voiceProfile: { text: 'Write plainly.', notePaths: [], followLinks: false },
        ...overrides
    })
}

class FakeVault implements VaultReader {
    readonly notes = new Map<string, string>([
        [NOTE_PATH, NOTE_TEXT],
        ['Meta/Persona.md', 'Never praise.']
    ])
    readonly metadata = new Map<string, NoteMetadata>()
    readonly links = new Map<string, string[]>()

    async readNote(path: string): Promise<string | null> {
        return this.notes.get(path) ?? null
    }

    resolveLink(): string | null {
        return null
    }

    getOutgoingLinks(path: string): string[] {
        return [...(this.links.get(path) ?? [])]
    }

    getNoteMetadata(path: string): NoteMetadata | null {
        return this.metadata.get(path) ?? { tags: [], frontmatter: {} }
    }

    getNoteTypeIds(): readonly string[] {
        return []
    }
}

/**
 * Captures the system prompt of the request a real review dispatch sends. The
 * response body is irrelevant — the assertion is about what went OUT.
 */
function capturingFetch(sink: { prompt: string | null }): FetchFn {
    return ((_url: string, init?: RequestInit) => {
        const raw = typeof init?.body === 'string' ? init.body : '{}'
        const body = JSON.parse(raw) as Record<string, unknown>
        sink.prompt = typeof body['system'] === 'string' ? body['system'] : null
        return Promise.resolve(new Response('data: {"type":"message_stop"}\n\n', { status: 200 }))
    }) as unknown as FetchFn
}

describe('previewEditorContext', () => {
    it('returns the prompt, the sections and the resolved backend', async () => {
        const result = await previewEditorContext({
            editor: makeEditor(),
            settings: makeSettings(),
            vault: new FakeVault(),
            notePath: NOTE_PATH,
            noteText: NOTE_TEXT
        })
        expect(result.status).toBe('ready')
        if (result.status !== 'ready') {
            return
        }
        expect(result.preview.editorName).toBe('Hater')
        expect(result.preview.notePath).toBe(NOTE_PATH)
        expect(result.preview.systemPrompt).toContain('Write plainly.')
        expect(result.preview.systemPrompt).toContain('Be harsh.')
        expect(result.preview.systemPrompt).toContain(
            '<context-note role="prompt-ref" path="Meta/Persona.md">'
        )
        expect(result.preview.sections.map((s) => s.kind)).toEqual([
            'system-prompt',
            'reviewed-note',
            'prompt-ref'
        ])
        expect(result.preview.backendLabel).toBe('Claude (claude-test-1)')
        expect(result.preview.backendIssue).toBeNull()
    })

    it('reads the note from the vault when the caller has no live buffer', async () => {
        const result = await previewEditorContext({
            editor: makeEditor(),
            settings: makeSettings(),
            vault: new FakeVault(),
            notePath: NOTE_PATH
        })
        expect(result.status).toBe('ready')
        if (result.status !== 'ready') {
            return
        }
        const note = result.preview.sections.find((s) => s.kind === 'reviewed-note')
        expect(note?.sourceChars).toBe(NOTE_TEXT.length)
    })

    it('reports an unreadable note instead of previewing an empty one', async () => {
        const result = await previewEditorContext({
            editor: makeEditor(),
            settings: makeSettings(),
            vault: new FakeVault(),
            notePath: 'Gone.md'
        })
        expect(result).toEqual({ status: 'note-unreadable', notePath: 'Gone.md' })
    })

    it('refuses an excluded note (Business Rules #7) instead of showing its text', async () => {
        const vault = new FakeVault()
        vault.metadata.set(NOTE_PATH, { tags: ['secret'], frontmatter: {} })
        const result = await previewEditorContext({
            editor: makeEditor(),
            settings: makeSettings({ behavior: { excludedTags: ['secret'] } }),
            vault,
            notePath: NOTE_PATH,
            noteText: NOTE_TEXT
        })
        expect(result).toEqual({ status: 'excluded', notePath: NOTE_PATH })
    })

    it('refuses a rule-disabled note and names the rule (plan §4b)', async () => {
        const settings = makeSettings({
            rules: [
                {
                    id: 'rule-1',
                    name: 'No AI here',
                    match: { matchType: 'folder', value: 'Articles' },
                    effect: 'disabled',
                    defaultTarget: null
                }
            ]
        })
        const result = await previewEditorContext({
            editor: makeEditor(),
            settings,
            vault: new FakeVault(),
            notePath: NOTE_PATH,
            noteText: NOTE_TEXT
        })
        expect(result).toEqual({
            status: 'rule-disabled',
            notePath: NOTE_PATH,
            ruleLabel: 'No AI here'
        })
    })

    it('names the blocking reason when the editor has no usable backend', async () => {
        const result = await previewEditorContext({
            editor: makeEditor(),
            settings: makeSettings({
                backends: [makeBackend({ enabled: false })]
            }),
            vault: new FakeVault(),
            notePath: NOTE_PATH,
            noteText: NOTE_TEXT
        })
        expect(result.status).toBe('ready')
        if (result.status !== 'ready') {
            return
        }
        // The prompt is still shown: the user asked what would be sent, and
        // "nothing, because the backend is off" is the honest answer to give
        // alongside it, not instead of it.
        expect(result.preview.systemPrompt.length).toBeGreaterThan(0)
        expect(result.preview.backendLabel).toBeNull()
        expect(result.preview.backendIssue).toBe('backend-disabled')
    })

    it('previews the editor VALUE it is given, not the one in settings', async () => {
        // The settings dialog previews an unsaved draft; this is that contract.
        const draft = makeEditor({
            name: 'Draft persona',
            prompt: { text: 'UNSAVED', notePaths: [] }
        })
        const result = await previewEditorContext({
            editor: draft,
            settings: makeSettings(),
            vault: new FakeVault(),
            notePath: NOTE_PATH,
            noteText: NOTE_TEXT
        })
        expect(result.status).toBe('ready')
        if (result.status !== 'ready') {
            return
        }
        expect(result.preview.systemPrompt).toContain('UNSAVED')
        expect(result.preview.systemPrompt).not.toContain('Be harsh.')
    })
})

describe('preview assembly equals dispatch assembly', () => {
    it('shows byte-for-byte the system prompt a review actually sends', async () => {
        const settings = makeSettings()
        const vault = new FakeVault()
        const sink: { prompt: string | null } = { prompt: null }

        const preview = await previewEditorContext({
            editor: settings.editors[0]!,
            settings,
            vault,
            notePath: NOTE_PATH,
            noteText: NOTE_TEXT
        })

        const started = await startReview({
            settings,
            snapshot: createSnapshot({ filePath: NOTE_PATH, text: NOTE_TEXT }),
            vault,
            runController: new RunController(() => 4),
            fetchImpl: capturingFetch(sink)
        })
        expect(started.status).toBe('started')
        if (started.status === 'started') {
            await started.run.settled
        }

        expect(preview.status).toBe('ready')
        if (preview.status !== 'ready') {
            return
        }
        expect(sink.prompt).not.toBeNull()
        expect(preview.preview.systemPrompt).toBe(sink.prompt ?? '')
    })

    it('accounts for the panel charter a binding rule brings with it', async () => {
        // The charter inlines whole vault notes into every member's prompt.
        // A preview that resolved the rule (it does) but dropped the charter
        // would under-report what leaves the vault by up to 10 000 characters.
        const vault = new FakeVault()
        vault.notes.set('Meta/Charter.md', 'Weigh the reader first.')
        const settings = makeSettings({
            panels: [
                {
                    id: 'p-1',
                    name: 'Pre-publish review',
                    memberEditorIds: ['editor-1'],
                    charter: {
                        text: 'Rank by what blocks publication.',
                        notePaths: ['Meta/Charter.md']
                    }
                }
            ],
            rules: [
                {
                    id: 'r-1',
                    match: { matchType: 'folder', value: '/' },
                    effect: 'assign',
                    defaultTarget: { targetType: 'panel', targetId: 'p-1' }
                }
            ]
        })
        const sink: { prompt: string | null } = { prompt: null }

        const preview = await previewEditorContext({
            editor: settings.editors[0]!,
            settings,
            vault,
            notePath: NOTE_PATH,
            noteText: NOTE_TEXT
        })

        const started = await startReview({
            settings,
            snapshot: createSnapshot({ filePath: NOTE_PATH, text: NOTE_TEXT }),
            vault,
            runController: new RunController(() => 4),
            fetchImpl: capturingFetch(sink)
        })
        if (started.status === 'started') {
            await started.run.settled
        }

        expect(preview.status).toBe('ready')
        if (preview.status !== 'ready') {
            return
        }
        expect(preview.preview.panelCharter?.panelName).toBe('Pre-publish review')
        expect(preview.preview.panelCharter?.text).toContain('Weigh the reader first.')
        expect(preview.preview.systemPrompt).toContain('<charter-note path="Meta/Charter.md">')
        expect(preview.preview.systemPrompt).toBe(sink.prompt ?? '')
    })

    it('has no charter to account for when the rule\u2019s panel is disabled', async () => {
        const settings = makeSettings({
            panels: [
                {
                    id: 'p-1',
                    name: 'Off',
                    memberEditorIds: ['editor-1'],
                    enabled: false,
                    charter: { text: 'Never sent.', notePaths: [] }
                }
            ],
            rules: [
                {
                    id: 'r-1',
                    match: { matchType: 'folder', value: '/' },
                    effect: 'assign',
                    defaultTarget: { targetType: 'panel', targetId: 'p-1' }
                }
            ]
        })
        const preview = await previewEditorContext({
            editor: settings.editors[0]!,
            settings,
            vault: new FakeVault(),
            notePath: NOTE_PATH,
            noteText: NOTE_TEXT
        })
        expect(preview.status).toBe('ready')
        if (preview.status !== 'ready') {
            return
        }
        expect(preview.preview.panelCharter).toBeNull()
        expect(preview.preview.systemPrompt).not.toContain('Never sent.')
    })
})

describe('previewing a bound action', () => {
    const customAction = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
        id: 'action-1',
        actionId: 'action-1',
        customName: 'Check the numbers',
        customVerbClass: 'review',
        customInstruction: {
            text: 'Flag every unsupported number.',
            notePaths: ['Meta/Numbers.md'],
            followLinks: false
        },
        binding: { targetType: 'editor', targetId: 'editor-1' },
        ...overrides
    })

    it('shows the instruction notes a custom action inlines, which no other surface does', async () => {
        const settings = makeSettings({ actions: [customAction()] })
        const vault = new FakeVault()
        vault.notes.set('Meta/Numbers.md', 'Numbers must cite a source.')

        const plain = await previewEditorContext({
            editor: settings.editors[0]!,
            settings,
            vault,
            notePath: NOTE_PATH,
            noteText: NOTE_TEXT
        })
        const withAction = await previewEditorContext({
            editor: settings.editors[0]!,
            settings,
            vault,
            notePath: NOTE_PATH,
            noteText: NOTE_TEXT,
            actionBindingId: 'action-1'
        })
        expect(plain.status).toBe('ready')
        expect(withAction.status).toBe('ready')
        if (plain.status !== 'ready' || withAction.status !== 'ready') {
            return
        }
        expect(plain.preview.instruction).toBeNull()
        // The referenced note's content is exactly what the old preview hid.
        expect(plain.preview.systemPrompt).not.toContain('Numbers must cite a source.')
        expect(withAction.preview.instruction).toMatchObject({
            label: 'Check the numbers',
            verbClass: 'review',
            inSystemPrompt: true
        })
        expect(withAction.preview.instruction?.text).toContain('Numbers must cite a source.')
        expect(withAction.preview.systemPrompt).toContain('Numbers must cite a source.')
    })

    it('keeps a transform instruction OUT of the system prompt, and says so', async () => {
        const settings = makeSettings({
            actions: [customAction({ customVerbClass: 'transform' })]
        })
        const vault = new FakeVault()
        vault.notes.set('Meta/Numbers.md', 'Numbers must cite a source.')
        const result = await previewEditorContext({
            editor: settings.editors[0]!,
            settings,
            vault,
            notePath: NOTE_PATH,
            noteText: NOTE_TEXT,
            actionBindingId: 'action-1'
        })
        expect(result.status).toBe('ready')
        if (result.status !== 'ready') {
            return
        }
        // It still LEAVES the vault — it rides the operation payload — so it is
        // reported, just not as part of the prompt.
        expect(result.preview.instruction).toMatchObject({ inSystemPrompt: false })
        expect(result.preview.instruction?.text).toContain('Numbers must cite a source.')
        expect(result.preview.systemPrompt).not.toContain('Numbers must cite a source.')
    })

    it('never inlines an excluded instruction note (Business Rules #7)', async () => {
        const settings = makeSettings({
            actions: [customAction()],
            behavior: { excludedFolders: ['Meta'] }
        })
        const vault = new FakeVault()
        vault.notes.set('Meta/Numbers.md', 'Numbers must cite a source.')
        const result = await previewEditorContext({
            editor: settings.editors[0]!,
            settings,
            vault,
            notePath: NOTE_PATH,
            noteText: NOTE_TEXT,
            actionBindingId: 'action-1'
        })
        expect(result.status).toBe('ready')
        if (result.status !== 'ready') {
            return
        }
        expect(result.preview.instruction?.text).not.toContain('Numbers must cite a source.')
    })

    it('refuses an action that no longer resolves, like the dispatch does', async () => {
        const settings = makeSettings({ actions: [customAction()] })
        const vault = new FakeVault()
        const gone = await previewEditorContext({
            editor: settings.editors[0]!,
            settings,
            vault,
            notePath: NOTE_PATH,
            noteText: NOTE_TEXT,
            actionBindingId: 'action-does-not-exist'
        })
        expect(gone).toEqual({ status: 'action-unavailable', label: 'This action' })

        // Every referenced note missing and no direct text: nothing to send.
        const empty = makeSettings({
            actions: [
                customAction({
                    customInstruction: {
                        text: '',
                        notePaths: ['Meta/Gone.md'],
                        followLinks: false
                    }
                })
            ]
        })
        const emptied = await previewEditorContext({
            editor: empty.editors[0]!,
            settings: empty,
            vault,
            notePath: NOTE_PATH,
            noteText: NOTE_TEXT,
            actionBindingId: 'action-1'
        })
        expect(emptied).toEqual({
            status: 'action-unavailable',
            label: 'Check the numbers'
        })
    })
})
