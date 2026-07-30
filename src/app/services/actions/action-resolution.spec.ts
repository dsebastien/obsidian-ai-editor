import { describe, expect, it } from 'bun:test'
import {
    actionBindingSchema,
    apiBackendSchema,
    editorConfigSchema,
    panelConfigSchema,
    pluginSettingsSchema
} from '../../domain/settings/settings-schema'
import type {
    ActionBinding,
    ApiBackend,
    EditorConfig,
    PanelConfig,
    PluginSettingsV1
} from '../../domain/settings/settings-schema'
import { FOLLOWED_LINKS_CAP } from '../context/context-assembler'
import type { NoteMetadata, VaultReader } from '../context/vault-reader.intf'
import {
    CUSTOM_INSTRUCTION_MAX_CHARS,
    actionInvalidReasonLabel,
    resolveActionBinding,
    resolveActionById,
    resolveActions,
    resolveCustomInstruction
} from './action-resolution'

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
        name: 'Concision Editor',
        ...overrides
    })
}

function makePanel(overrides: Record<string, unknown> = {}): PanelConfig {
    return panelConfigSchema.parse({
        id: 'panel-1',
        name: 'Pre-publish review',
        memberEditorIds: ['editor-1'],
        ...overrides
    })
}

function makeBinding(overrides: Record<string, unknown> = {}): ActionBinding {
    return actionBindingSchema.parse({
        id: 'humanize',
        actionId: 'humanize',
        binding: { targetType: 'editor', targetId: 'editor-1' },
        ...overrides
    })
}

function makeSettings(overrides: Record<string, unknown> = {}): PluginSettingsV1 {
    return pluginSettingsSchema.parse({
        backends: [makeBackend()],
        defaultBackend: { backendId: 'backend-1', model: '' },
        editors: [makeEditor()],
        actions: [makeBinding()],
        ...overrides
    })
}

class FakeVault implements VaultReader {
    readonly notes = new Map<string, string>()
    readonly metadata = new Map<string, NoteMetadata>()
    readonly noteTypeIds = new Map<string, readonly string[]>()
    readonly links = new Map<string, readonly string[]>()
    readonly reads: string[] = []

    async readNote(path: string): Promise<string | null> {
        this.reads.push(path)
        return this.notes.get(path) ?? null
    }

    resolveLink(): string | null {
        return null
    }

    getOutgoingLinks(path: string): string[] {
        return [...(this.links.get(path) ?? [])]
    }

    getNoteMetadata(path: string): NoteMetadata | null {
        return this.metadata.get(path) ?? { tags: [], frontmatter: {} }
    }

    getNoteTypeIds(path: string): readonly string[] {
        return this.noteTypeIds.get(path) ?? []
    }
}

function expectInvalid(resolution: ReturnType<typeof resolveActionBinding>, reason: string): void {
    if (resolution.ok) {
        throw new Error(`Expected invalid (${reason}), got a resolved action`)
    }
    expect(resolution.reason).toBe(reason as never)
}

// ---------------------------------------------------------------------------
// resolveActionBinding — built-in verbs on editor targets
// ---------------------------------------------------------------------------

describe('resolveActionBinding', () => {
    it('resolves a built-in transform verb bound to a dispatchable editor', () => {
        const resolution = resolveActionBinding(makeSettings(), makeBinding())
        if (!resolution.ok) {
            throw new Error(`Expected ok, got ${resolution.reason}`)
        }
        expect(resolution.action).toEqual({
            bindingId: 'humanize',
            actionId: 'humanize',
            label: 'Humanize',
            verbClass: 'transform',
            kind: 'built-in',
            editorIds: ['editor-1'],
            panelId: null,
            panelName: null
        })
    })

    it('classifies generate and review verbs from the registry', () => {
        const settings = makeSettings()
        const generate = resolveActionBinding(
            settings,
            makeBinding({ id: 'continue', actionId: 'continue' })
        )
        const review = resolveActionBinding(
            settings,
            makeBinding({ id: 'critique', actionId: 'critique' })
        )
        expect(generate.ok && generate.action.verbClass).toBe('generate')
        expect(generate.ok && generate.action.label).toBe('Continue writing')
        expect(review.ok && review.action.verbClass).toBe('review')
    })

    it('refuses an unbound action', () => {
        expectInvalid(
            resolveActionBinding(makeSettings(), makeBinding({ binding: null })),
            'unbound'
        )
    })

    it('refuses a missing, disabled, or backend-less editor target', () => {
        const missing = resolveActionBinding(
            makeSettings(),
            makeBinding({ binding: { targetType: 'editor', targetId: 'ghost' } })
        )
        expectInvalid(missing, 'target-missing')

        const disabled = resolveActionBinding(
            makeSettings({ editors: [makeEditor({ enabled: false })] }),
            makeBinding()
        )
        expectInvalid(disabled, 'target-disabled')

        const noBackend = resolveActionBinding(
            makeSettings({ defaultBackend: null }),
            makeBinding()
        )
        expectInvalid(noBackend, 'backend-unusable')
    })

    it('checks the rewrite capability for transform/generate and review for review-class', () => {
        const noRewrite = makeSettings({
            editors: [
                makeEditor({ capabilities: { review: true, rewrite: false, research: false } })
            ]
        })
        expectInvalid(resolveActionBinding(noRewrite, makeBinding()), 'no-capability')
        expectInvalid(
            resolveActionBinding(noRewrite, makeBinding({ id: 'continue', actionId: 'continue' })),
            'no-capability'
        )
        // Review-class verbs need review, not rewrite.
        const reviewOk = resolveActionBinding(
            noRewrite,
            makeBinding({ id: 'critique', actionId: 'critique' })
        )
        expect(reviewOk.ok).toBe(true)

        const noReview = makeSettings({
            editors: [
                makeEditor({ capabilities: { review: false, rewrite: true, research: false } })
            ]
        })
        expectInvalid(
            resolveActionBinding(noReview, makeBinding({ id: 'critique', actionId: 'critique' })),
            'no-capability'
        )
    })

    // -- Panels -------------------------------------------------------------

    it('fans a review-class verb bound to a panel out to every member editor', () => {
        const settings = makeSettings({
            editors: [makeEditor(), makeEditor({ id: 'editor-2', name: 'Mentor' })],
            panels: [makePanel({ memberEditorIds: ['editor-1', 'editor-2'] })]
        })
        const resolution = resolveActionBinding(
            settings,
            makeBinding({
                id: 'critique',
                actionId: 'critique',
                binding: { targetType: 'panel', targetId: 'panel-1' }
            })
        )
        if (!resolution.ok) {
            throw new Error(`Expected ok, got ${resolution.reason}`)
        }
        expect(resolution.action.editorIds).toEqual(['editor-1', 'editor-2'])
    })

    it('keeps undispatchable members in the panel fan-out (the run reports them as skips)', () => {
        const settings = makeSettings({
            editors: [
                makeEditor(),
                makeEditor({
                    id: 'editor-2',
                    name: 'Broken',
                    backend: { backendId: 'ghost', model: '' }
                })
            ],
            panels: [makePanel({ memberEditorIds: ['editor-1', 'editor-2'] })]
        })
        const resolution = resolveActionBinding(
            settings,
            makeBinding({
                id: 'critique',
                actionId: 'critique',
                binding: { targetType: 'panel', targetId: 'panel-1' }
            })
        )
        expect(resolution.ok && resolution.action.editorIds).toEqual(['editor-1', 'editor-2'])
    })

    it('carries the panel NAME, so every surface offering the action can say so', () => {
        // Business Rules #11: the menu item and the palette command have to
        // announce that this verb convenes a panel, and one lookup here beats
        // four surfaces each finding the name for themselves.
        const settings = makeSettings({
            editors: [makeEditor()],
            panels: [makePanel({ name: 'Pre-publish review', memberEditorIds: ['editor-1'] })]
        })
        const resolution = resolveActionBinding(
            settings,
            makeBinding({
                id: 'critique',
                actionId: 'critique',
                binding: { targetType: 'panel', targetId: 'panel-1' }
            })
        )
        if (!resolution.ok) {
            throw new Error(`Expected ok, got ${resolution.reason}`)
        }
        expect(resolution.action.panelId).toBe('panel-1')
        expect(resolution.action.panelName).toBe('Pre-publish review')
    })

    it('refuses a panel binding on transform and generate verbs', () => {
        const settings = makeSettings({ panels: [makePanel()] })
        for (const actionId of ['humanize', 'continue']) {
            expectInvalid(
                resolveActionBinding(
                    settings,
                    makeBinding({
                        id: actionId,
                        actionId,
                        binding: { targetType: 'panel', targetId: 'panel-1' }
                    })
                ),
                'panel-binding-invalid'
            )
        }
    })

    it('refuses a missing, disabled, or fully-undispatchable panel', () => {
        const critiqueOnPanel = (
            settings: PluginSettingsV1
        ): ReturnType<typeof resolveActionBinding> =>
            resolveActionBinding(
                settings,
                makeBinding({
                    id: 'critique',
                    actionId: 'critique',
                    binding: { targetType: 'panel', targetId: 'panel-1' }
                })
            )
        expectInvalid(critiqueOnPanel(makeSettings()), 'target-missing')
        expectInvalid(
            critiqueOnPanel(makeSettings({ panels: [makePanel({ enabled: false })] })),
            'target-disabled'
        )
        expectInvalid(
            critiqueOnPanel(
                makeSettings({
                    editors: [makeEditor({ enabled: false })],
                    panels: [makePanel()]
                })
            ),
            'no-dispatchable-member'
        )
        // A member id pointing at no editor at all cannot dispatch either.
        expectInvalid(
            critiqueOnPanel(
                makeSettings({
                    editors: [makeEditor()],
                    panels: [makePanel({ memberEditorIds: ['ghost'] })]
                })
            ),
            'no-dispatchable-member'
        )
    })

    // -- Custom actions -----------------------------------------------------

    it('resolves a custom action with its own class, labeled by its name', () => {
        const settings = makeSettings({
            actions: [
                makeBinding({
                    id: 'custom-1',
                    actionId: 'custom-1',
                    customName: '  Make checklist  ',
                    customVerbClass: 'transform',
                    customInstruction: {
                        text: 'Turn the selection into a checklist.',
                        notePaths: [],
                        followLinks: false
                    }
                })
            ]
        })
        const resolution = resolveActionBinding(settings, settings.actions[0] as ActionBinding)
        if (!resolution.ok) {
            throw new Error(`Expected ok, got ${resolution.reason}`)
        }
        expect(resolution.action.kind).toBe('custom')
        expect(resolution.action.verbClass).toBe('transform')
        expect(resolution.action.label).toBe('Make checklist')
    })

    it('carries a custom generate class through to the resolved action', () => {
        const binding = makeBinding({
            id: 'custom-1',
            actionId: 'custom-1',
            customName: 'Draft a counter-argument',
            customVerbClass: 'generate',
            customInstruction: { text: 'Argue the other side.', notePaths: [], followLinks: false }
        })
        const resolution = resolveActionBinding(makeSettings(), binding)
        if (!resolution.ok) {
            throw new Error(`Expected ok, got ${resolution.reason}`)
        }
        expect(resolution.action.verbClass).toBe('generate')
    })

    it('refuses a custom action whose class was never picked', () => {
        const noClass = makeBinding({
            id: 'custom-1',
            actionId: 'custom-1',
            customName: 'Named',
            customInstruction: { text: 'Do it.', notePaths: [], followLinks: false }
        })
        expect(noClass.customVerbClass).toBeNull()
        expectInvalid(resolveActionBinding(makeSettings(), noClass), 'custom-class-missing')
    })

    it('lets a review-class custom action target a panel, fanning out to its members', () => {
        const settings = makeSettings({
            editors: [makeEditor(), makeEditor({ id: 'editor-2', name: 'Hater' })],
            panels: [makePanel({ memberEditorIds: ['editor-1', 'editor-2'] })]
        })
        const resolution = resolveActionBinding(
            settings,
            makeBinding({
                id: 'custom-1',
                actionId: 'custom-1',
                customName: 'Check the numbers',
                customVerbClass: 'review',
                customInstruction: {
                    text: 'Flag every unsupported number.',
                    notePaths: [],
                    followLinks: false
                },
                binding: { targetType: 'panel', targetId: 'panel-1' }
            })
        )
        if (!resolution.ok) {
            throw new Error(`Expected ok, got ${resolution.reason}`)
        }
        expect(resolution.action.verbClass).toBe('review')
        expect(resolution.action.editorIds).toEqual(['editor-1', 'editor-2'])
    })

    it('requires the review capability for a review-class custom action', () => {
        const settings = makeSettings({
            editors: [
                makeEditor({ capabilities: { review: false, rewrite: true, research: false } })
            ]
        })
        expectInvalid(
            resolveActionBinding(
                settings,
                makeBinding({
                    id: 'custom-1',
                    actionId: 'custom-1',
                    customName: 'Check the numbers',
                    customVerbClass: 'review',
                    customInstruction: { text: 'Flag them.', notePaths: [], followLinks: false }
                })
            ),
            'no-capability'
        )
    })

    it('refuses a custom action without a name or without instruction content', () => {
        const noName = makeBinding({
            id: 'custom-1',
            actionId: 'custom-1',
            customName: '   ',
            customVerbClass: 'transform',
            customInstruction: { text: 'Do it.', notePaths: [], followLinks: false }
        })
        expectInvalid(resolveActionBinding(makeSettings(), noName), 'blank-custom')
        const noInstruction = makeBinding({
            id: 'custom-2',
            actionId: 'custom-2',
            customName: 'Named',
            customVerbClass: 'transform',
            customInstruction: { text: '  ', notePaths: [], followLinks: false }
        })
        expectInvalid(resolveActionBinding(makeSettings(), noInstruction), 'blank-custom')
        // Note refs alone are enough instruction content.
        const notesOnly = makeBinding({
            id: 'custom-3',
            actionId: 'custom-3',
            customName: 'Named',
            customVerbClass: 'transform',
            customInstruction: { text: '', notePaths: ['Style.md'], followLinks: false }
        })
        expect(resolveActionBinding(makeSettings(), notesOnly).ok).toBe(true)
    })

    it('refuses a non-review custom action bound to a panel', () => {
        const settings = makeSettings({ panels: [makePanel()] })
        for (const customVerbClass of ['transform', 'generate'] as const) {
            expectInvalid(
                resolveActionBinding(
                    settings,
                    makeBinding({
                        id: 'custom-1',
                        actionId: 'custom-1',
                        customName: 'Named',
                        customVerbClass,
                        customInstruction: { text: 'Do it.', notePaths: [], followLinks: false },
                        binding: { targetType: 'panel', targetId: 'panel-1' }
                    })
                ),
                'panel-binding-invalid'
            )
        }
    })
})

// ---------------------------------------------------------------------------
// resolveActions / resolveActionById
// ---------------------------------------------------------------------------

describe('resolveActions', () => {
    it('returns only dispatchable actions, in settings order', () => {
        const settings = makeSettings({
            actions: [
                makeBinding({ id: 'humanize', actionId: 'humanize' }),
                makeBinding({ id: 'rephrase', actionId: 'rephrase', binding: null }),
                makeBinding({ id: 'critique', actionId: 'critique' })
            ]
        })
        expect(resolveActions(settings).map((action) => action.bindingId)).toEqual([
            'humanize',
            'critique'
        ])
    })

    it('resolveActionById returns null for unknown and undispatchable bindings', () => {
        const settings = makeSettings({
            actions: [makeBinding({ id: 'rephrase', actionId: 'rephrase', binding: null })]
        })
        expect(resolveActionById(settings, 'ghost')).toBeNull()
        expect(resolveActionById(settings, 'rephrase')).toBeNull()
        const ok = makeSettings()
        expect(resolveActionById(ok, 'humanize')?.label).toBe('Humanize')
    })
})

// ---------------------------------------------------------------------------
// actionInvalidReasonLabel
// ---------------------------------------------------------------------------

describe('actionInvalidReasonLabel', () => {
    it('has a non-empty label for every reason', () => {
        const reasons = [
            'unbound',
            'blank-custom',
            'custom-class-missing',
            'panel-binding-invalid',
            'target-missing',
            'target-disabled',
            'no-capability',
            'backend-unusable',
            'no-dispatchable-member'
        ] as const
        for (const reason of reasons) {
            expect(actionInvalidReasonLabel(reason).length).toBeGreaterThan(0)
        }
    })
})

// ---------------------------------------------------------------------------
// resolveCustomInstruction
// ---------------------------------------------------------------------------

describe('resolveCustomInstruction', () => {
    const behavior = makeSettings().behavior

    it('joins direct text and referenced notes as delimited blocks, deduped', async () => {
        const vault = new FakeVault()
        vault.notes.set('Style.md', 'Prefer short sentences.')
        const result = await resolveCustomInstruction(
            {
                text: 'Rewrite per the style guide.',
                notePaths: ['Style.md', 'Style.md', 'Missing.md'],
                followLinks: false
            },
            vault,
            behavior
        )
        expect(result).toBe(
            'Rewrite per the style guide.\n\n<instruction-note path="Style.md">\nPrefer short sentences.\n</instruction-note>'
        )
    })

    it('never reads excluded notes (Business Rules #7)', async () => {
        const vault = new FakeVault()
        vault.notes.set('Private/Style.md', 'secret content')
        const excluding = { ...behavior, excludedFolders: ['Private'] }
        const result = await resolveCustomInstruction(
            { text: 'Rewrite.', notePaths: ['Private/Style.md'], followLinks: false },
            vault,
            excluding
        )
        expect(result).toBe('Rewrite.')
        expect(result).not.toContain('secret content')
    })

    it('follows the links of referenced notes when the source opts in', async () => {
        const vault = new FakeVault()
        vault.notes.set('Style.md', 'Root guide.')
        vault.notes.set('Tone.md', 'Linked tone note.')
        vault.links.set('Style.md', ['Tone.md'])
        const source = { text: 'Rewrite.', notePaths: ['Style.md'], followLinks: true }
        const followed = await resolveCustomInstruction(source, vault, behavior)
        expect(followed).toContain('path="Style.md"')
        expect(followed).toContain('Linked tone note.')
        // Same source with the toggle off inlines the root only.
        const notFollowed = await resolveCustomInstruction(
            { ...source, followLinks: false },
            vault,
            behavior
        )
        expect(notFollowed).not.toContain('Linked tone note.')
    })

    it('never follows an excluded note and never inlines an excluded link', async () => {
        const vault = new FakeVault()
        vault.notes.set('Private/Style.md', 'root secret')
        vault.notes.set('Leak.md', 'leaked from a private note')
        vault.notes.set('Style.md', 'Root guide.')
        vault.notes.set('Private/Tone.md', 'private tone')
        vault.links.set('Private/Style.md', ['Leak.md'])
        vault.links.set('Style.md', ['Private/Tone.md'])
        const result = await resolveCustomInstruction(
            {
                text: 'Rewrite.',
                notePaths: ['Private/Style.md', 'Style.md'],
                followLinks: true
            },
            vault,
            { ...behavior, excludedFolders: ['Private'] }
        )
        expect(result).not.toContain('root secret')
        expect(result).not.toContain('leaked from a private note')
        expect(result).not.toContain('private tone')
        expect(result).toContain('Root guide.')
        // Excluded notes are decided before any read, not filtered after.
        expect(vault.reads).toEqual(['Style.md'])
    })

    it('caps followed links per referenced note and inlines each note once', async () => {
        const vault = new FakeVault()
        vault.notes.set('Style.md', 'Root guide.')
        const linked: string[] = []
        for (let index = 0; index < FOLLOWED_LINKS_CAP + 5; index++) {
            const path = `Linked-${index}.md`
            linked.push(path)
            vault.notes.set(path, `content ${index}`)
        }
        // The last link is also the root, and a duplicate of an earlier link.
        vault.links.set('Style.md', [...linked, ...linked, 'Style.md'])
        const result = await resolveCustomInstruction(
            { text: '', notePaths: ['Style.md'], followLinks: true },
            vault,
            behavior
        )
        // 1 root + exactly FOLLOWED_LINKS_CAP followed notes, no repeats.
        expect(vault.reads.length).toBe(FOLLOWED_LINKS_CAP + 1)
        expect(new Set(vault.reads).size).toBe(vault.reads.length)
        expect(result).toContain('content 0')
        expect(result).not.toContain(`content ${FOLLOWED_LINKS_CAP}`)
    })

    it('truncates to the operation contract instruction cap', async () => {
        const vault = new FakeVault()
        vault.notes.set('Big.md', 'x'.repeat(2 * CUSTOM_INSTRUCTION_MAX_CHARS))
        const result = await resolveCustomInstruction(
            { text: 'Rewrite.', notePaths: ['Big.md'], followLinks: false },
            vault,
            behavior
        )
        expect(result.length).toBe(CUSTOM_INSTRUCTION_MAX_CHARS)
    })
})
