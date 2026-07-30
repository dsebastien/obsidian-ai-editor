import { describe, expect, it } from 'bun:test'
import { bindingRuleSchema, pluginSettingsSchema } from '../../domain/settings/settings-schema'
import type { PluginSettingsV1 } from '../../domain/settings/settings-schema'
import type { NoteMetadata } from '../context/vault-reader.intf'
import { isPluginDisabledByRule, noteRuleFacts, noteRuleOutcome } from './note-rules'
import type { NoteFactsSource } from './note-rules'

/** Counting fake: proves which lookups the fact gathering actually performs. */
class FakeSource implements NoteFactsSource {
    metadataCalls = 0
    noteTypeCalls = 0

    constructor(
        private readonly metadata: NoteMetadata | null = { tags: [], frontmatter: {} },
        private readonly noteTypeIds: readonly string[] = []
    ) {}

    getNoteMetadata(): NoteMetadata | null {
        this.metadataCalls += 1
        return this.metadata
    }

    getNoteTypeIds(): readonly string[] {
        this.noteTypeCalls += 1
        return this.noteTypeIds
    }
}

function settingsWithRules(rules: readonly Record<string, unknown>[]): PluginSettingsV1 {
    return pluginSettingsSchema.parse({
        rules: rules.map((rule) => bindingRuleSchema.parse(rule))
    })
}

const DISABLE_TAG_RULE = {
    id: 'r1',
    match: { matchType: 'tag', value: 'private' },
    effect: 'disabled'
}

const DISABLE_TYPE_RULE = {
    id: 'r2',
    match: { matchType: 'osk-note-type', value: 'daily-notes' },
    effect: 'disabled'
}

const DISABLE_FOLDER_RULE = {
    id: 'r3',
    match: { matchType: 'folder', value: 'Private' },
    effect: 'disabled'
}

describe('noteRuleFacts', () => {
    it('skips the metadata lookup when only folder rules can apply', () => {
        const source = new FakeSource()
        const facts = noteRuleFacts('a.md', source, [bindingRuleSchema.parse(DISABLE_FOLDER_RULE)])
        expect(facts.cached).toEqual({ tags: [], frontmatter: {}, noteTypeIds: [] })
        expect(source.metadataCalls).toBe(0)
        expect(source.noteTypeCalls).toBe(0)
    })

    it('reads metadata once but not note types for a tag rule', () => {
        const source = new FakeSource({ tags: ['private'], frontmatter: { type: 'x' } })
        const facts = noteRuleFacts('a.md', source, [bindingRuleSchema.parse(DISABLE_TAG_RULE)])
        expect(facts.cached).toEqual({
            tags: ['private'],
            frontmatter: { type: 'x' },
            noteTypeIds: []
        })
        expect(source.metadataCalls).toBe(1)
        expect(source.noteTypeCalls).toBe(0)
    })

    it('resolves note types only for a note-type rule', () => {
        const source = new FakeSource({ tags: [], frontmatter: {} }, ['daily-notes'])
        const facts = noteRuleFacts('a.md', source, [bindingRuleSchema.parse(DISABLE_TYPE_RULE)])
        expect(facts.cached?.noteTypeIds).toEqual(['daily-notes'])
        expect(source.noteTypeCalls).toBe(1)
    })

    it('propagates an unresolved metadata cache as unknown', () => {
        const source = new FakeSource(null)
        const facts = noteRuleFacts('a.md', source, [bindingRuleSchema.parse(DISABLE_TAG_RULE)])
        expect(facts.cached).toBeNull()
        expect(source.noteTypeCalls).toBe(0)
    })
})

describe('noteRuleOutcome', () => {
    it('is default without rules and never touches the vault', () => {
        const source = new FakeSource()
        expect(noteRuleOutcome('a.md', source, pluginSettingsSchema.parse({}))).toEqual({
            kind: 'default'
        })
        expect(source.metadataCalls).toBe(0)
    })

    it('reports the kill switch that matched', () => {
        const outcome = noteRuleOutcome(
            'a.md',
            new FakeSource({ tags: ['private/journal'], frontmatter: {} }),
            settingsWithRules([DISABLE_TAG_RULE])
        )
        expect(outcome).toMatchObject({ kind: 'disabled', ruleId: 'r1' })
    })

    it('reports the assigned target', () => {
        const outcome = noteRuleOutcome(
            'Blog/Post.md',
            new FakeSource(),
            settingsWithRules([
                {
                    id: 'r1',
                    match: { matchType: 'folder', value: 'Blog' },
                    effect: 'assign',
                    defaultTarget: { targetType: 'editor', targetId: 'editor-1' }
                }
            ])
        )
        expect(outcome).toMatchObject({
            kind: 'assigned',
            target: { targetType: 'editor', targetId: 'editor-1' }
        })
    })
})

describe('isPluginDisabledByRule', () => {
    it('is true only for a matching kill switch', () => {
        const settings = settingsWithRules([DISABLE_FOLDER_RULE])
        expect(isPluginDisabledByRule('Private/a.md', new FakeSource(), settings)).toBe(true)
        expect(isPluginDisabledByRule('Blog/a.md', new FakeSource(), settings)).toBe(false)
    })

    it('fails closed while the metadata cache is cold', () => {
        expect(
            isPluginDisabledByRule(
                'a.md',
                new FakeSource(null),
                settingsWithRules([DISABLE_TAG_RULE])
            )
        ).toBe(true)
    })
})
