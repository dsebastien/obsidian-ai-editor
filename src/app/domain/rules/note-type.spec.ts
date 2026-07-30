import { describe, expect, it } from 'bun:test'
import {
    noteTypeIdsFromRegistry,
    noteTypeIdsFromTags,
    normalizeNoteTypeId,
    resolveNoteTypeIds
} from './note-type'
import type { OskNoteType } from './note-type'

describe('normalizeNoteTypeId', () => {
    it('collapses separators and lowercases', () => {
        expect(normalizeNoteTypeId('Personal Notes')).toBe('personal-notes')
        expect(normalizeNoteTypeId('permanent_note')).toBe('permanent-note')
        expect(normalizeNoteTypeId('daily-notes')).toBe('daily-notes')
    })

    it('trims separator runs at both ends', () => {
        expect(normalizeNoteTypeId('  --Book (note)-- ')).toBe('book-note')
    })

    it('returns an empty string when nothing comparable is left', () => {
        expect(normalizeNoteTypeId('   ')).toBe('')
        expect(normalizeNoteTypeId('---')).toBe('')
    })
})

describe('noteTypeIdsFromTags', () => {
    it('derives one id per type tag, in tag order', () => {
        expect(noteTypeIdsFromTags(['zone/meta', 'type/permanent_note', 'type/task'])).toEqual([
            'permanent-note',
            'task'
        ])
    })

    it('tolerates a leading hash and mixed case', () => {
        expect(noteTypeIdsFromTags(['#Type/Personal'])).toEqual(['personal'])
    })

    it('flattens nested type tags and deduplicates', () => {
        expect(noteTypeIdsFromTags(['type/task/recurring', 'type/task_recurring'])).toEqual([
            'task-recurring'
        ])
    })

    it('ignores non-type tags and empty segments', () => {
        expect(noteTypeIdsFromTags(['topic/writing', 'type/', 'type'])).toEqual([])
    })
})

describe('noteTypeIdsFromRegistry', () => {
    const registry: readonly OskNoteType[] = [
        {
            name: 'Personal Notes',
            mappings: [
                { type: 'tag', value: 'type/personal', enabled: true },
                { type: 'regex', value: '.* \\(Personal\\)$', enabled: true }
            ]
        },
        {
            name: 'Daily Notes',
            mappings: [{ type: 'folder', value: '30 Timestamped/Daily', enabled: true }]
        },
        {
            name: 'Disabled Type',
            mappings: [{ type: 'tag', value: 'type/personal', enabled: false }]
        },
        {
            name: 'Formula Type',
            mappings: [{ type: 'formula', value: 'anything', enabled: true }]
        }
    ]

    it('recognizes by tag mapping', () => {
        expect(
            noteTypeIdsFromRegistry({ path: 'a.md', tags: ['type/personal'] }, registry)
        ).toEqual(['personal-notes'])
    })

    it('recognizes by folder mapping', () => {
        expect(
            noteTypeIdsFromRegistry(
                { path: '30 Timestamped/Daily/2026-07-30.md', tags: [] },
                registry
            )
        ).toEqual(['daily-notes'])
    })

    it('recognizes by filename regex against the basename without extension', () => {
        expect(
            noteTypeIdsFromRegistry({ path: 'Notes/About me (Personal).md', tags: [] }, registry)
        ).toEqual(['personal-notes'])
    })

    it('ignores disabled mappings and mapping kinds it cannot evaluate', () => {
        const ids = noteTypeIdsFromRegistry({ path: 'a.md', tags: ['type/personal'] }, registry)
        expect(ids).not.toContain('disabled-type')
        expect(ids).not.toContain('formula-type')
    })

    it('survives an invalid regex mapping', () => {
        const broken: readonly OskNoteType[] = [
            { name: 'Broken', mappings: [{ type: 'regex', value: '([', enabled: true }] }
        ]
        expect(noteTypeIdsFromRegistry({ path: 'a.md', tags: [] }, broken)).toEqual([])
    })

    it('refuses a catastrophically backtracking pattern instead of running it', () => {
        // `(a+)+$` against a long non-matching name is the classic exponential
        // case. The assertion that matters is the TIME: an unbounded evaluation
        // hangs the renderer thread, taking the settings tab that would let the
        // user fix the foreign plugin's mapping down with it.
        const evil: readonly OskNoteType[] = [
            { name: 'Evil', mappings: [{ type: 'regex', value: '(a+)+$', enabled: true }] }
        ]
        const path = `Notes/${'a'.repeat(40)}!.md`
        const started = performance.now()
        expect(noteTypeIdsFromRegistry({ path, tags: [] }, evil)).toEqual([])
        expect(performance.now() - started).toBeLessThan(1_000)
    })

    it('refuses a pattern longer than the recognition bound', () => {
        const long: readonly OskNoteType[] = [
            {
                name: 'Long',
                mappings: [{ type: 'regex', value: `${'x'.repeat(201)}|.*`, enabled: true }]
            }
        ]
        expect(noteTypeIdsFromRegistry({ path: 'a.md', tags: [] }, long)).toEqual([])
    })

    it('still matches a long file name within the input bound', () => {
        const prefix: readonly OskNoteType[] = [
            { name: 'Prefix', mappings: [{ type: 'regex', value: '^Draft', enabled: true }] }
        ]
        expect(
            noteTypeIdsFromRegistry({ path: `Draft ${'x'.repeat(5_000)}.md`, tags: [] }, prefix)
        ).toEqual(['prefix'])
    })

    it('yields nothing for an empty registry', () => {
        expect(noteTypeIdsFromRegistry({ path: 'a.md', tags: ['type/personal'] }, [])).toEqual([])
    })
})

describe('resolveNoteTypeIds', () => {
    const registry: readonly OskNoteType[] = [
        {
            name: 'Personal Notes',
            mappings: [{ type: 'tag', value: 'type/personal', enabled: true }]
        }
    ]

    it('reports the registry name AND the tag convention, registry first', () => {
        expect(resolveNoteTypeIds({ path: 'a.md', tags: ['type/personal'] }, registry)).toEqual([
            'personal-notes',
            'personal'
        ])
    })

    it('falls back to the tag convention without a registry', () => {
        expect(resolveNoteTypeIds({ path: 'a.md', tags: ['type/permanent_note'] })).toEqual([
            'permanent-note'
        ])
    })

    it('deduplicates when both sources agree', () => {
        const same: readonly OskNoteType[] = [
            { name: 'personal', mappings: [{ type: 'tag', value: 'type/personal', enabled: true }] }
        ]
        expect(resolveNoteTypeIds({ path: 'a.md', tags: ['type/personal'] }, same)).toEqual([
            'personal'
        ])
    })
})
