import { describe, expect, it } from 'bun:test'
import {
    apiBackendSchema,
    editorConfigSchema,
    pluginSettingsSchema
} from '../domain/settings/settings-schema'
import type { ApiBackend, EditorConfig, PluginSettingsV1 } from '../domain/settings/settings-schema'
import type { NoteMetadata } from './context/vault-reader.intf'
import {
    askablePanels,
    hasReviewCapableEditor,
    isExcluded,
    isPluginEnabledForNote,
    isReviewable,
    reviewCapableEditors,
    reviewGate
} from './reviewability'
import type { NoteFactsSource } from './rules/note-rules'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeBackend(overrides: Partial<ApiBackend> = {}): ApiBackend {
    return apiBackendSchema.parse({
        id: 'backend-1',
        family: 'api',
        kind: 'anthropic',
        label: 'Claude',
        apiKey: 'sk-test',
        defaultModel: 'claude-test-1',
        ...overrides
    })
}

function makeEditor(overrides: Record<string, unknown> = {}): EditorConfig {
    return editorConfigSchema.parse({
        id: 'editor-1',
        name: 'Hater',
        ...overrides
    })
}

function makeSettings(overrides: Record<string, unknown> = {}): PluginSettingsV1 {
    return pluginSettingsSchema.parse({
        backends: [makeBackend()],
        defaultBackend: { backendId: 'backend-1', model: '' },
        editors: [makeEditor()],
        ...overrides
    })
}

const NO_METADATA_EXCLUSIONS: NoteMetadata = { tags: [], frontmatter: {} }

/**
 * Minimal `NoteFactsSource`: one metadata value for every path plus optional
 * note-type ids (binding rules read both through this seam).
 */
function factsOf(
    metadata: NoteMetadata | null,
    noteTypeIds: readonly string[] = []
): NoteFactsSource {
    return {
        getNoteMetadata: (): NoteMetadata | null => metadata,
        getNoteTypeIds: (): readonly string[] => noteTypeIds
    }
}

// ---------------------------------------------------------------------------
// hasReviewCapableEditor
// ---------------------------------------------------------------------------

describe('hasReviewCapableEditor', () => {
    it('is true when an enabled review-capable editor resolves a backend', () => {
        expect(hasReviewCapableEditor(makeSettings())).toBe(true)
    })

    it('is false when there are no editors', () => {
        expect(hasReviewCapableEditor(makeSettings({ editors: [] }))).toBe(false)
    })

    it('is false when every editor is disabled', () => {
        const settings = makeSettings({ editors: [makeEditor({ enabled: false })] })
        expect(hasReviewCapableEditor(settings)).toBe(false)
    })

    it('is false when no editor has the review capability', () => {
        const settings = makeSettings({
            editors: [
                makeEditor({ capabilities: { review: false, rewrite: true, research: false } })
            ]
        })
        expect(hasReviewCapableEditor(settings)).toBe(false)
    })

    it('is false when no backend is configured anywhere', () => {
        const settings = makeSettings({ defaultBackend: null })
        expect(hasReviewCapableEditor(settings)).toBe(false)
    })

    it('is false when the resolved backend is disabled', () => {
        const settings = makeSettings({ backends: [makeBackend({ enabled: false })] })
        expect(hasReviewCapableEditor(settings)).toBe(false)
    })

    it('is false when the backend reference dangles', () => {
        const settings = makeSettings({
            defaultBackend: { backendId: 'gone', model: '' }
        })
        expect(hasReviewCapableEditor(settings)).toBe(false)
    })

    it('is false when neither the ref nor the backend has a model', () => {
        const settings = makeSettings({ backends: [makeBackend({ defaultModel: '' })] })
        expect(hasReviewCapableEditor(settings)).toBe(false)
    })

    it('is true when at least one of several editors can dispatch', () => {
        const settings = makeSettings({
            editors: [
                makeEditor({ id: 'editor-off', enabled: false }),
                makeEditor({
                    id: 'editor-no-review',
                    capabilities: { review: false, rewrite: true, research: false }
                }),
                makeEditor({ id: 'editor-ok' })
            ]
        })
        expect(hasReviewCapableEditor(settings)).toBe(true)
    })
})

// ---------------------------------------------------------------------------
// reviewCapableEditors
// ---------------------------------------------------------------------------

describe('reviewCapableEditors', () => {
    it('lists only dispatchable editors, in settings order', () => {
        const settings = makeSettings({
            editors: [
                makeEditor({ id: 'editor-off', enabled: false }),
                makeEditor({ id: 'editor-a', name: 'Mentor' }),
                makeEditor({
                    id: 'editor-no-review',
                    capabilities: { review: false, rewrite: true, research: false }
                }),
                makeEditor({ id: 'editor-b', name: 'Hater' })
            ]
        })
        expect(reviewCapableEditors(settings).map((editor) => editor.id)).toEqual([
            'editor-a',
            'editor-b'
        ])
    })

    it('is empty when no backend resolves for any editor', () => {
        const settings = makeSettings({ defaultBackend: null })
        expect(reviewCapableEditors(settings)).toEqual([])
    })
})

// ---------------------------------------------------------------------------
// isReviewable
// ---------------------------------------------------------------------------

describe('isReviewable', () => {
    it('is true for a non-excluded note with a dispatchable editor', () => {
        expect(isReviewable('Notes/idea.md', factsOf(NO_METADATA_EXCLUSIONS), makeSettings())).toBe(
            true
        )
    })

    it('is false for a folder-excluded note', () => {
        const settings = makeSettings({
            behavior: { excludedFolders: ['Private'] }
        })
        expect(isReviewable('Private/journal.md', factsOf(NO_METADATA_EXCLUSIONS), settings)).toBe(
            false
        )
    })

    it('is false for a tag-excluded note', () => {
        const settings = makeSettings({
            behavior: { excludedTags: ['private'] }
        })
        const metadata: NoteMetadata = { tags: ['#private/journal'], frontmatter: {} }
        expect(isReviewable('Notes/idea.md', factsOf(metadata), settings)).toBe(false)
    })

    it('fails closed on null metadata when tag exclusions are configured', () => {
        const settings = makeSettings({
            behavior: { excludedTags: ['private'], respectFrontmatterOptOut: false }
        })
        expect(isReviewable('Notes/idea.md', factsOf(null), settings)).toBe(false)
    })

    it('is false for a frontmatter opt-out note', () => {
        const metadata: NoteMetadata = { tags: [], frontmatter: { ai_editor: false } }
        expect(isReviewable('Notes/idea.md', factsOf(metadata), makeSettings())).toBe(false)
    })

    it('is false when no editor can dispatch, even for an includable note', () => {
        const settings = makeSettings({ editors: [] })
        expect(isReviewable('Notes/idea.md', factsOf(NO_METADATA_EXCLUSIONS), settings)).toBe(false)
    })

    it('re-exports isExcluded so surfaces need a single import', () => {
        expect(typeof isExcluded).toBe('function')
        const settings = makeSettings({ behavior: { excludedFolders: ['Private'] } })
        expect(isExcluded('Private/a.md', NO_METADATA_EXCLUSIONS, settings.behavior)).toBe(true)
    })
})

// ---------------------------------------------------------------------------
// Binding-rule kill switch (plan §4b)
// ---------------------------------------------------------------------------

describe('binding rules', () => {
    const withRule = (rule: Record<string, unknown>): PluginSettingsV1 =>
        makeSettings({
            rules: [
                {
                    id: 'r1',
                    match: { matchType: 'folder', value: 'Private' },
                    effect: 'disabled',
                    ...rule
                }
            ]
        })

    it('makes a kill-switched note neither reviewable nor plugin-enabled', () => {
        const settings = withRule({})
        const facts = factsOf(NO_METADATA_EXCLUSIONS)
        expect(isReviewable('Private/journal.md', facts, settings)).toBe(false)
        expect(isPluginEnabledForNote('Private/journal.md', facts, settings)).toBe(false)
    })

    it('leaves other notes alone', () => {
        const settings = withRule({})
        const facts = factsOf(NO_METADATA_EXCLUSIONS)
        expect(isReviewable('Blog/post.md', facts, settings)).toBe(true)
        expect(isPluginEnabledForNote('Blog/post.md', facts, settings)).toBe(true)
    })

    it('reads note-type facts through the same seam', () => {
        const settings = withRule({
            match: { matchType: 'osk-note-type', value: 'Daily Notes' }
        })
        expect(
            isReviewable(
                'Journal/2026-07-30.md',
                factsOf(NO_METADATA_EXCLUSIONS, ['daily-notes']),
                settings
            )
        ).toBe(false)
        expect(
            isReviewable(
                'Journal/2026-07-30.md',
                factsOf(NO_METADATA_EXCLUSIONS, ['tasks']),
                settings
            )
        ).toBe(true)
    })

    it('an assign rule never blocks a note', () => {
        const settings = withRule({
            effect: 'assign',
            defaultTarget: { targetType: 'editor', targetId: 'editor-1' }
        })
        expect(isReviewable('Private/journal.md', factsOf(NO_METADATA_EXCLUSIONS), settings)).toBe(
            true
        )
    })

    it('isPluginEnabledForNote is independent of having a review-capable editor', () => {
        const settings = makeSettings({ editors: [] })
        const facts = factsOf(NO_METADATA_EXCLUSIONS)
        expect(isPluginEnabledForNote('Notes/idea.md', facts, settings)).toBe(true)
        expect(isReviewable('Notes/idea.md', facts, settings)).toBe(false)
    })
})

// ---------------------------------------------------------------------------
// reviewGate — the one evaluation `isReviewable` / `isPluginEnabledForNote`
// project (surfaces that must SAY WHY read this)
// ---------------------------------------------------------------------------

describe('reviewGate', () => {
    const facts = factsOf(NO_METADATA_EXCLUSIONS)

    it('is ok for a reviewable note', () => {
        expect(reviewGate('Notes/idea.md', facts, makeSettings())).toEqual({ status: 'ok' })
    })

    it('reports the privacy exclusion', () => {
        const settings = makeSettings({ behavior: { excludedFolders: ['Private'] } })
        expect(reviewGate('Private/journal.md', facts, settings)).toEqual({ status: 'excluded' })
    })

    it('reports the kill switch with the rule label', () => {
        const settings = makeSettings({
            rules: [
                {
                    id: 'r1',
                    name: 'No journals',
                    match: { matchType: 'folder', value: 'Journal' },
                    effect: 'disabled'
                }
            ]
        })
        expect(reviewGate('Journal/2026-07-30.md', facts, settings)).toEqual({
            status: 'rule-disabled',
            ruleLabel: 'No journals'
        })
    })

    it('falls back to the rule match expression when the rule is unnamed', () => {
        const settings = makeSettings({
            rules: [
                {
                    id: 'r1',
                    match: { matchType: 'tag', value: 'private' },
                    effect: 'disabled'
                }
            ]
        })
        const gate = reviewGate(
            'Notes/idea.md',
            factsOf({ tags: ['#private'], frontmatter: {} }),
            settings
        )
        expect(gate.status).toBe('rule-disabled')
        if (gate.status === 'rule-disabled') {
            expect(gate.ruleLabel.length).toBeGreaterThan(0)
        }
    })

    it('reports no-editor last, so a configuration fix is not blamed on privacy', () => {
        expect(reviewGate('Notes/idea.md', facts, makeSettings({ editors: [] }))).toEqual({
            status: 'no-editor'
        })
    })

    it('privacy outranks the kill switch when both match', () => {
        const settings = makeSettings({
            behavior: { excludedFolders: ['Private'] },
            rules: [
                {
                    id: 'r1',
                    name: 'No privates',
                    match: { matchType: 'folder', value: 'Private' },
                    effect: 'disabled'
                }
            ]
        })
        expect(reviewGate('Private/a.md', facts, settings)).toEqual({ status: 'excluded' })
    })

    it('the kill switch outranks a missing editor', () => {
        const settings = makeSettings({
            editors: [],
            rules: [
                {
                    id: 'r1',
                    name: 'Off here',
                    match: { matchType: 'folder', value: 'Journal' },
                    effect: 'disabled'
                }
            ]
        })
        expect(reviewGate('Journal/a.md', facts, settings)).toEqual({
            status: 'rule-disabled',
            ruleLabel: 'Off here'
        })
    })

    it('agrees with isReviewable and isPluginEnabledForNote in every case', () => {
        const cases: readonly { settings: PluginSettingsV1; path: string }[] = [
            { settings: makeSettings(), path: 'Notes/idea.md' },
            {
                settings: makeSettings({ behavior: { excludedFolders: ['Private'] } }),
                path: 'Private/a.md'
            },
            { settings: makeSettings({ editors: [] }), path: 'Notes/idea.md' },
            {
                settings: makeSettings({
                    rules: [
                        {
                            id: 'r1',
                            match: { matchType: 'folder', value: 'Journal' },
                            effect: 'disabled'
                        }
                    ]
                }),
                path: 'Journal/a.md'
            }
        ]
        for (const { settings, path } of cases) {
            const gate = reviewGate(path, facts, settings)
            expect(isReviewable(path, facts, settings)).toBe(gate.status === 'ok')
            expect(isPluginEnabledForNote(path, facts, settings)).toBe(
                gate.status === 'ok' || gate.status === 'no-editor'
            )
        }
    })
})

// ---------------------------------------------------------------------------
// The gate is note-scoped, not global
// ---------------------------------------------------------------------------

describe('reviewGate over a rule-assigned pool', () => {
    const assignTo = (target: Record<string, unknown>): Record<string, unknown> => ({
        id: 'rule-1',
        name: 'Blog',
        match: { matchType: 'folder', value: 'Blog' },
        effect: 'assign',
        defaultTarget: target
    })

    const facts = factsOf(NO_METADATA_EXCLUSIONS)

    it('refuses when the rule assigns an editor that cannot run', () => {
        // The vault has a perfectly working editor; the rule just does not use
        // it. A global "is any editor capable" answer would say yes here, and
        // then every dispatch would refuse with `no-editors`.
        const settings = makeSettings({
            editors: [makeEditor(), makeEditor({ id: 'editor-2', name: 'Off', enabled: false })],
            rules: [assignTo({ targetType: 'editor', targetId: 'editor-2' })]
        })
        expect(hasReviewCapableEditor(settings)).toBe(true)
        expect(reviewGate('Blog/Post.md', facts, settings)).toEqual({
            status: 'rule-target-unusable',
            ruleLabel: 'Blog'
        })
        expect(isReviewable('Blog/Post.md', facts, settings)).toBe(false)
        // The plugin still OPERATES on the note — transforms dispatch, the rail
        // shows — so the kill-switch projection stays true.
        expect(isPluginEnabledForNote('Blog/Post.md', facts, settings)).toBe(true)
        // A note the rule does not match keeps the default pool.
        expect(reviewGate('Notes/Other.md', facts, settings)).toEqual({ status: 'ok' })
    })

    it('refuses when the rule assigns a deleted editor, naming the rule', () => {
        const settings = makeSettings({
            rules: [assignTo({ targetType: 'editor', targetId: 'gone' })]
        })
        expect(reviewGate('Blog/Post.md', facts, settings)).toEqual({
            status: 'rule-target-unusable',
            ruleLabel: 'Blog'
        })
    })

    it('refuses when no member of the assigned panel can run', () => {
        const settings = makeSettings({
            editors: [
                makeEditor(),
                makeEditor({ id: 'editor-2', name: 'No review', capabilities: { review: false } })
            ],
            panels: [{ id: 'panel-1', name: 'Gate', memberEditorIds: ['editor-2'] }],
            rules: [assignTo({ targetType: 'panel', targetId: 'panel-1' })]
        })
        expect(reviewGate('Blog/Post.md', facts, settings)).toEqual({
            status: 'rule-target-unusable',
            ruleLabel: 'Blog'
        })
    })

    it('accepts when at least one assigned editor can run', () => {
        const settings = makeSettings({
            editors: [makeEditor({ id: 'editor-2', name: 'Off', enabled: false }), makeEditor()],
            panels: [{ id: 'panel-1', name: 'Gate', memberEditorIds: ['editor-2', 'editor-1'] }],
            rules: [assignTo({ targetType: 'panel', targetId: 'panel-1' })]
        })
        expect(reviewGate('Blog/Post.md', facts, settings)).toEqual({ status: 'ok' })
    })

    it('still reports the global case as no-editor when no rule matched', () => {
        const settings = makeSettings({
            editors: [makeEditor({ enabled: false })],
            rules: [assignTo({ targetType: 'editor', targetId: 'editor-1' })]
        })
        expect(reviewGate('Notes/Other.md', facts, settings)).toEqual({ status: 'no-editor' })
    })
})

// ---------------------------------------------------------------------------
// askablePanels (issue #27)
// ---------------------------------------------------------------------------

describe('askablePanels', () => {
    function panelSettings(panelOverrides: Record<string, unknown> = {}): PluginSettingsV1 {
        return makeSettings({
            editors: [makeEditor({ id: 'e1' }), makeEditor({ id: 'e2', name: 'Beginner' })],
            panels: [
                {
                    id: 'p1',
                    name: 'Publish panel',
                    memberEditorIds: ['e1', 'e2'],
                    aggregationBackend: { backendId: 'backend-1', model: '' },
                    enabled: true,
                    ...panelOverrides
                }
            ]
        })
    }

    it('offers an enabled panel with resolvable members, counting members + aggregation', () => {
        const panels = askablePanels(panelSettings())
        expect(panels).toEqual([{ id: 'p1', name: 'Publish panel', requestCount: 3 }])
    })

    it('one runnable member is enough — panel runs complete partially by design', () => {
        const settings = panelSettings({ memberEditorIds: ['e1', 'ghost'] })
        expect(askablePanels(settings)[0]?.requestCount).toBe(2)
    })

    it('hides disabled panels and panels whose members all fail to resolve', () => {
        expect(askablePanels(panelSettings({ enabled: false }))).toEqual([])
        expect(askablePanels(panelSettings({ memberEditorIds: ['ghost'] }))).toEqual([])
    })

    it('an unresolvable aggregation backend costs nothing — members still run', () => {
        const settings = panelSettings({
            aggregationBackend: { backendId: 'missing', model: '' }
        })
        expect(askablePanels(settings)[0]?.requestCount).toBe(2)
    })

    it('a duplicated member id does not inflate the request count (round-3 review)', () => {
        // Dispatch filters settings.editors by pool membership, so an editor
        // runs once no matter how often a panel lists it — the shown count
        // must match.
        const settings = panelSettings({ memberEditorIds: ['e1', 'e1', 'e2'] })
        expect(askablePanels(settings)[0]?.requestCount).toBe(3)
    })
})
