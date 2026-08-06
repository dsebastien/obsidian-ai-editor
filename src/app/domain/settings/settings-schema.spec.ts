import { describe, expect, it } from 'bun:test'
import {
    DEFAULT_PLUGIN_SETTINGS,
    SETTINGS_SCHEMA_VERSION,
    actionBindingSchema,
    apiBackendSchema,
    behaviorSettingsSchema,
    checkReferentialIntegrity,
    editorConfigSchema,
    loadSettings,
    loadSettingsDetailed,
    panelConfigSchema,
    pluginSettingsSchema,
    promptSourceSchema,
    resolveIdCollisions,
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

    it('defaults follow-links ON for the voice profile and OFF everywhere else', () => {
        // Configuration.md § Settings tabs (follow links): the voice profile is the
        // motivating case for following referenced-note links; editor
        // prompts, panel charters, and custom instructions stay opt-in.
        expect(DEFAULT_PLUGIN_SETTINGS.voiceProfile.followLinks).toEqual(true)
        expect(promptSourceSchema.parse({}).followLinks).toEqual(false)
        expect(editorConfigSchema.parse(validEditor('e-1')).prompt.followLinks).toEqual(false)
        expect(
            panelConfigSchema.parse({
                id: 'p-1',
                name: 'Panel',
                memberEditorIds: ['e-1']
            }).charter.followLinks
        ).toEqual(false)
        expect(
            actionBindingSchema.parse({ id: 'a-1', actionId: 'rephrase' }).customInstruction
                .followLinks
        ).toEqual(false)
    })

    it('leaves a custom action without a verb class rather than guessing one', () => {
        // Guessing 'transform' would let "check this for errors" overwrite the
        // checked text; resolution refuses until the user picks a class.
        expect(actionBindingSchema.parse({ id: 'a-1', actionId: 'a-1' }).customVerbClass).toBeNull()
        expect(
            actionBindingSchema.parse({ id: 'a-1', actionId: 'a-1', customVerbClass: 'review' })
                .customVerbClass
        ).toEqual('review')
        expect(
            actionBindingSchema.safeParse({
                id: 'a-1',
                actionId: 'a-1',
                customVerbClass: 'nonsense'
            }).success
        ).toBe(false)
    })

    it('defaults the first-run markers to never-seeded and not-onboarded', () => {
        expect(DEFAULT_PLUGIN_SETTINGS.starterPackVersion).toEqual(0)
        expect(DEFAULT_PLUGIN_SETTINGS.onboarded).toEqual(false)
    })

    it('defaults behavior to safe, documented values', () => {
        const behavior = DEFAULT_PLUGIN_SETTINGS.behavior
        expect(behavior.sizeWarningWords).toEqual(8_000)
        expect(behavior.maxConcurrentRequests).toEqual(3)
        expect(behavior.requestTimeoutSeconds).toEqual(600)
        expect(behavior.contextBudgetChars).toEqual(200_000)
        expect(behavior.excludedFolders).toEqual([])
        expect(behavior.excludedTags).toEqual([])
        expect(behavior.respectFrontmatterOptOut).toEqual(true)
        expect(behavior.stripFrontmatter).toEqual(false)
        expect(behavior.defaultCommentEditorId).toEqual('')
        // Always-on daemon is off by default (Business Rule #1: automatic
        // runs only after the user explicitly enabled them; daemon mode
        // itself is per-note runtime state defaulting off) — cost control.
        expect(behavior.daemonAlwaysOn).toEqual(false)
        // Short by design (issue #20): any interaction resets the window,
        // which is what makes 3 s safe.
        expect(behavior.daemonIdleSeconds).toEqual(3)
    })

    it('bounds the request timeout to 30-3600 seconds, integers only', () => {
        const parse = (requestTimeoutSeconds: unknown) =>
            behaviorSettingsSchema.safeParse({ requestTimeoutSeconds }).success
        expect(parse(30)).toEqual(true)
        expect(parse(3_600)).toEqual(true)
        expect(parse(29)).toEqual(false)
        expect(parse(3_601)).toEqual(false)
        expect(parse(90.5)).toEqual(false)
    })

    it('bounds the daemon idle delay to 1-600 seconds, integers only', () => {
        const parse = (daemonIdleSeconds: unknown) =>
            behaviorSettingsSchema.safeParse({ daemonIdleSeconds }).success
        expect(parse(1)).toEqual(true)
        expect(parse(600)).toEqual(true)
        expect(parse(0)).toEqual(false)
        expect(parse(601)).toEqual(false)
        expect(parse(30.5)).toEqual(false)
    })

    it('is itself schema-valid', () => {
        expect(pluginSettingsSchema.safeParse(DEFAULT_PLUGIN_SETTINGS).success).toEqual(true)
    })

    it('defaults API backend thinking settings to off/provider-default', () => {
        const backend = apiBackendSchema.parse(validApiBackend('b1'))
        expect(backend.thinking).toEqual('off')
        expect(backend.thinkingBudgetTokens).toEqual(8_192)
        expect(backend.reasoningEffort).toEqual('default')
        expect(backend.extraBodyJson).toEqual('')
    })

    it('bounds the thinking budget to 1024-32000 tokens, integers only', () => {
        const parse = (thinkingBudgetTokens: unknown) =>
            apiBackendSchema.safeParse({ ...validApiBackend('b1'), thinkingBudgetTokens }).success
        expect(parse(1_024)).toEqual(true)
        expect(parse(32_000)).toEqual(true)
        expect(parse(1_023)).toEqual(false)
        expect(parse(32_001)).toEqual(false)
        expect(parse(2_048.5)).toEqual(false)
    })

    it('restricts thinking and reasoning effort to their enums', () => {
        const base = validApiBackend('b1')
        expect(apiBackendSchema.safeParse({ ...base, thinking: 'on' }).success).toEqual(true)
        expect(apiBackendSchema.safeParse({ ...base, thinking: 'budget' }).success).toEqual(true)
        expect(apiBackendSchema.safeParse({ ...base, thinking: 'auto' }).success).toEqual(false)
        for (const effort of ['default', 'minimal', 'low', 'medium', 'high']) {
            expect(
                apiBackendSchema.safeParse({ ...base, reasoningEffort: effort }).success
            ).toEqual(true)
        }
        expect(apiBackendSchema.safeParse({ ...base, reasoningEffort: 'xhigh' }).success).toEqual(
            false
        )
    })
})

describe('loadSettings', () => {
    it('roundtrips valid settings through JSON serialization', () => {
        const settings = parseSettings({
            backends: [validApiBackend('b1')],
            defaultBackend: { backendId: 'b1' },
            editors: [validEditor('e1')],
            panels: [{ id: 'p1', name: 'Panel', memberEditorIds: ['e1'] }],
            starterPackVersion: 2,
            onboarded: true
        })
        const loaded = loadSettings(JSON.parse(JSON.stringify(settings)))
        expect(loaded).toEqual(settings)
    })

    it('reads the retired starterPackSeeded boolean as pack revision 1', () => {
        // A ≤0.3.x vault persisted `starterPackSeeded: true`; without the
        // mapping the happy path strips the unknown key and the original six
        // personas would seed AGAIN on the next load.
        const loaded = loadSettings({ starterPackSeeded: true, onboarded: true })
        expect(loaded.starterPackVersion).toEqual(1)
        // The legacy flag never wins over an explicit version.
        const explicit = loadSettings({ starterPackSeeded: true, starterPackVersion: 2 })
        expect(explicit.starterPackVersion).toEqual(2)
        // And a legacy `false` means what it always meant: never seeded.
        const unseeded = loadSettings({ starterPackSeeded: false })
        expect(unseeded.starterPackVersion).toEqual(0)
        // A CORRUPT version must not outrank the legacy flag: salvage drops
        // the corrupt value, and if its mere presence suppressed the mapping,
        // the vault would read as never-seeded and revision 1 would resurrect
        // starters the user deleted (adversarial review, 2026-08-05).
        const corrupt = loadSettingsDetailed({
            starterPackSeeded: true,
            starterPackVersion: 'corrupt'
        })
        expect(corrupt.settings.starterPackVersion).toEqual(1)
    })

    it('reads the retired global daemonMode flag as daemonAlwaysOn', () => {
        // A pre-per-note vault persisted `behavior.daemonMode: true` — the
        // user had opted into automatic refreshes everywhere. Without the
        // mapping the schema strips the unknown key and their refreshes
        // silently stop on upgrade; always-on preserves the behavior.
        const loaded = loadSettings({ behavior: { daemonMode: true } })
        expect(loaded.behavior.daemonAlwaysOn).toEqual(true)
        // The legacy flag never wins over an explicit daemonAlwaysOn.
        const explicit = loadSettings({
            behavior: { daemonMode: true, daemonAlwaysOn: false }
        })
        expect(explicit.behavior.daemonAlwaysOn).toEqual(false)
        // And a legacy `false` maps to the default: off.
        const off = loadSettings({ behavior: { daemonMode: false } })
        expect(off.behavior.daemonAlwaysOn).toEqual(false)
        // The mapping also survives the salvage path (corrupt sibling
        // scalar): the behavior section keeps every individually-valid
        // field, daemonAlwaysOn included.
        const salvaged = loadSettingsDetailed({
            behavior: { daemonMode: true, sizeWarningWords: 'corrupt' }
        })
        expect(salvaged.settings.behavior.daemonAlwaysOn).toEqual(true)
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
            starterPackVersion: 2,
            behavior: { sizeWarningWords: 'many' }
        })
        expect(loaded.editors).toHaveLength(1)
        expect(loaded.editors[0]?.id).toEqual('e1')
        expect(loaded.backends).toHaveLength(1)
        expect(loaded.starterPackVersion).toEqual(2)
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

describe('resolveIdCollisions', () => {
    it('returns the same object when every id is unique', () => {
        const settings = parseSettings({
            backends: [validApiBackend('b1'), validApiBackend('b2')],
            editors: [validEditor('e1')],
            panels: [{ id: 'p1', name: 'Panel', memberEditorIds: ['e1'] }]
        })
        const resolution = resolveIdCollisions(settings)
        expect(resolution.settings).toBe(settings)
        expect(resolution.regenerated).toEqual([])
    })

    it('keeps the first duplicate and regenerates the later one within an array', () => {
        const settings = parseSettings({
            backends: [
                { ...validApiBackend('dup'), label: 'First', apiKey: 'key-first' },
                { ...validApiBackend('dup'), label: 'Second', apiKey: 'key-second' }
            ],
            defaultBackend: { backendId: 'dup' }
        })
        const resolution = resolveIdCollisions(settings, () => 'fresh-id')
        expect(resolution.regenerated).toEqual(['backends[1]'])
        expect(resolution.settings.backends[0]?.id).toEqual('dup')
        expect(resolution.settings.backends[0]?.label).toEqual('First')
        expect(resolution.settings.backends[1]?.id).toEqual('fresh-id')
        expect(resolution.settings.backends[1]?.label).toEqual('Second')
        // References keep resolving to the entity first-match lookups picked.
        expect(resolution.settings.defaultBackend?.backendId).toEqual('dup')
        expect(checkReferentialIntegrity(resolution.settings)).toEqual([])
    })

    it('enforces uniqueness across entity arrays', () => {
        const settings = parseSettings({
            backends: [validApiBackend('shared')],
            editors: [validEditor('shared')]
        })
        const resolution = resolveIdCollisions(settings, () => 'fresh-id')
        expect(resolution.regenerated).toEqual(['editors[0]'])
        expect(resolution.settings.backends[0]?.id).toEqual('shared')
        expect(resolution.settings.editors[0]?.id).toEqual('fresh-id')
    })

    it('retries generation until the fresh id is itself unique', () => {
        const settings = parseSettings({
            editors: [validEditor('e1'), validEditor('e1')]
        })
        const candidates = ['e1', 'e2']
        const resolution = resolveIdCollisions(settings, () => candidates.shift() ?? 'e3')
        expect(resolution.settings.editors[1]?.id).toEqual('e2')
    })
})

describe('loadSettingsDetailed id collisions', () => {
    it('repairs duplicated ids on a clean parse and reports them', () => {
        const raw = {
            schemaVersion: SETTINGS_SCHEMA_VERSION,
            editors: [validEditor('dup'), validEditor('dup')]
        }
        const loaded = loadSettingsDetailed(raw)
        expect(loaded.regeneratedIds).toEqual(['editors[1]'])
        expect(loaded.dropped).toEqual([])
        const ids = loaded.settings.editors.map((editor) => editor.id)
        expect(new Set(ids).size).toEqual(2)
    })

    it('repairs duplicated ids that survive a salvage load', () => {
        const raw = {
            schemaVersion: SETTINGS_SCHEMA_VERSION,
            editors: [validEditor('dup'), validEditor('dup')],
            // Corrupt scalar forces the salvage path.
            starterPackVersion: 'not-a-number'
        }
        const loaded = loadSettingsDetailed(raw)
        expect(loaded.dropped).toContain('starterPackVersion')
        expect(loaded.regeneratedIds).toEqual(['editors[1]'])
        const ids = loaded.settings.editors.map((editor) => editor.id)
        expect(new Set(ids).size).toEqual(2)
    })

    it('reports no regenerated ids on a clean load', () => {
        const loaded = loadSettingsDetailed({ schemaVersion: SETTINGS_SCHEMA_VERSION })
        expect(loaded.regeneratedIds).toEqual([])
    })
})
