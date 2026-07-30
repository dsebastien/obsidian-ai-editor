import { describe, expect, it } from 'bun:test'
import {
    apiBackendSchema,
    editorConfigSchema,
    pluginSettingsSchema
} from '../domain/settings/settings-schema'
import type { ApiBackend, EditorConfig, PluginSettingsV1 } from '../domain/settings/settings-schema'
import type { NoteMetadata } from './context/vault-reader.intf'
import {
    hasReviewCapableEditor,
    isExcluded,
    isPluginEnabledForNote,
    isReviewable,
    reviewCapableEditors
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
