import { describe, expect, test } from 'bun:test'
import { extractWikilinks } from './wikilinks'

describe('extractWikilinks', () => {
    test('extracts a plain wikilink', () => {
        expect(extractWikilinks('See [[My Note]] for details')).toEqual(['My Note'])
    })

    test('strips aliases', () => {
        expect(extractWikilinks('[[My Note|the note]]')).toEqual(['My Note'])
    })

    test('strips heading and block fragments', () => {
        expect(extractWikilinks('[[My Note#Section]]')).toEqual(['My Note'])
        expect(extractWikilinks('[[My Note#^block-id]]')).toEqual(['My Note'])
    })

    test('handles heading + alias combined', () => {
        expect(extractWikilinks('[[My Note#Section|see here]]')).toEqual(['My Note'])
    })

    test('deduplicates while preserving first-occurrence order', () => {
        expect(extractWikilinks('[[B]] then [[A]] then [[B|again]] and [[A#h]]')).toEqual([
            'B',
            'A'
        ])
    })

    test('extracts multiple links, including adjacent ones', () => {
        expect(extractWikilinks('[[One]][[Two]] and [[Three]]')).toEqual(['One', 'Two', 'Three'])
    })

    test('treats embeds as references', () => {
        expect(extractWikilinks('![[Embedded Note]]')).toEqual(['Embedded Note'])
    })

    test('skips same-note heading refs and empty targets', () => {
        expect(extractWikilinks('[[#Heading]] [[|alias only]] [[  ]] [[]]')).toEqual([])
    })

    test('trims whitespace around targets', () => {
        expect(extractWikilinks('[[  Padded Note  ]]')).toEqual(['Padded Note'])
    })

    test('ignores non-wikilink bracket noise', () => {
        expect(extractWikilinks('array[0], [markdown](link), a ]] stray [[ pair')).toEqual([])
    })

    test('does not match across nested brackets', () => {
        expect(extractWikilinks('[[a[b]] and [[c]d]]')).toEqual([])
    })

    test('handles paths and unicode in targets', () => {
        expect(extractWikilinks('[[Folder/Sub/Note]] [[Éléphant à mémoire]]')).toEqual([
            'Folder/Sub/Note',
            'Éléphant à mémoire'
        ])
    })

    test('returns empty for text without links', () => {
        expect(extractWikilinks('')).toEqual([])
        expect(extractWikilinks('no links here')).toEqual([])
    })

    test('documented simplification: links inside code fences are still extracted', () => {
        const text = '```\n[[In Fence]]\n```\nand `[[In Code]]`'
        expect(extractWikilinks(text)).toEqual(['In Fence', 'In Code'])
    })
})
