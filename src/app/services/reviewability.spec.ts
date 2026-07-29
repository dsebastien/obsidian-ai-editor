import { describe, expect, it } from 'bun:test'
import {
    apiBackendSchema,
    editorConfigSchema,
    pluginSettingsSchema
} from '../domain/settings/settings-schema'
import type { ApiBackend, EditorConfig, PluginSettingsV1 } from '../domain/settings/settings-schema'
import type { NoteMetadata } from './context/vault-reader.intf'
import { hasReviewCapableEditor, isExcluded, isReviewable } from './reviewability'

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
// isReviewable
// ---------------------------------------------------------------------------

describe('isReviewable', () => {
    it('is true for a non-excluded note with a dispatchable editor', () => {
        expect(isReviewable('Notes/idea.md', NO_METADATA_EXCLUSIONS, makeSettings())).toBe(true)
    })

    it('is false for a folder-excluded note', () => {
        const settings = makeSettings({
            behavior: { excludedFolders: ['Private'] }
        })
        expect(isReviewable('Private/journal.md', NO_METADATA_EXCLUSIONS, settings)).toBe(false)
    })

    it('is false for a tag-excluded note', () => {
        const settings = makeSettings({
            behavior: { excludedTags: ['private'] }
        })
        const metadata: NoteMetadata = { tags: ['#private/journal'], frontmatter: {} }
        expect(isReviewable('Notes/idea.md', metadata, settings)).toBe(false)
    })

    it('fails closed on null metadata when tag exclusions are configured', () => {
        const settings = makeSettings({
            behavior: { excludedTags: ['private'], respectFrontmatterOptOut: false }
        })
        expect(isReviewable('Notes/idea.md', null, settings)).toBe(false)
    })

    it('is false for a frontmatter opt-out note', () => {
        const metadata: NoteMetadata = { tags: [], frontmatter: { ai_editor: false } }
        expect(isReviewable('Notes/idea.md', metadata, makeSettings())).toBe(false)
    })

    it('is false when no editor can dispatch, even for an includable note', () => {
        const settings = makeSettings({ editors: [] })
        expect(isReviewable('Notes/idea.md', NO_METADATA_EXCLUSIONS, settings)).toBe(false)
    })

    it('re-exports isExcluded so surfaces need a single import', () => {
        expect(typeof isExcluded).toBe('function')
        const settings = makeSettings({ behavior: { excludedFolders: ['Private'] } })
        expect(isExcluded('Private/a.md', NO_METADATA_EXCLUSIONS, settings.behavior)).toBe(true)
    })
})
