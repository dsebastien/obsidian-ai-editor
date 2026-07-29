import { describe, expect, test } from 'bun:test'
import {
    behaviorSettingsSchema,
    type BehaviorSettings
} from '../../domain/settings/settings-schema'
import { isExcluded } from './exclusions'
import type { NoteMetadata } from './vault-reader.intf'

function behavior(overrides: Record<string, unknown> = {}): BehaviorSettings {
    return behaviorSettingsSchema.parse(overrides)
}

function metadata(overrides: Partial<NoteMetadata> = {}): NoteMetadata {
    return { tags: [], frontmatter: {}, ...overrides }
}

describe('isExcluded — folders', () => {
    const settings = behavior({ excludedFolders: ['Private'] })

    test('excludes notes under an excluded folder', () => {
        expect(isExcluded('Private/journal.md', metadata(), settings)).toBe(true)
        expect(isExcluded('Private/deep/nested.md', metadata(), settings)).toBe(true)
    })

    test('matches whole path segments only', () => {
        expect(isExcluded('Private stuff/note.md', metadata(), settings)).toBe(false)
        expect(isExcluded('Privateer.md', metadata(), settings)).toBe(false)
    })

    test('does not exclude unrelated paths', () => {
        expect(isExcluded('Public/note.md', metadata(), settings)).toBe(false)
    })

    test('tolerates trailing/leading slashes in the configured folder', () => {
        const slashed = behavior({ excludedFolders: ['/Private/'] })
        expect(isExcluded('Private/journal.md', metadata(), slashed)).toBe(true)
    })

    test('ignores empty folder entries instead of excluding everything', () => {
        const empty = behavior({ excludedFolders: ['', '/'] })
        expect(isExcluded('Public/note.md', metadata(), empty)).toBe(false)
    })

    test('matches case-insensitively in both directions (case-insensitive filesystems)', () => {
        expect(isExcluded('private/journal.md', metadata(), settings)).toBe(true)
        expect(isExcluded('PRIVATE/journal.md', metadata(), settings)).toBe(true)
        const lowercased = behavior({ excludedFolders: ['private'] })
        expect(isExcluded('Private/journal.md', metadata(), lowercased)).toBe(true)
    })
})

describe('isExcluded — null metadata fails closed (Business Rules #7)', () => {
    test('folder exclusions still apply on the path alone', () => {
        const settings = behavior({
            excludedFolders: ['Private'],
            respectFrontmatterOptOut: false
        })
        expect(isExcluded('Private/unknown.md', null, settings)).toBe(true)
        expect(isExcluded('Public/unknown.md', null, settings)).toBe(false)
    })

    test('excluded when tag exclusions are configured but cannot be checked', () => {
        const settings = behavior({
            excludedTags: ['private'],
            respectFrontmatterOptOut: false
        })
        expect(isExcluded('a.md', null, settings)).toBe(true)
    })

    test('excluded when the frontmatter opt-out is respected but cannot be checked', () => {
        expect(isExcluded('a.md', null, behavior())).toBe(true)
    })

    test('not excluded when neither tag nor frontmatter exclusions are active', () => {
        const settings = behavior({ respectFrontmatterOptOut: false })
        expect(isExcluded('a.md', null, settings)).toBe(false)
    })

    test('empty tag entries alone do not fail closed', () => {
        const settings = behavior({
            excludedTags: ['', '#'],
            respectFrontmatterOptOut: false
        })
        expect(isExcluded('a.md', null, settings)).toBe(false)
    })
})

describe('isExcluded — tags', () => {
    const settings = behavior({ excludedTags: ['private'] })

    test('excludes on exact tag match', () => {
        expect(isExcluded('a.md', metadata({ tags: ['private'] }), settings)).toBe(true)
    })

    test('normalizes # and case on both sides', () => {
        expect(isExcluded('a.md', metadata({ tags: ['#Private'] }), settings)).toBe(true)
        const hashed = behavior({ excludedTags: ['#PRIVATE'] })
        expect(isExcluded('a.md', metadata({ tags: ['private'] }), hashed)).toBe(true)
    })

    test('excludes nested subtags', () => {
        expect(isExcluded('a.md', metadata({ tags: ['private/journal'] }), settings)).toBe(true)
    })

    test('does not match tag-name prefixes', () => {
        expect(isExcluded('a.md', metadata({ tags: ['privateer'] }), settings)).toBe(false)
    })

    test('does not exclude notes without matching tags', () => {
        expect(isExcluded('a.md', metadata({ tags: ['public'] }), settings)).toBe(false)
        expect(isExcluded('a.md', metadata(), settings)).toBe(false)
    })
})

describe('isExcluded — frontmatter opt-out', () => {
    test('ai_editor === false excludes', () => {
        expect(
            isExcluded('a.md', metadata({ frontmatter: { ai_editor: false } }), behavior())
        ).toBe(true)
    })

    test('only strict false excludes — truthy, string, absent do not', () => {
        expect(isExcluded('a.md', metadata({ frontmatter: { ai_editor: true } }), behavior())).toBe(
            false
        )
        expect(
            isExcluded('a.md', metadata({ frontmatter: { ai_editor: 'false' } }), behavior())
        ).toBe(false)
        expect(isExcluded('a.md', metadata(), behavior())).toBe(false)
    })

    test('flag is ignored when respectFrontmatterOptOut is off', () => {
        const off = behavior({ respectFrontmatterOptOut: false })
        expect(isExcluded('a.md', metadata({ frontmatter: { ai_editor: false } }), off)).toBe(false)
    })
})
