import { describe, expect, it } from 'bun:test'
import { MEMORY_TEXT_MAX } from '../../domain/operations/contract'
import {
    clipMemory,
    deriveNoteMemory,
    normalizeMemoryNotePath,
    replaceMemoryBody
} from './memory-note'

describe('replaceMemoryBody', () => {
    it('preserves a leading frontmatter block and replaces the body wholesale', () => {
        const existing = '---\ntags: [ai]\nai_editor: true\n---\nOld rule one.\nOld rule two.\n'
        expect(replaceMemoryBody(existing, 'New rules.')).toEqual(
            '---\ntags: [ai]\nai_editor: true\n---\nNew rules.\n'
        )
    })

    it('replaces everything when the note has no frontmatter', () => {
        expect(replaceMemoryBody('Old body.\n', 'New body.')).toEqual('New body.\n')
    })

    it('handles an empty existing note (creation path)', () => {
        expect(replaceMemoryBody('', 'First memory.')).toEqual('First memory.\n')
    })

    it('does not double a trailing newline the memory already carries', () => {
        expect(replaceMemoryBody('', 'Memory.\n')).toEqual('Memory.\n')
    })

    it('leaves a mid-document --- alone (thematic break, not frontmatter)', () => {
        const existing = 'Intro.\n---\nRest.\n'
        expect(replaceMemoryBody(existing, 'New.')).toEqual('New.\n')
    })

    it('keeps a frontmatter-only note as frontmatter + new body', () => {
        const existing = '---\nkey: value\n---\n'
        expect(replaceMemoryBody(existing, 'Body.')).toEqual('---\nkey: value\n---\nBody.\n')
    })

    it('an empty memory clears the body but keeps the frontmatter', () => {
        const existing = '---\nkey: value\n---\nOld.\n'
        expect(replaceMemoryBody(existing, '')).toEqual('---\nkey: value\n---\n')
    })

    it('inserts the missing newline after a closing fence at end-of-input', () => {
        // Frontmatter-only note WITHOUT a final newline: gluing the body
        // straight on would corrupt the closing fence into `---Body.`
        const existing = '---\nkey: value\n---'
        expect(replaceMemoryBody(existing, 'Body.')).toEqual('---\nkey: value\n---\nBody.\n')
    })

    it('round-trips: a second replacement still preserves the frontmatter', () => {
        const once = replaceMemoryBody('---\nkey: value\n---', 'First.')
        expect(replaceMemoryBody(once, 'Second.')).toEqual('---\nkey: value\n---\nSecond.\n')
    })
})

describe('normalizeMemoryNotePath', () => {
    it('trims stray whitespace from the free-text setting', () => {
        expect(normalizeMemoryNotePath(' Meta/Memory.md ')).toEqual('Meta/Memory.md')
    })

    it('appends .md when the extension is missing (the vault reader is md-only)', () => {
        expect(normalizeMemoryNotePath('Meta/AI memory')).toEqual('Meta/AI memory.md')
    })

    it('accepts an existing extension case-insensitively', () => {
        expect(normalizeMemoryNotePath('Meta/Memory.MD')).toEqual('Meta/Memory.MD')
    })

    it('maps empty and whitespace-only input to the empty path', () => {
        expect(normalizeMemoryNotePath('')).toEqual('')
        expect(normalizeMemoryNotePath('   ')).toEqual('')
    })

    it('folds backslash separators to slashes (vault paths are /-separated)', () => {
        expect(normalizeMemoryNotePath('Meta\\AI\\Memory')).toEqual('Meta/AI/Memory.md')
    })

    it('refuses traversal — ".." and "." segments would escape the vault', () => {
        // `Vault.create` joins onto the vault base path and the adapter
        // resolves `..`, so these would read/write OUTSIDE the vault.
        expect(normalizeMemoryNotePath('../outside')).toEqual('')
        expect(normalizeMemoryNotePath('Meta/../../outside.md')).toEqual('')
        expect(normalizeMemoryNotePath('./Memory.md')).toEqual('')
        expect(normalizeMemoryNotePath('..\\outside')).toEqual('')
    })

    it('refuses absolute paths (POSIX and Windows drive letters)', () => {
        expect(normalizeMemoryNotePath('/etc/passwd')).toEqual('')
        expect(normalizeMemoryNotePath('C:\\Users\\x\\evil')).toEqual('')
        expect(normalizeMemoryNotePath('c:/evil.md')).toEqual('')
    })

    it('refuses empty path segments (doubled or trailing slashes)', () => {
        expect(normalizeMemoryNotePath('Meta//Memory.md')).toEqual('')
        expect(normalizeMemoryNotePath('Meta/')).toEqual('')
    })

    it('keeps a dotted FILENAME that is not a traversal segment', () => {
        expect(normalizeMemoryNotePath('Meta/v1.2 memory')).toEqual('Meta/v1.2 memory.md')
    })
})

describe('clipMemory and deriveNoteMemory (shared by distiller and save-path conflict re-read)', () => {
    it('clips to the contract ceiling and leaves shorter text alone', () => {
        expect(clipMemory('short')).toEqual('short')
        expect(clipMemory('x'.repeat(MEMORY_TEXT_MAX + 10))).toHaveLength(MEMORY_TEXT_MAX)
    })

    it('derives a missing note (null) as the empty memory — the first-distillation flow', () => {
        expect(deriveNoteMemory(null)).toEqual('')
    })

    it('derives an existing note as its body with the frontmatter stripped', () => {
        expect(deriveNoteMemory('---\ntags: [ai]\n---\nRule one.\n')).toEqual('Rule one.\n')
    })

    it('clips an oversized note body', () => {
        expect(deriveNoteMemory('x'.repeat(MEMORY_TEXT_MAX + 10))).toHaveLength(MEMORY_TEXT_MAX)
    })
})
