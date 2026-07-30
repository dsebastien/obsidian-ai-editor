import { describe, expect, test } from 'bun:test'
import {
    behaviorSettingsSchema,
    editorConfigSchema,
    promptSourceSchema,
    type BehaviorSettings,
    type EditorConfig,
    type PromptSource
} from '../../domain/settings/settings-schema'
import { ExcludedTargetError, FOLLOWED_LINKS_CAP, assembleContext } from './context-assembler'
import type { NoteMetadata, VaultReader } from './vault-reader.intf'

interface FakeNote {
    readonly content: string
    readonly tags?: string[]
    readonly frontmatter?: Record<string, unknown>
    readonly links?: string[]
}

/**
 * In-memory VaultReader: notes keyed by vault path; wikilink targets resolve
 * by exact path or by `<target>.md` basename anywhere in the vault.
 */
class FakeVaultReader implements VaultReader {
    constructor(private readonly notes: ReadonlyMap<string, FakeNote>) {}

    readNote(path: string): Promise<string | null> {
        return Promise.resolve(this.notes.get(path)?.content ?? null)
    }

    resolveLink(linkText: string, _fromPath: string): string | null {
        if (this.notes.has(linkText)) {
            return linkText
        }
        for (const path of this.notes.keys()) {
            if (path === `${linkText}.md` || path.endsWith(`/${linkText}.md`)) {
                return path
            }
        }
        return null
    }

    getOutgoingLinks(path: string): string[] {
        return [...(this.notes.get(path)?.links ?? [])]
    }

    getNoteMetadata(path: string): NoteMetadata | null {
        const note = this.notes.get(path)
        if (!note) {
            return null
        }
        return { tags: note.tags ?? [], frontmatter: note.frontmatter ?? {} }
    }

    getNoteTypeIds(): readonly string[] {
        return [] // context assembly never consults binding rules
    }
}

/**
 * Builds a fake vault that always contains the reviewed note (with neutral
 * metadata) — an unresolvable target now fails closed as excluded. Tests
 * override the `NOTE_PATH` entry when they need target-specific tags/links.
 */
function vaultOf(entries: Record<string, FakeNote>): FakeVaultReader {
    return new FakeVaultReader(
        new Map(Object.entries({ [NOTE_PATH]: { content: 'body' }, ...entries }))
    )
}

function editor(overrides: Record<string, unknown> = {}): EditorConfig {
    return editorConfigSchema.parse({ id: 'ed-1', name: 'Concision Editor', ...overrides })
}

function behavior(overrides: Record<string, unknown> = {}): BehaviorSettings {
    return behaviorSettingsSchema.parse(overrides)
}

function voice(overrides: Record<string, unknown> = {}): PromptSource {
    return promptSourceSchema.parse(overrides)
}

const NOTE_PATH = 'Articles/Draft.md'

describe('assembleContext — system prompt', () => {
    test('orders voice profile → persona text → memory text', async () => {
        const result = await assembleContext({
            editor: editor({
                prompt: { text: 'PERSONA', notePaths: [] },
                memory: 'settings',
                memoryText: 'MEMORY'
            }),
            voiceProfile: voice({ text: 'VOICE' }),
            behavior: behavior(),
            vault: vaultOf({}),
            notePath: NOTE_PATH,
            noteText: 'body'
        })
        expect(result.systemPrompt).toBe('VOICE\n\nPERSONA\n\nMEMORY')
    })

    test('omits voice profile when the editor opts out', async () => {
        const result = await assembleContext({
            editor: editor({
                injectVoiceProfile: false,
                prompt: { text: 'PERSONA', notePaths: [] }
            }),
            voiceProfile: voice({ text: 'VOICE', notePaths: ['Voice.md'] }),
            behavior: behavior(),
            vault: vaultOf({ 'Voice.md': { content: 'voice note' } }),
            notePath: NOTE_PATH,
            noteText: ''
        })
        expect(result.systemPrompt).toBe('PERSONA')
        expect(result.attachments).toEqual([])
    })

    test('omits memory text unless memory mode is settings', async () => {
        const result = await assembleContext({
            editor: editor({ prompt: { text: 'PERSONA', notePaths: [] }, memoryText: 'MEMORY' }),
            voiceProfile: voice(),
            behavior: behavior(),
            vault: vaultOf({}),
            notePath: NOTE_PATH,
            noteText: ''
        })
        expect(result.systemPrompt).toBe('PERSONA')
    })
})

describe('assembleContext — attachments and ordering', () => {
    test('attaches prompt refs (voice → persona → memory note), then wikilinks, then linked notes', async () => {
        const vault = vaultOf({
            'Voice.md': { content: 'v' },
            'Persona.md': { content: 'p' },
            'Memory.md': { content: 'm' },
            'Wiki.md': { content: 'w' },
            'Linked.md': { content: 'l' },
            [NOTE_PATH]: { content: 'body', links: ['Linked.md'] }
        })
        const result = await assembleContext({
            editor: editor({
                prompt: { text: 'See [[Wiki]]', notePaths: ['Persona.md'] },
                memory: 'note',
                memoryNotePath: 'Memory.md',
                includeLinkedNotes: true
            }),
            voiceProfile: voice({ notePaths: ['Voice.md'] }),
            behavior: behavior(),
            vault,
            notePath: NOTE_PATH,
            noteText: 'body'
        })
        expect(result.attachments).toEqual([
            { path: 'Voice.md', content: 'v', reason: 'prompt-ref' },
            { path: 'Persona.md', content: 'p', reason: 'prompt-ref' },
            { path: 'Memory.md', content: 'm', reason: 'prompt-ref' },
            { path: 'Wiki.md', content: 'w', reason: 'wikilink-ref' },
            { path: 'Linked.md', content: 'l', reason: 'linked-note' }
        ])
        expect(result.truncated).toEqual([])
    })

    test('every attachment is listed in the preview with its char count', async () => {
        const vault = vaultOf({
            'Persona.md': { content: '12345' },
            [NOTE_PATH]: { content: 'body', links: [] }
        })
        const result = await assembleContext({
            editor: editor({ prompt: { text: 'P', notePaths: ['Persona.md'] } }),
            voiceProfile: voice(),
            behavior: behavior(),
            vault,
            notePath: NOTE_PATH,
            noteText: 'body'
        })
        expect(result.preview).toEqual([{ path: 'Persona.md', chars: 5, reason: 'prompt-ref' }])
    })

    test('resolves wikilinks from voice and memory text fields too', async () => {
        const vault = vaultOf({
            'VoiceRef.md': { content: 'vr' },
            'MemRef.md': { content: 'mr' }
        })
        const result = await assembleContext({
            editor: editor({
                prompt: { text: 'no links', notePaths: [] },
                memory: 'settings',
                memoryText: 'remember [[MemRef]]'
            }),
            voiceProfile: voice({ text: 'style like [[VoiceRef]]' }),
            behavior: behavior(),
            vault,
            notePath: NOTE_PATH,
            noteText: ''
        })
        expect(result.attachments.map((a) => a.path)).toEqual(['VoiceRef.md', 'MemRef.md'])
        expect(result.attachments.every((a) => a.reason === 'wikilink-ref')).toBe(true)
    })

    test('skips missing notes and unresolvable wikilinks gracefully', async () => {
        const result = await assembleContext({
            editor: editor({
                prompt: { text: 'see [[Nowhere]]', notePaths: ['Ghost.md'] },
                includeLinkedNotes: true
            }),
            voiceProfile: voice(),
            behavior: behavior(),
            vault: vaultOf({ [NOTE_PATH]: { content: 'body', links: ['Gone.md'] } }),
            notePath: NOTE_PATH,
            noteText: 'body'
        })
        expect(result.attachments).toEqual([])
        expect(result.truncated).toEqual([])
    })
})

describe('assembleContext — follow links (PromptSource.followLinks)', () => {
    test('attaches the notes linked from a referenced note when the source opts in', async () => {
        const vault = vaultOf({
            'Voice.md': { content: 'v', links: ['Style.md', 'Identity.md'] },
            'Style.md': { content: 's' },
            'Identity.md': { content: 'i' }
        })
        const result = await assembleContext({
            editor: editor(),
            voiceProfile: voice({ notePaths: ['Voice.md'], followLinks: true }),
            behavior: behavior(),
            vault,
            notePath: NOTE_PATH,
            noteText: 'body'
        })
        expect(result.attachments).toEqual([
            { path: 'Voice.md', content: 'v', reason: 'prompt-ref' },
            { path: 'Style.md', content: 's', reason: 'followed-link' },
            { path: 'Identity.md', content: 'i', reason: 'followed-link' }
        ])
    })

    test('does not follow links when the source leaves followLinks off (default)', async () => {
        const vault = vaultOf({
            'Persona.md': { content: 'p', links: ['Extra.md'] },
            'Extra.md': { content: 'e' }
        })
        const result = await assembleContext({
            editor: editor({ prompt: { text: 'P', notePaths: ['Persona.md'] } }),
            voiceProfile: voice(),
            behavior: behavior(),
            vault,
            notePath: NOTE_PATH,
            noteText: 'body'
        })
        expect(result.attachments.map((a) => a.path)).toEqual(['Persona.md'])
    })

    test('follows notes referenced via wikilinks in the source text too (extraction reuse)', async () => {
        const vault = vaultOf({
            'Voice.md': { content: 'v', links: ['Linked.md'] },
            'Linked.md': { content: 'l' }
        })
        const result = await assembleContext({
            editor: editor(),
            voiceProfile: voice({ text: 'write like [[Voice]]', followLinks: true }),
            behavior: behavior(),
            vault,
            notePath: NOTE_PATH,
            noteText: 'body'
        })
        expect(result.attachments).toEqual([
            { path: 'Voice.md', content: 'v', reason: 'wikilink-ref' },
            { path: 'Linked.md', content: 'l', reason: 'followed-link' }
        ])
    })

    test('depth 1 only: links of followed notes are never followed', async () => {
        const vault = vaultOf({
            'Voice.md': { content: 'v', links: ['Depth1.md'] },
            'Depth1.md': { content: 'd1', links: ['Depth2.md'] },
            'Depth2.md': { content: 'd2' }
        })
        const result = await assembleContext({
            editor: editor(),
            voiceProfile: voice({ notePaths: ['Voice.md'], followLinks: true }),
            behavior: behavior(),
            vault,
            notePath: NOTE_PATH,
            noteText: 'body'
        })
        expect(result.attachments.map((a) => a.path)).toEqual(['Voice.md', 'Depth1.md'])
    })

    test('dedupes followed notes against already-included attachments and other roots', async () => {
        const vault = vaultOf({
            'Voice.md': { content: 'v', links: ['Persona.md', 'Shared.md'] },
            'Persona.md': { content: 'p', links: ['Shared.md', 'Voice.md'] },
            'Shared.md': { content: 's' }
        })
        const result = await assembleContext({
            editor: editor({
                prompt: { text: 'P', notePaths: ['Persona.md'], followLinks: true }
            }),
            voiceProfile: voice({ notePaths: ['Voice.md'], followLinks: true }),
            behavior: behavior(),
            vault,
            notePath: NOTE_PATH,
            noteText: 'body'
        })
        // Persona/Voice stay prompt-refs; Shared attaches exactly once.
        expect(result.attachments).toEqual([
            { path: 'Voice.md', content: 'v', reason: 'prompt-ref' },
            { path: 'Persona.md', content: 'p', reason: 'prompt-ref' },
            { path: 'Shared.md', content: 's', reason: 'followed-link' }
        ])
    })

    test('caps followed notes per referenced note, deterministically in link order', async () => {
        const links = Array.from({ length: FOLLOWED_LINKS_CAP + 3 }, (_, i) => `F${i}.md`)
        const entries: Record<string, FakeNote> = {
            'Voice.md': { content: 'v', links }
        }
        for (const link of links) {
            entries[link] = { content: 'x' }
        }
        const result = await assembleContext({
            editor: editor(),
            voiceProfile: voice({ notePaths: ['Voice.md'], followLinks: true }),
            behavior: behavior(),
            vault: vaultOf(entries),
            notePath: NOTE_PATH,
            noteText: 'body'
        })
        const followed = result.attachments.filter((a) => a.reason === 'followed-link')
        expect(followed.map((a) => a.path)).toEqual(links.slice(0, FOLLOWED_LINKS_CAP))
    })

    test('the cap applies per referenced note, not globally', async () => {
        const linksA = Array.from({ length: FOLLOWED_LINKS_CAP }, (_, i) => `A${i}.md`)
        const entries: Record<string, FakeNote> = {
            'VoiceA.md': { content: 'a', links: linksA },
            'VoiceB.md': { content: 'b', links: ['B0.md'] },
            'B0.md': { content: 'x' }
        }
        for (const link of linksA) {
            entries[link] = { content: 'x' }
        }
        const result = await assembleContext({
            editor: editor(),
            voiceProfile: voice({ notePaths: ['VoiceA.md', 'VoiceB.md'], followLinks: true }),
            behavior: behavior(),
            vault: vaultOf(entries),
            notePath: NOTE_PATH,
            noteText: 'body'
        })
        const followed = result.attachments.filter((a) => a.reason === 'followed-link')
        expect(followed.map((a) => a.path)).toEqual([...linksA, 'B0.md'])
    })

    test('followed notes are subject to the context budget (truncated and dropped)', async () => {
        const vault = vaultOf({
            'Voice.md': { content: 'v', links: ['Big.md', 'Late.md'] },
            'Big.md': { content: 'X'.repeat(2_000) },
            'Late.md': { content: 'late' }
        })
        const result = await assembleContext({
            editor: editor(),
            voiceProfile: voice({ notePaths: ['Voice.md'], followLinks: true }),
            behavior: behavior({ contextBudgetChars: 1_000 }),
            vault,
            notePath: NOTE_PATH,
            noteText: ''
        })
        // 1000 - 1 (Voice.md content 'v') = 999 chars remain for Big.md.
        const big = result.attachments.find((a) => a.path === 'Big.md')
        expect(big?.content).toBe('X'.repeat(999))
        expect(result.truncated).toEqual(['Big.md', 'Late.md'])
    })

    test('never follows links of an excluded referenced note', async () => {
        const vault = vaultOf({
            'Private/Voice.md': { content: 'v', links: ['Leak.md'] },
            'Leak.md': { content: 'leak' }
        })
        const result = await assembleContext({
            editor: editor(),
            voiceProfile: voice({ notePaths: ['Private/Voice.md'], followLinks: true }),
            behavior: behavior({ excludedFolders: ['Private'] }),
            vault,
            notePath: NOTE_PATH,
            noteText: 'body'
        })
        expect(result.attachments).toEqual([])
    })

    test('skips excluded followed notes, the reviewed note, and missing targets silently', async () => {
        const vault = vaultOf({
            'Voice.md': {
                content: 'v',
                links: ['Private/Diary.md', NOTE_PATH, 'Missing.md', 'Fine.md']
            },
            'Private/Diary.md': { content: 'secret' },
            'Fine.md': { content: 'fine' }
        })
        const result = await assembleContext({
            editor: editor(),
            voiceProfile: voice({ notePaths: ['Voice.md'], followLinks: true }),
            behavior: behavior({ excludedFolders: ['Private'] }),
            vault,
            notePath: NOTE_PATH,
            noteText: 'body'
        })
        expect(result.attachments.map((a) => a.path)).toEqual(['Voice.md', 'Fine.md'])
        expect(result.truncated).toEqual([])
    })

    test('a followLinks voice profile is ignored when the editor opts out of it', async () => {
        const vault = vaultOf({
            'Voice.md': { content: 'v', links: ['Linked.md'] },
            'Linked.md': { content: 'l' }
        })
        const result = await assembleContext({
            editor: editor({ injectVoiceProfile: false }),
            voiceProfile: voice({ notePaths: ['Voice.md'], followLinks: true }),
            behavior: behavior(),
            vault,
            notePath: NOTE_PATH,
            noteText: 'body'
        })
        expect(result.attachments).toEqual([])
    })

    test('the memory note is not a prompt source and is never followed', async () => {
        const vault = vaultOf({
            'Memory.md': { content: 'm', links: ['MemLinked.md'] },
            'MemLinked.md': { content: 'x' }
        })
        const result = await assembleContext({
            editor: editor({
                prompt: { text: 'P', notePaths: [], followLinks: true },
                memory: 'note',
                memoryNotePath: 'Memory.md'
            }),
            voiceProfile: voice({ followLinks: true }),
            behavior: behavior(),
            vault,
            notePath: NOTE_PATH,
            noteText: 'body'
        })
        expect(result.attachments.map((a) => a.path)).toEqual(['Memory.md'])
    })

    test('followed notes come before the reviewed note’s linked notes', async () => {
        const vault = vaultOf({
            'Voice.md': { content: 'v', links: ['Followed.md'] },
            'Followed.md': { content: 'f' },
            'TargetLink.md': { content: 't' },
            [NOTE_PATH]: { content: 'body', links: ['TargetLink.md'] }
        })
        const result = await assembleContext({
            editor: editor({ includeLinkedNotes: true }),
            voiceProfile: voice({ notePaths: ['Voice.md'], followLinks: true }),
            behavior: behavior(),
            vault,
            notePath: NOTE_PATH,
            noteText: 'body'
        })
        expect(result.attachments.map((a) => [a.path, a.reason])).toEqual([
            ['Voice.md', 'prompt-ref'],
            ['Followed.md', 'followed-link'],
            ['TargetLink.md', 'linked-note']
        ])
    })
})

describe('assembleContext — excluded review target (Business Rules #7)', () => {
    const baseInput = {
        editor: editor(),
        voiceProfile: voice(),
        noteText: 'body'
    }

    const rejectionOf = async (promise: Promise<unknown>): Promise<unknown> => {
        try {
            await promise
            return null
        } catch (cause) {
            return cause
        }
    }

    test('throws ExcludedTargetError for a folder-excluded target', async () => {
        const target = 'Private/Draft.md'
        const rejection = await rejectionOf(
            assembleContext({
                ...baseInput,
                behavior: behavior({ excludedFolders: ['Private'] }),
                vault: new FakeVaultReader(new Map([[target, { content: 'body' }]])),
                notePath: target
            })
        )
        expect(rejection).toBeInstanceOf(ExcludedTargetError)
    })

    test('throws ExcludedTargetError for a tag-excluded target', async () => {
        const rejection = await rejectionOf(
            assembleContext({
                ...baseInput,
                behavior: behavior({ excludedTags: ['secret'] }),
                vault: vaultOf({ [NOTE_PATH]: { content: 'body', tags: ['secret'] } }),
                notePath: NOTE_PATH
            })
        )
        expect(rejection).toBeInstanceOf(ExcludedTargetError)
    })

    test('throws ExcludedTargetError for a frontmatter-opted-out target', async () => {
        const rejection = await rejectionOf(
            assembleContext({
                ...baseInput,
                behavior: behavior(),
                vault: vaultOf({
                    [NOTE_PATH]: { content: 'body', frontmatter: { ai_editor: false } }
                }),
                notePath: NOTE_PATH
            })
        )
        expect(rejection).toBeInstanceOf(ExcludedTargetError)
    })

    test('fails closed when target metadata is unresolved and opt-out is respected', async () => {
        const rejection = await rejectionOf(
            assembleContext({
                ...baseInput,
                behavior: behavior(),
                vault: new FakeVaultReader(new Map()),
                notePath: NOTE_PATH
            })
        )
        expect(rejection).toBeInstanceOf(ExcludedTargetError)
    })
})

describe('assembleContext — exclusions (Business Rules #7)', () => {
    const excluding = behavior({ excludedFolders: ['Private'], excludedTags: ['secret'] })

    test('an explicitly wikilinked note that is excluded is never attached', async () => {
        const vault = vaultOf({
            'Private/Diary.md': { content: 'secret content' },
            'Public.md': { content: 'ok' }
        })
        const result = await assembleContext({
            editor: editor({ prompt: { text: '[[Private/Diary]] and [[Public]]', notePaths: [] } }),
            voiceProfile: voice(),
            behavior: excluding,
            vault,
            notePath: NOTE_PATH,
            noteText: ''
        })
        expect(result.attachments.map((a) => a.path)).toEqual(['Public.md'])
    })

    test('excluded notes are dropped from prompt refs and linked notes too', async () => {
        const vault = vaultOf({
            'Tagged.md': { content: 'tagged', tags: ['secret'] },
            'Flagged.md': { content: 'flagged', frontmatter: { ai_editor: false } },
            'Fine.md': { content: 'fine' },
            [NOTE_PATH]: { content: 'body', links: ['Flagged.md', 'Fine.md'] }
        })
        const result = await assembleContext({
            editor: editor({
                prompt: { text: 'P', notePaths: ['Tagged.md'] },
                includeLinkedNotes: true
            }),
            voiceProfile: voice(),
            behavior: excluding,
            vault,
            notePath: NOTE_PATH,
            noteText: 'body'
        })
        expect(result.attachments).toEqual([
            { path: 'Fine.md', content: 'fine', reason: 'linked-note' }
        ])
    })

    test('excluded linked notes do not consume the maxLinkedNotes cap', async () => {
        const vault = vaultOf({
            'Private/A.md': { content: 'a' },
            'B.md': { content: 'b' },
            'C.md': { content: 'c' },
            [NOTE_PATH]: { content: 'body', links: ['Private/A.md', 'B.md', 'C.md'] }
        })
        const result = await assembleContext({
            editor: editor({ includeLinkedNotes: true, maxLinkedNotes: 2 }),
            voiceProfile: voice(),
            behavior: excluding,
            vault,
            notePath: NOTE_PATH,
            noteText: 'body'
        })
        expect(result.attachments.map((a) => a.path)).toEqual(['B.md', 'C.md'])
    })
})

describe('assembleContext — budget', () => {
    test('truncates the attachment that crosses the budget and records it', async () => {
        const prompt = 'P'.repeat(100)
        const noteText = 'N'.repeat(100)
        const vault = vaultOf({
            'Big.md': { content: 'X'.repeat(2_000) }
        })
        const result = await assembleContext({
            editor: editor({ prompt: { text: prompt, notePaths: ['Big.md'] } }),
            voiceProfile: voice(),
            behavior: behavior({ contextBudgetChars: 1_000 }),
            vault,
            notePath: NOTE_PATH,
            noteText
        })
        // 1000 - 100 (prompt) - 100 (note) = 800 chars remain for attachments.
        const attached = result.attachments[0]
        expect(attached).toBeDefined()
        expect(attached?.content).toBe('X'.repeat(800))
        expect(result.truncated).toEqual(['Big.md'])
        expect(result.preview).toEqual([{ path: 'Big.md', chars: 800, reason: 'prompt-ref' }])
    })

    test('drops attachments entirely once the budget is exhausted', async () => {
        const vault = vaultOf({
            'First.md': { content: 'F'.repeat(2_000) },
            'Second.md': { content: 'S'.repeat(10) }
        })
        const result = await assembleContext({
            editor: editor({ prompt: { text: 'P', notePaths: ['First.md', 'Second.md'] } }),
            voiceProfile: voice(),
            behavior: behavior({ contextBudgetChars: 1_000 }),
            vault,
            notePath: NOTE_PATH,
            noteText: ''
        })
        expect(result.attachments.map((a) => a.path)).toEqual(['First.md'])
        expect(result.truncated).toEqual(['First.md', 'Second.md'])
        expect(result.preview.map((p) => p.path)).toEqual(['First.md'])
    })

    test('attaches nothing when prompt + note already exceed the budget', async () => {
        const vault = vaultOf({ 'Ref.md': { content: 'ref' } })
        const result = await assembleContext({
            editor: editor({ prompt: { text: 'P'.repeat(600), notePaths: ['Ref.md'] } }),
            voiceProfile: voice(),
            behavior: behavior({ contextBudgetChars: 1_000 }),
            vault,
            notePath: NOTE_PATH,
            noteText: 'N'.repeat(600)
        })
        expect(result.attachments).toEqual([])
        expect(result.truncated).toEqual(['Ref.md'])
    })

    test('fits attachments exactly at the boundary without truncation', async () => {
        const vault = vaultOf({ 'Exact.md': { content: 'E'.repeat(900) } })
        const result = await assembleContext({
            editor: editor({ prompt: { text: 'P'.repeat(100), notePaths: ['Exact.md'] } }),
            voiceProfile: voice(),
            behavior: behavior({ contextBudgetChars: 1_000 }),
            vault,
            notePath: NOTE_PATH,
            noteText: ''
        })
        expect(result.attachments[0]?.content.length).toBe(900)
        expect(result.truncated).toEqual([])
    })
})

describe('assembleContext — dedup and cycles', () => {
    test('never attaches the reviewed note itself, even via links or wikilinks', async () => {
        const vault = vaultOf({
            [NOTE_PATH]: { content: 'body', links: [NOTE_PATH] }
        })
        const result = await assembleContext({
            editor: editor({
                prompt: { text: `[[${NOTE_PATH}]]`, notePaths: [NOTE_PATH] },
                includeLinkedNotes: true
            }),
            voiceProfile: voice(),
            behavior: behavior(),
            vault,
            notePath: NOTE_PATH,
            noteText: 'body'
        })
        expect(result.attachments).toEqual([])
    })

    test('attaches each note once under its first reason', async () => {
        const vault = vaultOf({
            'Shared.md': { content: 's' },
            [NOTE_PATH]: { content: 'body', links: ['Shared.md', 'Shared.md'] }
        })
        const result = await assembleContext({
            editor: editor({
                prompt: { text: 'see [[Shared]]', notePaths: ['Shared.md'] },
                includeLinkedNotes: true
            }),
            voiceProfile: voice(),
            behavior: behavior(),
            vault,
            notePath: NOTE_PATH,
            noteText: 'body'
        })
        expect(result.attachments).toEqual([
            { path: 'Shared.md', content: 's', reason: 'prompt-ref' }
        ])
    })

    test('mutually-linking notes cause no loop (1 hop, deduplicated)', async () => {
        const vault = vaultOf({
            'A.md': { content: 'a', links: ['B.md', NOTE_PATH] },
            'B.md': { content: 'b', links: ['A.md'] },
            [NOTE_PATH]: { content: 'body', links: ['A.md', 'B.md'] }
        })
        const result = await assembleContext({
            editor: editor({ includeLinkedNotes: true }),
            voiceProfile: voice(),
            behavior: behavior(),
            vault,
            notePath: NOTE_PATH,
            noteText: 'body'
        })
        expect(result.attachments.map((a) => a.path)).toEqual(['A.md', 'B.md'])
    })

    test('caps linked notes at maxLinkedNotes', async () => {
        const vault = vaultOf({
            'L1.md': { content: '1' },
            'L2.md': { content: '2' },
            'L3.md': { content: '3' },
            [NOTE_PATH]: { content: 'body', links: ['L1.md', 'L2.md', 'L3.md'] }
        })
        const result = await assembleContext({
            editor: editor({ includeLinkedNotes: true, maxLinkedNotes: 2 }),
            voiceProfile: voice(),
            behavior: behavior(),
            vault,
            notePath: NOTE_PATH,
            noteText: 'body'
        })
        expect(result.attachments.map((a) => a.path)).toEqual(['L1.md', 'L2.md'])
    })

    test('linked notes are ignored entirely when the editor does not opt in', async () => {
        const vault = vaultOf({
            'L1.md': { content: '1' },
            [NOTE_PATH]: { content: 'body', links: ['L1.md'] }
        })
        const result = await assembleContext({
            editor: editor({ includeLinkedNotes: false }),
            voiceProfile: voice(),
            behavior: behavior(),
            vault,
            notePath: NOTE_PATH,
            noteText: 'body'
        })
        expect(result.attachments).toEqual([])
    })
})
