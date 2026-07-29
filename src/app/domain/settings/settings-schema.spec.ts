import { describe, expect, it } from 'bun:test'
import {
    DEFAULT_PLUGIN_SETTINGS,
    SETTINGS_SCHEMA_VERSION,
    checkReferentialIntegrity,
    loadSettings,
    loadSettingsDetailed,
    pluginSettingsSchema,
    type PluginSettingsV1
} from './settings-schema'

const parseSettings = (raw: unknown): PluginSettingsV1 => pluginSettingsSchema.parse(raw)

const validEditor = (id: string): Record<string, unknown> => ({ id, name: `Editor ${id}` })

const validApiBackend = (id: string): Record<string, unknown> => ({
    id,
    family: 'api',
    kind: 'anthropic',
    label: `Backend ${id}`
})

describe('DEFAULT_PLUGIN_SETTINGS', () => {
    it('carries the current schema version and empty entity lists', () => {
        expect(DEFAULT_PLUGIN_SETTINGS.schemaVersion).toEqual(SETTINGS_SCHEMA_VERSION)
        expect(DEFAULT_PLUGIN_SETTINGS.backends).toEqual([])
        expect(DEFAULT_PLUGIN_SETTINGS.editors).toEqual([])
        expect(DEFAULT_PLUGIN_SETTINGS.panels).toEqual([])
        expect(DEFAULT_PLUGIN_SETTINGS.actions).toEqual([])
        expect(DEFAULT_PLUGIN_SETTINGS.rules).toEqual([])
        expect(DEFAULT_PLUGIN_SETTINGS.defaultBackend).toBeNull()
    })

    it('defaults the first-run flags to false', () => {
        expect(DEFAULT_PLUGIN_SETTINGS.starterPackSeeded).toEqual(false)
        expect(DEFAULT_PLUGIN_SETTINGS.onboarded).toEqual(false)
    })

    it('defaults behavior to safe, documented values', () => {
        const behavior = DEFAULT_PLUGIN_SETTINGS.behavior
        expect(behavior.sizeWarningWords).toEqual(8_000)
        expect(behavior.maxConcurrentRequests).toEqual(3)
        expect(behavior.contextBudgetChars).toEqual(200_000)
        expect(behavior.excludedFolders).toEqual([])
        expect(behavior.excludedTags).toEqual([])
        expect(behavior.respectFrontmatterOptOut).toEqual(true)
        expect(behavior.stripFrontmatter).toEqual(false)
        expect(behavior.defaultCommentEditorId).toEqual('')
    })

    it('is itself schema-valid', () => {
        expect(pluginSettingsSchema.safeParse(DEFAULT_PLUGIN_SETTINGS).success).toEqual(true)
    })
})

describe('loadSettings', () => {
    it('roundtrips valid settings through JSON serialization', () => {
        const settings = parseSettings({
            backends: [validApiBackend('b1')],
            defaultBackend: { backendId: 'b1' },
            editors: [validEditor('e1')],
            panels: [{ id: 'p1', name: 'Panel', memberEditorIds: ['e1'] }],
            starterPackSeeded: true,
            onboarded: true
        })
        const loaded = loadSettings(JSON.parse(JSON.stringify(settings)))
        expect(loaded).toEqual(settings)
    })

    it('applies schema defaults to a minimal valid object', () => {
        const loaded = loadSettings({ editors: [validEditor('e1')] })
        expect(loaded.editors).toHaveLength(1)
        const editor = loaded.editors[0]
        expect(editor?.color).toEqual('var(--color-accent)')
        expect(editor?.enabled).toEqual(true)
        expect(editor?.capabilities).toEqual({ review: true, rewrite: true, research: false })
        expect(loaded.behavior).toEqual(DEFAULT_PLUGIN_SETTINGS.behavior)
    })

    it('falls back to defaults for garbage input', () => {
        expect(loadSettings(null)).toEqual(DEFAULT_PLUGIN_SETTINGS)
        expect(loadSettings(undefined)).toEqual(DEFAULT_PLUGIN_SETTINGS)
        expect(loadSettings(42)).toEqual(DEFAULT_PLUGIN_SETTINGS)
        expect(loadSettings('corrupt')).toEqual(DEFAULT_PLUGIN_SETTINGS)
        expect(loadSettings(true)).toEqual(DEFAULT_PLUGIN_SETTINGS)
    })

    it('falls back to defaults for an array (object-shaped but not settings)', () => {
        const loaded = loadSettings([validEditor('e1')])
        expect(loaded).toEqual(DEFAULT_PLUGIN_SETTINGS)
    })

    it('salvages valid sections when one section is corrupt', () => {
        const loaded = loadSettings({
            schemaVersion: 1,
            editors: [validEditor('e1')],
            backends: [validApiBackend('b1')],
            starterPackSeeded: true,
            behavior: { sizeWarningWords: 'many' }
        })
        expect(loaded.editors).toHaveLength(1)
        expect(loaded.editors[0]?.id).toEqual('e1')
        expect(loaded.backends).toHaveLength(1)
        expect(loaded.starterPackSeeded).toEqual(true)
        // Corrupt section falls back to defaults instead of wiping everything.
        expect(loaded.behavior).toEqual(DEFAULT_PLUGIN_SETTINGS.behavior)
    })

    it('drops only the corrupt entity inside an array section, never its siblings', () => {
        const loaded = loadSettings({
            editors: [validEditor('e1'), { id: '', name: '' }],
            panels: [{ id: 'p1', name: 'Panel', memberEditorIds: ['e1'] }]
        })
        // Salvage is per-entity: the invalid editor is dropped…
        expect(loaded.editors).toHaveLength(1)
        expect(loaded.editors[0]?.id).toEqual('e1')
        // …while everything else survives untouched.
        expect(loaded.panels).toHaveLength(1)
    })

    it('keeps a valid backend (and its API key) when a sibling backend is corrupt', () => {
        const loaded = loadSettingsDetailed({
            backends: [
                { ...validApiBackend('b1'), apiKey: 'sk-keep-me' },
                // Sync-conflict-truncated entry: label fails min(1).
                { ...validApiBackend('b2'), label: '' }
            ]
        })
        expect(loaded.settings.backends).toHaveLength(1)
        const kept = loaded.settings.backends[0]
        expect(kept?.id).toEqual('b1')
        expect(kept?.family === 'api' ? kept.apiKey : null).toEqual('sk-keep-me')
        expect(loaded.dropped).toEqual(['backends[1]'])
    })

    it('keeps a valid rule when a sibling rule has an empty match value', () => {
        const rule = (id: string, value: string): Record<string, unknown> => ({
            id,
            match: { matchType: 'folder', value },
            effect: 'assign'
        })
        const loaded = loadSettingsDetailed({ rules: [rule('r1', 'Blog'), rule('r2', '')] })
        expect(loaded.settings.rules).toHaveLength(1)
        expect(loaded.settings.rules[0]?.id).toEqual('r1')
        expect(loaded.dropped).toEqual(['rules[1]'])
    })

    it('keeps privacy exclusions when an unrelated behavior field is corrupt', () => {
        const loaded = loadSettingsDetailed({
            behavior: {
                // From a newer plugin version: above the current max.
                contextBudgetChars: 5_000_000,
                excludedFolders: ['Private'],
                excludedTags: ['secret'],
                respectFrontmatterOptOut: true
            }
        })
        expect(loaded.settings.behavior.excludedFolders).toEqual(['Private'])
        expect(loaded.settings.behavior.excludedTags).toEqual(['secret'])
        expect(loaded.settings.behavior.respectFrontmatterOptOut).toEqual(true)
        expect(loaded.settings.behavior.contextBudgetChars).toEqual(
            DEFAULT_PLUGIN_SETTINGS.behavior.contextBudgetChars
        )
        expect(loaded.dropped).toEqual(['behavior.contextBudgetChars'])
    })

    it('reports dropped sections and stays silent on clean loads', () => {
        expect(loadSettingsDetailed({}).dropped).toEqual([])
        expect(loadSettingsDetailed(null).dropped).toEqual(['(all settings)'])
        expect(loadSettingsDetailed({ rules: 'corrupt' }).dropped).toEqual(['rules'])
    })

    it('keeps flags and nullable sections during salvage', () => {
        const loaded = loadSettings({
            defaultBackend: { backendId: 'b1' },
            onboarded: true,
            rules: 'corrupt'
        })
        expect(loaded.defaultBackend?.backendId).toEqual('b1')
        expect(loaded.onboarded).toEqual(true)
        expect(loaded.rules).toEqual([])
    })

    it('never throws, whatever the input shape', () => {
        const inputs: unknown[] = [
            {},
            { schemaVersion: 999 },
            { editors: {} },
            { behavior: null },
            () => 'nope',
            Symbol('corrupt')
        ]
        for (const input of inputs) {
            expect(() => loadSettings(input)).not.toThrow()
        }
    })
})

describe('checkReferentialIntegrity', () => {
    it('returns no issues for default settings', () => {
        expect(checkReferentialIntegrity(DEFAULT_PLUGIN_SETTINGS)).toEqual([])
    })

    it('returns no issues when every reference resolves', () => {
        const settings = parseSettings({
            backends: [validApiBackend('b1')],
            defaultBackend: { backendId: 'b1' },
            editors: [{ ...validEditor('e1'), backend: { backendId: 'b1' } }],
            panels: [
                {
                    id: 'p1',
                    name: 'Panel',
                    memberEditorIds: ['e1'],
                    aggregationBackend: { backendId: 'b1' }
                }
            ],
            actions: [
                {
                    id: 'a1',
                    actionId: 'critique',
                    binding: { targetType: 'editor', targetId: 'e1' }
                }
            ],
            rules: [
                {
                    id: 'r1',
                    match: { matchType: 'tag', value: 'draft' },
                    effect: 'assign',
                    defaultTarget: { targetType: 'panel', targetId: 'p1' }
                }
            ],
            behavior: { defaultCommentEditorId: 'e1' }
        })
        expect(checkReferentialIntegrity(settings)).toEqual([])
    })

    it('reports a missing default backend', () => {
        const settings = parseSettings({ defaultBackend: { backendId: 'ghost' } })
        expect(checkReferentialIntegrity(settings)).toEqual([
            {
                entity: 'default-backend',
                entityId: 'default',
                missing: 'backend',
                missingId: 'ghost'
            }
        ])
    })

    it('reports an editor referencing a missing backend', () => {
        const settings = parseSettings({
            editors: [{ ...validEditor('e1'), backend: { backendId: 'ghost' } }]
        })
        expect(checkReferentialIntegrity(settings)).toEqual([
            { entity: 'editor', entityId: 'e1', missing: 'backend', missingId: 'ghost' }
        ])
    })

    it('reports every missing panel member', () => {
        const settings = parseSettings({
            editors: [validEditor('e1')],
            panels: [{ id: 'p1', name: 'Panel', memberEditorIds: ['e1', 'ghost-a', 'ghost-b'] }]
        })
        expect(checkReferentialIntegrity(settings)).toEqual([
            { entity: 'panel', entityId: 'p1', missing: 'editor', missingId: 'ghost-a' },
            { entity: 'panel', entityId: 'p1', missing: 'editor', missingId: 'ghost-b' }
        ])
    })

    it('reports a panel referencing a missing aggregation backend', () => {
        const settings = parseSettings({
            editors: [validEditor('e1')],
            panels: [
                {
                    id: 'p1',
                    name: 'Panel',
                    memberEditorIds: ['e1'],
                    aggregationBackend: { backendId: 'ghost' }
                }
            ]
        })
        expect(checkReferentialIntegrity(settings)).toEqual([
            { entity: 'panel', entityId: 'p1', missing: 'backend', missingId: 'ghost' }
        ])
    })

    it('reports an action bound to a missing editor target', () => {
        const settings = parseSettings({
            actions: [
                {
                    id: 'a1',
                    actionId: 'critique',
                    binding: { targetType: 'editor', targetId: 'ghost' }
                }
            ]
        })
        expect(checkReferentialIntegrity(settings)).toEqual([
            { entity: 'action', entityId: 'a1', missing: 'editor', missingId: 'ghost' }
        ])
    })

    it('reports an action bound to a missing panel target', () => {
        const settings = parseSettings({
            actions: [
                {
                    id: 'a1',
                    actionId: 'critique',
                    binding: { targetType: 'panel', targetId: 'ghost' }
                }
            ]
        })
        expect(checkReferentialIntegrity(settings)).toEqual([
            { entity: 'action', entityId: 'a1', missing: 'panel', missingId: 'ghost' }
        ])
    })

    it('reports a rule with a missing default target', () => {
        const settings = parseSettings({
            rules: [
                {
                    id: 'r1',
                    match: { matchType: 'folder', value: 'Blog/' },
                    effect: 'assign',
                    defaultTarget: { targetType: 'editor', targetId: 'ghost' }
                }
            ]
        })
        expect(checkReferentialIntegrity(settings)).toEqual([
            { entity: 'rule', entityId: 'r1', missing: 'editor', missingId: 'ghost' }
        ])
    })

    it('reports a missing default comment editor', () => {
        const settings = parseSettings({
            behavior: { defaultCommentEditorId: 'ghost' }
        })
        expect(checkReferentialIntegrity(settings)).toEqual([
            {
                entity: 'behavior',
                entityId: 'defaultCommentEditor',
                missing: 'editor',
                missingId: 'ghost'
            }
        ])
    })

    it('ignores unbound actions and rules (null targets are legal)', () => {
        const settings = parseSettings({
            actions: [{ id: 'a1', actionId: 'critique' }],
            rules: [
                {
                    id: 'r1',
                    match: { matchType: 'tag', value: 'private' },
                    effect: 'disabled'
                }
            ]
        })
        expect(checkReferentialIntegrity(settings)).toEqual([])
    })

    it('aggregates issues across entity kinds', () => {
        const settings = parseSettings({
            defaultBackend: { backendId: 'ghost-backend' },
            editors: [{ ...validEditor('e1'), backend: { backendId: 'ghost-backend' } }],
            panels: [{ id: 'p1', name: 'Panel', memberEditorIds: ['ghost-editor'] }],
            behavior: { defaultCommentEditorId: 'ghost-editor' }
        })
        const issues = checkReferentialIntegrity(settings)
        expect(issues).toHaveLength(4)
        expect(new Set(issues.map((issue) => issue.entity))).toEqual(
            new Set(['default-backend', 'editor', 'panel', 'behavior'])
        )
    })
})
