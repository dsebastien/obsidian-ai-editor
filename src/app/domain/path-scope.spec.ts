import { describe, expect, it } from 'bun:test'
import { deleteKeysUnder, isPathUnder, remapPathUnder } from './path-scope'

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
