import { describe, expect, it } from 'bun:test'
import { bindingRuleSchema, pluginSettingsSchema } from '../settings/settings-schema'
import type { BindingRule, PluginSettingsV1 } from '../settings/settings-schema'
import {
    frontmatterValueMatches,
    matchesNote,
    parseFrontmatterMatch,
    resolveBindingRules,
    resolveRuleEditorPool,
    ruleLabel,
    rulesNeedCachedFacts,
    rulesNeedNoteTypes
} from './rule-engine'
import type { NoteRuleFacts } from './rule-engine'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeRule(overrides: Record<string, unknown>): BindingRule {
    return bindingRuleSchema.parse({
        id: 'rule-1',
        match: { matchType: 'folder', value: 'Blog' },
        effect: 'assign',
        ...overrides
    })
}

function facts(overrides: Partial<NoteRuleFacts> = {}): NoteRuleFacts {
    return {
        path: 'Blog/Post.md',
        cached: { tags: [], frontmatter: {}, noteTypeIds: [] },
        ...overrides
    }
}

const EDITOR_TARGET = { targetType: 'editor' as const, targetId: 'editor-1' }

function makeSettings(overrides: Record<string, unknown> = {}): PluginSettingsV1 {
    return pluginSettingsSchema.parse(overrides)
}

// ---------------------------------------------------------------------------
// Frontmatter matching
// ---------------------------------------------------------------------------

describe('parseFrontmatterMatch', () => {
    it('splits on the first colon only', () => {
        expect(parseFrontmatterMatch('url: https://x.dev/a')).toEqual({
            key: 'url',
            value: 'https://x.dev/a'
        })
    })

    it('treats a bare key as a presence check', () => {
        expect(parseFrontmatterMatch(' draft ')).toEqual({ key: 'draft', value: null })
        expect(parseFrontmatterMatch('draft:')).toEqual({ key: 'draft', value: null })
    })

    it('rejects a blank key', () => {
        expect(parseFrontmatterMatch('  ')).toBeNull()
        expect(parseFrontmatterMatch(': article')).toBeNull()
    })
})

describe('frontmatterValueMatches', () => {
    it('compares stringified values case-insensitively', () => {
        expect(frontmatterValueMatches('Article', 'article')).toBe(true)
        expect(frontmatterValueMatches(2026, '2026')).toBe(true)
        expect(frontmatterValueMatches('note', 'article')).toBe(false)
    })

    it('matches when any array element matches', () => {
        expect(frontmatterValueMatches(['note', 'article'], 'article')).toBe(true)
        expect(frontmatterValueMatches([], 'article')).toBe(false)
    })

    it('presence check rejects absent, null and false values', () => {
        expect(frontmatterValueMatches(undefined, null)).toBe(false)
        expect(frontmatterValueMatches(null, null)).toBe(false)
        expect(frontmatterValueMatches(false, null)).toBe(false)
        expect(frontmatterValueMatches('   ', null)).toBe(false)
        expect(frontmatterValueMatches([], null)).toBe(false)
    })

    it('presence check accepts anything meaningful', () => {
        expect(frontmatterValueMatches(true, null)).toBe(true)
        expect(frontmatterValueMatches(0, null)).toBe(true)
        expect(frontmatterValueMatches(['x'], null)).toBe(true)
    })
})

// ---------------------------------------------------------------------------
// matchesNote
// ---------------------------------------------------------------------------

describe('matchesNote', () => {
    it('matches folders by path segment without needing metadata', () => {
        expect(matchesNote({ matchType: 'folder', value: 'Blog' }, facts({ cached: null }))).toBe(
            true
        )
        expect(
            matchesNote({ matchType: 'folder', value: 'Blogging' }, facts({ cached: null }))
        ).toBe(false)
    })

    it('treats the vault root as a vault-wide folder rule', () => {
        expect(
            matchesNote({ matchType: 'folder', value: '/' }, facts({ path: 'Anywhere/x.md' }))
        ).toBe(true)
    })

    it('matches tags including nested ones', () => {
        const withTags = facts({
            cached: { tags: ['status/draft'], frontmatter: {}, noteTypeIds: [] }
        })
        expect(matchesNote({ matchType: 'tag', value: 'status' }, withTags)).toBe(true)
        expect(matchesNote({ matchType: 'tag', value: 'published' }, withTags)).toBe(false)
    })

    it('matches frontmatter key/value pairs', () => {
        const withFm = facts({
            cached: { tags: [], frontmatter: { type: 'article' }, noteTypeIds: [] }
        })
        expect(matchesNote({ matchType: 'frontmatter', value: 'type: article' }, withFm)).toBe(true)
        expect(matchesNote({ matchType: 'frontmatter', value: 'type: note' }, withFm)).toBe(false)
        expect(matchesNote({ matchType: 'frontmatter', value: 'type' }, withFm)).toBe(true)
    })

    it('matches note types through the normalized identifier set', () => {
        const typed = facts({
            cached: { tags: [], frontmatter: {}, noteTypeIds: ['personal-notes', 'personal'] }
        })
        expect(matchesNote({ matchType: 'osk-note-type', value: 'Personal Notes' }, typed)).toBe(
            true
        )
        expect(matchesNote({ matchType: 'osk-note-type', value: 'personal' }, typed)).toBe(true)
        expect(matchesNote({ matchType: 'osk-note-type', value: 'tasks' }, typed)).toBe(false)
    })

    it('cannot decide tag/frontmatter/note-type matches without metadata', () => {
        const cold = facts({ cached: null })
        expect(matchesNote({ matchType: 'tag', value: 'draft' }, cold)).toBeNull()
        expect(matchesNote({ matchType: 'frontmatter', value: 'type: article' }, cold)).toBeNull()
        expect(matchesNote({ matchType: 'osk-note-type', value: 'tasks' }, cold)).toBeNull()
    })
})

// ---------------------------------------------------------------------------
// resolveBindingRules
// ---------------------------------------------------------------------------

describe('resolveBindingRules', () => {
    it('returns default when there are no rules', () => {
        expect(resolveBindingRules([], facts())).toEqual({ kind: 'default' })
    })

    it('assigns the first matching assign rule in list order', () => {
        const rules = [
            makeRule({
                id: 'r1',
                name: 'Blog',
                match: { matchType: 'folder', value: 'Blog' },
                defaultTarget: EDITOR_TARGET
            }),
            makeRule({
                id: 'r2',
                match: { matchType: 'folder', value: '/' },
                defaultTarget: { targetType: 'editor', targetId: 'editor-2' }
            })
        ]
        expect(resolveBindingRules(rules, facts())).toEqual({
            kind: 'assigned',
            ruleId: 'r1',
            ruleLabel: 'Blog',
            target: EDITOR_TARGET
        })
    })

    it('lets a kill switch win from ANY position in the list', () => {
        const rules = [
            makeRule({
                id: 'r1',
                match: { matchType: 'folder', value: 'Blog' },
                defaultTarget: EDITOR_TARGET
            }),
            makeRule({
                id: 'r2',
                name: 'No AI here',
                match: { matchType: 'tag', value: 'private' },
                effect: 'disabled'
            })
        ]
        expect(
            resolveBindingRules(
                rules,
                facts({ cached: { tags: ['private'], frontmatter: {}, noteTypeIds: [] } })
            )
        ).toEqual({ kind: 'disabled', ruleId: 'r2', ruleLabel: 'No AI here' })
    })

    it('skips disabled rules', () => {
        const rules = [
            makeRule({
                id: 'r1',
                match: { matchType: 'folder', value: '/' },
                effect: 'disabled',
                enabled: false
            }),
            makeRule({
                id: 'r2',
                match: { matchType: 'folder', value: '/' },
                defaultTarget: EDITOR_TARGET,
                enabled: false
            })
        ]
        expect(resolveBindingRules(rules, facts())).toEqual({ kind: 'default' })
    })

    it('skips assign rules that have no target', () => {
        const rules = [
            makeRule({ id: 'r1', match: { matchType: 'folder', value: '/' }, defaultTarget: null }),
            makeRule({
                id: 'r2',
                match: { matchType: 'folder', value: 'Blog' },
                defaultTarget: EDITOR_TARGET
            })
        ]
        expect(resolveBindingRules(rules, facts())).toMatchObject({
            kind: 'assigned',
            ruleId: 'r2'
        })
    })

    it('falls back to the match expression when the rule is unnamed', () => {
        const rule = makeRule({
            id: 'r1',
            match: { matchType: 'tag', value: 'draft' },
            effect: 'disabled'
        })
        expect(ruleLabel(rule)).toBe('tag "draft"')
        expect(
            resolveBindingRules(
                [rule],
                facts({ cached: { tags: ['draft'], frontmatter: {}, noteTypeIds: [] } })
            )
        ).toEqual({ kind: 'disabled', ruleId: 'r1', ruleLabel: 'tag "draft"' })
    })

    describe('unresolved metadata', () => {
        const cold = facts({ cached: null })

        it('fails CLOSED for kill switches', () => {
            const rule = makeRule({
                id: 'r1',
                match: { matchType: 'tag', value: 'private' },
                effect: 'disabled'
            })
            expect(resolveBindingRules([rule], cold)).toMatchObject({ kind: 'disabled' })
        })

        it('fails OPEN for assignments', () => {
            const rule = makeRule({
                id: 'r1',
                match: { matchType: 'osk-note-type', value: 'daily-notes' },
                defaultTarget: EDITOR_TARGET
            })
            expect(resolveBindingRules([rule], cold)).toEqual({ kind: 'default' })
        })

        it('still evaluates folder rules normally', () => {
            const rule = makeRule({
                id: 'r1',
                match: { matchType: 'folder', value: 'Elsewhere' },
                effect: 'disabled'
            })
            expect(resolveBindingRules([rule], cold)).toEqual({ kind: 'default' })
        })
    })
})

// ---------------------------------------------------------------------------
// Fact-gathering gates
// ---------------------------------------------------------------------------

describe('rulesNeedCachedFacts / rulesNeedNoteTypes', () => {
    it('are false without rules and for folder-only rules', () => {
        expect(rulesNeedCachedFacts([])).toBe(false)
        expect(rulesNeedNoteTypes([])).toBe(false)
        const folderOnly = [makeRule({ effect: 'disabled' })]
        expect(rulesNeedCachedFacts(folderOnly)).toBe(false)
        expect(rulesNeedNoteTypes(folderOnly)).toBe(false)
    })

    it('ignore rules that can never apply', () => {
        const inert = [
            makeRule({ id: 'r1', match: { matchType: 'tag', value: 'x' }, enabled: false }),
            makeRule({
                id: 'r2',
                match: { matchType: 'osk-note-type', value: 'x' },
                defaultTarget: null
            })
        ]
        expect(rulesNeedCachedFacts(inert)).toBe(false)
        expect(rulesNeedNoteTypes(inert)).toBe(false)
    })

    it('separate note-type rules from the other metadata rules', () => {
        const tagRule = [makeRule({ match: { matchType: 'tag', value: 'x' }, effect: 'disabled' })]
        expect(rulesNeedCachedFacts(tagRule)).toBe(true)
        expect(rulesNeedNoteTypes(tagRule)).toBe(false)

        const typeRule = [
            makeRule({ match: { matchType: 'osk-note-type', value: 'x' }, effect: 'disabled' })
        ]
        expect(rulesNeedCachedFacts(typeRule)).toBe(true)
        expect(rulesNeedNoteTypes(typeRule)).toBe(true)
    })
})

// ---------------------------------------------------------------------------
// Participant pool
// ---------------------------------------------------------------------------

describe('resolveRuleEditorPool', () => {
    it('is default for a non-assignment outcome', () => {
        expect(resolveRuleEditorPool(makeSettings(), { kind: 'default' })).toEqual({
            kind: 'default'
        })
        expect(
            resolveRuleEditorPool(makeSettings(), {
                kind: 'disabled',
                ruleId: 'r1',
                ruleLabel: 'x'
            })
        ).toEqual({ kind: 'default' })
    })

    it('names the single editor of an editor target', () => {
        expect(
            resolveRuleEditorPool(makeSettings(), {
                kind: 'assigned',
                ruleId: 'r1',
                ruleLabel: 'x',
                target: EDITOR_TARGET
            })
        ).toEqual({ kind: 'editors', editorIds: ['editor-1'] })
    })

    it('names every member of a panel target, regardless of the panel enabled flag', () => {
        const settings = makeSettings({
            panels: [
                {
                    id: 'panel-1',
                    name: 'Pre-publish',
                    memberEditorIds: ['editor-1', 'editor-2'],
                    enabled: false
                }
            ]
        })
        expect(
            resolveRuleEditorPool(settings, {
                kind: 'assigned',
                ruleId: 'r1',
                ruleLabel: 'x',
                target: { targetType: 'panel', targetId: 'panel-1' }
            })
        ).toEqual({ kind: 'editors', editorIds: ['editor-1', 'editor-2'] })
    })

    it('reports a dangling panel target instead of silently emptying the pool', () => {
        expect(
            resolveRuleEditorPool(makeSettings(), {
                kind: 'assigned',
                ruleId: 'r1',
                ruleLabel: 'x',
                target: { targetType: 'panel', targetId: 'gone' }
            })
        ).toEqual({ kind: 'target-missing', targetId: 'gone' })
    })
})
