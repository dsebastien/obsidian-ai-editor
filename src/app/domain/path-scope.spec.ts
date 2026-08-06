import { describe, expect, it } from 'bun:test'
import {
    deleteKeysUnder,
    isPathUnder,
    remapKeysUnder,
    remapMembersUnder,
    remapPathUnder
} from './path-scope'

describe('isPathUnder', () => {
    it('matches the exact path', () => {
        expect(isPathUnder('Notes/A.md', 'Notes/A.md')).toBeTrue()
    })

    it('matches a child of a folder', () => {
        expect(isPathUnder('Notes/Sub/A.md', 'Notes')).toBeTrue()
        expect(isPathUnder('Notes/Sub/A.md', 'Notes/Sub')).toBeTrue()
    })

    it('does not match a sibling that merely shares a prefix', () => {
        expect(isPathUnder('Notes/A.md', 'Notes/A')).toBeFalse()
        expect(isPathUnder('NotesArchive/A.md', 'Notes')).toBeFalse()
    })
})

describe('remapPathUnder', () => {
    it('moves the exact path', () => {
        expect(remapPathUnder('Drafts/A.md', 'Drafts/A.md', 'Published/A.md')).toBe(
            'Published/A.md'
        )
    })

    it('moves a child under the new folder', () => {
        expect(remapPathUnder('Drafts/Sub/A.md', 'Drafts', 'Archive')).toBe('Archive/Sub/A.md')
    })

    it('returns null for anything outside', () => {
        expect(remapPathUnder('Other/A.md', 'Drafts', 'Archive')).toBeNull()
        expect(remapPathUnder('DraftsOld/A.md', 'Drafts', 'Archive')).toBeNull()
    })
})

describe('deleteKeysUnder', () => {
    it('drops the path and everything under it, and nothing else', () => {
        const map = new Map<string, number>([
            ['Notes', 1],
            ['Notes/A.md', 2],
            ['Notes/Sub/B.md', 3],
            ['NotesArchive/C.md', 4],
            ['Other.md', 5]
        ])
        expect(deleteKeysUnder(map, 'Notes')).toBe(3)
        expect([...map.keys()]).toEqual(['NotesArchive/C.md', 'Other.md'])
    })

    it('reports zero when nothing matched', () => {
        const map = new Map<string, number>([['Other.md', 1]])
        expect(deleteKeysUnder(map, 'Notes')).toBe(0)
        expect(map.size).toBe(1)
    })
})

describe('remapKeysUnder', () => {
    it('moves matching keys to the new prefix, values intact, and returns the new keys', () => {
        const map = new Map<string, number>([
            ['Notes/A.md', 1],
            ['Notes/Sub/B.md', 2],
            ['NotesArchive/C.md', 3]
        ])
        expect(remapKeysUnder(map, 'Notes', 'Moved')).toEqual(['Moved/A.md', 'Moved/Sub/B.md'])
        expect(map.get('Moved/A.md')).toBe(1)
        expect(map.get('Moved/Sub/B.md')).toBe(2)
        expect(map.has('Notes/A.md')).toBeFalse()
        // The prefix look-alike stays untouched.
        expect(map.get('NotesArchive/C.md')).toBe(3)
    })

    it('moves an exact single-file key', () => {
        const map = new Map<string, string>([['Drafts/A.md', 'x']])
        expect(remapKeysUnder(map, 'Drafts/A.md', 'Published/A.md')).toEqual(['Published/A.md'])
        expect(map.get('Published/A.md')).toBe('x')
        expect(map.size).toBe(1)
    })

    it('is a no-op when nothing matches', () => {
        const map = new Map<string, number>([['Other.md', 1]])
        expect(remapKeysUnder(map, 'Notes', 'Moved')).toEqual([])
        expect([...map.keys()]).toEqual(['Other.md'])
    })
})

describe('remapMembersUnder', () => {
    it('moves matching members, sparing prefix look-alikes', () => {
        const set = new Set<string>(['Notes/A.md', 'NotesArchive/C.md'])
        expect(remapMembersUnder(set, 'Notes', 'Moved')).toEqual(['Moved/A.md'])
        expect([...set].sort()).toEqual(['Moved/A.md', 'NotesArchive/C.md'])
    })
})
