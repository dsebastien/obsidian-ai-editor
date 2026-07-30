import { describe, expect, it } from 'bun:test'
import {
    anyTagMatches,
    folderContainsPath,
    normalizeFolderPath,
    normalizeTagName,
    tagMatchesOrNests
} from './matchers'

describe('normalizeFolderPath', () => {
    it('strips surrounding slashes and whitespace and lowercases', () => {
        expect(normalizeFolderPath('  /Private/Notes/ ')).toBe('private/notes')
    })

    it('reduces the vault root to an empty string', () => {
        expect(normalizeFolderPath('/')).toBe('')
        expect(normalizeFolderPath('')).toBe('')
    })
})

describe('folderContainsPath', () => {
    it('matches the folder itself and anything under it', () => {
        expect(folderContainsPath('Private', 'Private/a.md')).toBe(true)
        expect(folderContainsPath('Private', 'private')).toBe(true)
    })

    it('matches whole path segments only', () => {
        expect(folderContainsPath('Private', 'Private stuff/a.md')).toBe(false)
        expect(folderContainsPath('Priv', 'Private/a.md')).toBe(false)
    })

    it('ignores case on both sides', () => {
        expect(folderContainsPath('private/notes', 'Private/Notes/Deep/a.md')).toBe(true)
    })

    it('matches nothing for a folder that normalizes to nothing', () => {
        expect(folderContainsPath('/', 'a.md')).toBe(false)
        expect(folderContainsPath('', 'a.md')).toBe(false)
    })
})

describe('normalizeTagName', () => {
    it('strips one leading hash and lowercases', () => {
        expect(normalizeTagName(' #Private/Journal ')).toBe('private/journal')
    })
})

describe('tagMatchesOrNests', () => {
    it('matches an exact tag and nested children', () => {
        expect(tagMatchesOrNests('private', 'Private')).toBe(true)
        expect(tagMatchesOrNests('#private', 'private/journal')).toBe(true)
    })

    it('does not match a sibling prefix', () => {
        expect(tagMatchesOrNests('private', 'privateer')).toBe(false)
    })

    it('matches nothing for a blank pattern', () => {
        expect(tagMatchesOrNests('  ', 'private')).toBe(false)
        expect(tagMatchesOrNests('#', 'private')).toBe(false)
    })
})

describe('anyTagMatches', () => {
    it('is true when any tag matches', () => {
        expect(anyTagMatches('draft', ['topic/x', 'Draft'])).toBe(true)
    })

    it('is false for an empty tag list', () => {
        expect(anyTagMatches('draft', [])).toBe(false)
    })
})
