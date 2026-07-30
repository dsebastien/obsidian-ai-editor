import { describe, expect, it } from 'bun:test'
import { SETTINGS_SCHEMA_VERSION, pluginSettingsSchema } from './settings-schema'
import type { PluginSettingsV1 } from './settings-schema'
import {
    ALL_SECTIONS,
    EXPORT_FORMAT,
    TRANSFER_SECTIONS,
    applyImportPlan,
    exportCounts,
    exportSecretRisks,
    exportSettings,
    exportSettingsJson,
    importPlanIsEmpty,
    planImport,
    planImportFromJson,
    sectionCountLabel
} from './settings-transfer'
import type { SettingsImportPlan, TransferSelection } from './settings-transfer'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const apiBackend = (id: string, apiKey = 'sk-secret'): Record<string, unknown> => ({
    id,
    family: 'api',
    kind: 'anthropic',
    label: `Backend ${id}`,
    apiKey
})

const settingsOf = (overrides: Record<string, unknown> = {}): PluginSettingsV1 =>
    pluginSettingsSchema.parse(overrides)

/** A fully populated configuration: one of everything, all cross-referenced. */
const populated = (): PluginSettingsV1 =>
    settingsOf({
        backends: [apiBackend('b1'), { id: 'b2', family: 'cli', kind: 'codex', label: 'Codex' }],
        defaultBackend: { backendId: 'b1', model: '' },
        editors: [
            { id: 'e1', name: 'Concision', backend: { backendId: 'b1', model: 'sonnet' } },
            { id: 'e2', name: 'Hater' }
        ],
        panels: [
            {
                id: 'p1',
                name: 'Publish gate',
                memberEditorIds: ['e1', 'e2'],
                aggregationBackend: { backendId: 'b1', model: '' }
            }
        ],
        actions: [
            {
                id: 'critique',
                actionId: 'critique',
                binding: { targetType: 'panel', targetId: 'p1' }
            },
            {
                id: 'c1',
                actionId: 'c1',
                customName: 'Zing',
                customVerbClass: 'transform',
                customInstruction: { text: 'Zing it.', notePaths: [], followLinks: false },
                binding: { targetType: 'editor', targetId: 'e1' }
            }
        ],
        rules: [
            {
                id: 'r1',
                name: 'Blog',
                match: { matchType: 'folder', value: 'Blog' },
                effect: 'assign',
                defaultTarget: { targetType: 'editor', targetId: 'e2' }
            }
        ],
        voiceProfile: { text: 'Write like me.', notePaths: ['Voice.md'], followLinks: true }
    })

const only = (...sections: readonly (keyof TransferSelection)[]): TransferSelection => {
    const selection = { ...ALL_SECTIONS }
    for (const section of TRANSFER_SECTIONS) {
        selection[section] = sections.includes(section)
    }
    return selection
}

/** Deterministic id generator so remapping is assertable. */
const counter = (): (() => string) => {
    let next = 0
    return () => `new-${++next}`
}

const planOf = (raw: unknown, current = settingsOf()): SettingsImportPlan => {
    const result = planImport(raw, current, counter())
    if (!result.ok) {
        throw new Error(`Expected a plan, got ${result.error}`)
    }
    return result.plan
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

describe('exportSettings', () => {
    it('NEVER includes an API key (hard privacy rule)', () => {
        const document = exportSettings(populated(), ALL_SECTIONS)
        const backends = document.backends ?? []
        expect(backends).toHaveLength(2)
        expect(backends[0]).toMatchObject({ id: 'b1', apiKey: '' })
        // Everything else about the backend survives, so only the key is lost.
        expect(backends[0]).toMatchObject({ kind: 'anthropic', label: 'Backend b1' })
        // No key anywhere in the serialized document either.
        expect(exportSettingsJson(populated(), ALL_SECTIONS)).not.toContain('sk-secret')
    })

    it('names the backends whose export can still carry a credential', () => {
        const settings = settingsOf({
            backends: [
                { ...apiBackend('plain', ''), baseUrl: 'https://api.openai.com/v1' },
                { ...apiBackend('query', ''), baseUrl: 'https://gw.example/v1?api-key=SECRET' },
                { ...apiBackend('userinfo', ''), baseUrl: 'https://user:pass@host/v1' },
                { ...apiBackend('body', ''), extraBodyJson: '{"api_key":"SECRET"}' },
                { id: 'cli', family: 'cli', kind: 'codex', label: 'Codex' }
            ]
        })
        expect(exportSecretRisks(settings, ALL_SECTIONS)).toEqual([
            { label: 'Backend query', risks: ['base-url-credentials'] },
            { label: 'Backend userinfo', risks: ['base-url-credentials'] },
            { label: 'Backend body', risks: ['extra-body'] }
        ])
        // Not exporting backends cannot leak a backend field.
        expect(exportSecretRisks(settings, only('editors'))).toEqual([])
    })

    it('omits unselected sections entirely instead of emptying them', () => {
        const document = exportSettings(populated(), only('editors', 'voiceProfile'))
        expect(Object.keys(document).sort()).toEqual([
            'editors',
            'format',
            'schemaVersion',
            'voiceProfile'
        ])
        expect(document.format).toEqual(EXPORT_FORMAT)
        expect(document.schemaVersion).toEqual(SETTINGS_SCHEMA_VERSION)
    })

    it('counts what each selected section contributes, in section order', () => {
        expect(exportCounts(populated(), ALL_SECTIONS)).toEqual([
            { section: 'backends', count: 2 },
            { section: 'editors', count: 2 },
            { section: 'panels', count: 1 },
            { section: 'actions', count: 2 },
            { section: 'rules', count: 1 },
            { section: 'voiceProfile', count: 1 }
        ])
        expect(exportCounts(populated(), only('panels'))).toEqual([{ section: 'panels', count: 1 }])
    })

    it('serializes to JSON an import accepts as-is', () => {
        const json = exportSettingsJson(populated(), ALL_SECTIONS)
        const result = planImportFromJson(json, settingsOf(), counter())
        expect(result.ok).toBe(true)
        if (!result.ok) {
            return
        }
        expect(result.plan.rejected).toEqual([])
        expect(result.plan.counts).toEqual([
            { section: 'backends', count: 2 },
            { section: 'editors', count: 2 },
            { section: 'panels', count: 1 },
            { section: 'actions', count: 2 },
            { section: 'rules', count: 1 },
            { section: 'voiceProfile', count: 1 }
        ])
    })
})

describe('sectionCountLabel', () => {
    it('agrees in number', () => {
        expect(sectionCountLabel('editors', 1)).toEqual('1 editor')
        expect(sectionCountLabel('editors', 3)).toEqual('3 editors')
        expect(sectionCountLabel('voiceProfile', 1)).toEqual('1 voice profile')
    })
})

// ---------------------------------------------------------------------------
// Import: document-level refusals
// ---------------------------------------------------------------------------

describe('planImport refusals', () => {
    it('refuses text that is not JSON, and JSON that is not an object', () => {
        expect(planImportFromJson('not json at all', settingsOf())).toEqual({
            ok: false,
            error: 'not-json'
        })
        expect(planImportFromJson('[1, 2]', settingsOf())).toEqual({
            ok: false,
            error: 'not-an-object'
        })
        expect(planImport(null, settingsOf())).toEqual({ ok: false, error: 'not-an-object' })
    })

    it('refuses an object with no recognizable section', () => {
        expect(planImport({ hello: 'world' }, settingsOf())).toEqual({
            ok: false,
            error: 'no-sections'
        })
    })

    it('accepts a plugin data.json (no format marker) as an import source', () => {
        const dataJson = JSON.parse(JSON.stringify(populated())) as Record<string, unknown>
        expect(dataJson['format']).toBeUndefined()
        const plan = planOf(dataJson)
        expect(plan.additions.editors).toHaveLength(2)
    })
})

// ---------------------------------------------------------------------------
// Import: keys, ids, references
// ---------------------------------------------------------------------------

describe('exportSettings — CLI consent', () => {
    it('never writes a consent record into a shared file', () => {
        const settings = populated()
        const exported = exportSettings(
            {
                ...settings,
                backends: [
                    ...settings.backends,
                    {
                        id: 'cli-1',
                        family: 'cli',
                        kind: 'claude-code',
                        label: 'Claude Code',
                        executablePath: '/home/alice/.local/bin/claude',
                        defaultModel: '',
                        consent: {
                            launchPath: '/home/alice/.local/bin/claude',
                            toolsPath: '/home/alice/.local/bin/claude'
                        },
                        timeoutSeconds: 300,
                        enabled: true
                    }
                ]
            },
            ALL_SECTIONS
        )
        const cli = exported.backends?.find((backend) => backend.id === 'cli-1')
        expect(cli).toMatchObject({ consent: { launchPath: '', toolsPath: '' } })
        // The path itself is functional configuration and stays, like baseUrl.
        expect(cli).toMatchObject({ executablePath: '/home/alice/.local/bin/claude' })
    })
})

describe('planImport', () => {
    it('clears an API key the imported file carries, and says it did', () => {
        const plan = planOf({ backends: [apiBackend('b1', 'sk-someone-elses')] })
        const backend = plan.additions.backends[0]
        expect(backend).toMatchObject({ apiKey: '' })
        expect(plan.adjustments).toEqual([
            { kind: 'backend-disabled', label: 'Backend b1' },
            { kind: 'api-key-cleared', label: 'Backend b1' }
        ])
    })

    it('imports a CLI backend inert: switched off and unconsented', () => {
        // Consent to launch a program is a decision about THIS machine, made
        // in a dialog that explained it. A file cannot carry it.
        const plan = planOf({
            backends: [
                {
                    id: 'b3',
                    family: 'cli',
                    kind: 'claude-code',
                    label: 'Claude Code',
                    executablePath: '/usr/local/bin/claude',
                    enabled: true,
                    consent: {
                        launchPath: '/usr/local/bin/claude',
                        toolsPath: '/usr/local/bin/claude'
                    }
                }
            ]
        })
        const backend = plan.additions.backends[0]
        expect(backend).toMatchObject({
            enabled: false,
            consent: { launchPath: '', toolsPath: '' }
        })
        expect(plan.adjustments).toEqual([
            { kind: 'backend-disabled', label: 'Claude Code' },
            { kind: 'cli-consent-cleared', label: 'Claude Code' }
        ])
    })

    it('imports API backends switched off, and says so once per backend', () => {
        const plan = planOf({
            backends: [
                apiBackend('b1', ''),
                { ...apiBackend('b2', ''), enabled: false },
                { id: 'b3', family: 'cli', kind: 'codex', label: 'Codex' }
            ]
        })
        expect(plan.additions.backends.map((backend) => backend.enabled)).toEqual([
            false,
            false,
            false
        ])
        // Only the one that ARRIVED enabled is an adjustment: reporting a
        // backend that was already off would be noise, not disclosure.
        expect(plan.adjustments).toEqual([{ kind: 'backend-disabled', label: 'Backend b1' }])
    })

    it('regenerates every id and remaps references inside the import', () => {
        const plan = planOf(exportSettings(populated(), ALL_SECTIONS))
        const [b1] = plan.additions.backends
        const [e1, e2] = plan.additions.editors
        const [p1] = plan.additions.panels
        const [critique, custom] = plan.additions.actions
        const [rule] = plan.additions.rules
        // Nothing keeps its old id...
        expect([b1?.id, e1?.id, e2?.id, p1?.id, custom?.id, rule?.id]).toEqual([
            'new-1',
            'new-3',
            'new-4',
            'new-5',
            'new-6',
            'new-7'
        ])
        // ...and every reference points at the NEW ids, not the old ones.
        expect(e1?.backend?.backendId).toEqual(b1?.id)
        expect(p1?.memberEditorIds).toEqual([e1?.id ?? '', e2?.id ?? ''])
        expect(p1?.aggregationBackend?.backendId).toEqual(b1?.id)
        expect(critique?.binding).toEqual({ targetType: 'panel', targetId: p1?.id ?? '' })
        expect(custom?.binding).toEqual({ targetType: 'editor', targetId: e1?.id ?? '' })
        expect(rule?.defaultTarget).toEqual({ targetType: 'editor', targetId: e2?.id ?? '' })
        // A built-in verb binding keeps the verb as its entity id + action id.
        expect(critique).toMatchObject({ id: 'critique', actionId: 'critique' })
        // A custom action's id and action id stay the same value.
        expect(custom?.actionId).toEqual(custom?.id)
        expect(plan.adjustments).toEqual([
            { kind: 'backend-disabled', label: 'Backend b1' },
            { kind: 'voice-profile-replaced' }
        ])
    })

    it('importing the same file twice adds two independent sets', () => {
        const document = exportSettings(populated(), only('editors'))
        const first = planOf(document)
        const merged = settingsOf()
        applyImportPlan(merged, first)
        const second = planImport(document, merged, counter())
        if (!second.ok) {
            throw new Error('expected a plan')
        }
        applyImportPlan(merged, second.plan)
        expect(merged.editors).toHaveLength(4)
        expect(new Set(merged.editors.map((editor) => editor.id)).size).toBe(4)
    })

    it('keeps a reference to an entity that exists here but is not in the import', () => {
        // The re-import case: panels alone, back into the vault their members
        // still live in.
        const current = populated()
        const plan = planOf(exportSettings(current, only('panels')), current)
        const panel = plan.additions.panels[0]
        expect(panel?.memberEditorIds).toEqual(['e1', 'e2'])
        expect(panel?.aggregationBackend?.backendId).toEqual('b1')
        expect(panel?.id).not.toEqual('p1')
        expect(plan.adjustments).toEqual([])
    })

    it('clears a backend reference that resolves nowhere', () => {
        const plan = planOf(exportSettings(populated(), only('editors')))
        expect(plan.additions.editors[0]?.backend).toBeNull()
        expect(plan.adjustments).toEqual([{ kind: 'backend-cleared', label: 'Concision' }])
    })

    it('clears an action/rule target that resolves nowhere', () => {
        const plan = planOf(exportSettings(populated(), only('actions', 'rules')))
        expect(plan.additions.actions.every((action) => action.binding === null)).toBe(true)
        expect(plan.additions.rules[0]?.defaultTarget).toBeNull()
        expect(plan.adjustments.map((adjustment) => adjustment.kind)).toEqual([
            'target-cleared',
            'target-cleared',
            'target-cleared'
        ])
    })

    it('drops unresolvable panel members, and rejects a panel left with none', () => {
        const partial = planOf({
            editors: [{ id: 'e1', name: 'Concision' }],
            panels: [{ id: 'p1', name: 'Duo', memberEditorIds: ['e1', 'ghost'] }]
        })
        expect(partial.additions.panels[0]?.memberEditorIds).toHaveLength(1)
        expect(partial.adjustments).toEqual([{ kind: 'members-dropped', label: 'Duo', count: 1 }])

        const orphan = planOf({ panels: [{ id: 'p1', name: 'Duo', memberEditorIds: ['ghost'] }] })
        expect(orphan.additions.panels).toEqual([])
        expect(orphan.rejected).toEqual([
            { section: 'panels', index: 0, label: 'Duo', reason: 'no-member-editor' }
        ])
    })

    it('rejects a built-in verb binding when that verb is already bound here', () => {
        const current = settingsOf({
            editors: [{ id: 'e1', name: 'Concision' }],
            actions: [
                {
                    id: 'critique',
                    actionId: 'critique',
                    binding: { targetType: 'editor', targetId: 'e1' }
                }
            ]
        })
        const plan = planOf(exportSettings(populated(), only('actions')), current)
        expect(plan.rejected).toEqual([
            { section: 'actions', index: 0, label: 'critique', reason: 'already-bound' }
        ])
        // The custom action still comes in.
        expect(plan.additions.actions).toHaveLength(1)
        expect(plan.additions.actions[0]?.customName).toEqual('Zing')
    })

    it('rejects a duplicated built-in binding inside one import too', () => {
        const plan = planOf({
            actions: [
                { id: 'critique', actionId: 'critique' },
                { id: 'critique-again', actionId: 'critique' }
            ]
        })
        expect(plan.additions.actions).toHaveLength(1)
        expect(plan.rejected.map((rejection) => rejection.reason)).toEqual(['already-bound'])
    })

    it('salvages per entity: one invalid element never drops its siblings', () => {
        const plan = planOf({
            editors: [
                { id: 'e1', name: 'Keeper' },
                { id: 'e2' }, // no name
                { name: 'No id' },
                'not even an object',
                { id: 'e3', name: 'Also kept' }
            ]
        })
        expect(plan.additions.editors.map((editor) => editor.name)).toEqual(['Keeper', 'Also kept'])
        expect(plan.rejected).toEqual([
            { section: 'editors', index: 1, label: 'e2', reason: 'invalid' },
            { section: 'editors', index: 2, label: 'No id', reason: 'invalid' },
            { section: 'editors', index: 3, label: '', reason: 'invalid' }
        ])
    })

    it('rejects a section that is not an array at all', () => {
        const plan = planOf({ editors: { id: 'e1', name: 'Not a list' } })
        expect(plan.additions.editors).toEqual([])
        expect(plan.rejected).toEqual([
            { section: 'editors', index: 0, label: '', reason: 'invalid' }
        ])
    })

    it('rejects the overflow when a section would exceed its schema maximum', () => {
        const current = settingsOf({
            panels: Array.from({ length: 49 }, (_, index) => ({
                id: `p${index}`,
                name: `Panel ${index}`,
                memberEditorIds: ['e1']
            })),
            editors: [{ id: 'e1', name: 'Member' }]
        })
        const plan = planOf(
            {
                panels: [
                    { id: 'x1', name: 'Fits', memberEditorIds: ['e1'] },
                    { id: 'x2', name: 'Does not fit', memberEditorIds: ['e1'] }
                ]
            },
            current
        )
        expect(plan.additions.panels.map((panel) => panel.name)).toEqual(['Fits'])
        expect(plan.rejected).toEqual([
            { section: 'panels', index: 1, label: 'Does not fit', reason: 'section-full' }
        ])
    })

    it('a capped-out entity leaves no dangling reference behind it', () => {
        // 199 of the 200 allowed editors are already here, so exactly one of
        // the two imported editors fits — and the panel spanning both must not
        // arrive pointing at an editor that was never added.
        const current = settingsOf({
            editors: Array.from({ length: 199 }, (_, index) => ({
                id: `own-${index}`,
                name: `Own ${index}`
            }))
        })
        const plan = planOf(
            {
                editors: [
                    { id: 'x1', name: 'Fits' },
                    { id: 'x2', name: 'Does not fit' }
                ],
                panels: [{ id: 'px', name: 'Both', memberEditorIds: ['x1', 'x2'] }]
            },
            current
        )
        const [kept] = plan.additions.editors
        expect(plan.additions.editors.map((editor) => editor.name)).toEqual(['Fits'])
        expect(plan.additions.panels[0]?.memberEditorIds).toEqual([kept?.id ?? ''])
        expect(plan.rejected).toEqual([
            { section: 'editors', index: 1, label: 'Does not fit', reason: 'section-full' }
        ])
        expect(plan.adjustments).toEqual([{ kind: 'members-dropped', label: 'Both', count: 1 }])
    })

    it('clears an action/rule target whose entity was capped out', () => {
        const current = settingsOf({
            panels: Array.from({ length: 50 }, (_, index) => ({
                id: `p${index}`,
                name: `Panel ${index}`,
                memberEditorIds: ['e1']
            })),
            editors: [{ id: 'e1', name: 'Member' }]
        })
        const plan = planOf(
            {
                panels: [{ id: 'px', name: 'No room', memberEditorIds: ['e1'] }],
                rules: [
                    {
                        id: 'rx',
                        name: 'Blog',
                        match: { matchType: 'folder', value: 'Blog' },
                        effect: 'assign',
                        defaultTarget: { targetType: 'panel', targetId: 'px' }
                    }
                ]
            },
            current
        )
        expect(plan.additions.panels).toEqual([])
        expect(plan.additions.rules[0]?.defaultTarget).toBeNull()
        expect(plan.adjustments).toEqual([{ kind: 'target-cleared', label: 'Blog' }])
    })

    it('a panel rejected for having no members frees its room for the next one', () => {
        const current = settingsOf({
            panels: Array.from({ length: 49 }, (_, index) => ({
                id: `p${index}`,
                name: `Panel ${index}`,
                memberEditorIds: ['e1']
            })),
            editors: [{ id: 'e1', name: 'Member' }]
        })
        const plan = planOf(
            {
                panels: [
                    { id: 'x1', name: 'Nobody here', memberEditorIds: ['ghost'] },
                    { id: 'x2', name: 'Real', memberEditorIds: ['e1'] }
                ]
            },
            current
        )
        expect(plan.additions.panels.map((panel) => panel.name)).toEqual(['Real'])
        expect(plan.rejected).toEqual([
            { section: 'panels', index: 0, label: 'Nobody here', reason: 'no-member-editor' }
        ])
    })

    it('replaces the voice profile rather than merging it, and reports invalid ones', () => {
        const current = settingsOf({
            voiceProfile: { text: 'Old voice.', notePaths: ['Old.md'], followLinks: false }
        })
        const plan = planOf({ voiceProfile: { text: 'New voice.' } }, current)
        expect(plan.voiceProfile).toMatchObject({ text: 'New voice.', notePaths: [] })
        applyImportPlan(current, plan)
        expect(current.voiceProfile.text).toEqual('New voice.')
        expect(current.voiceProfile.notePaths).toEqual([])

        const invalid = planOf({ editors: [], voiceProfile: 'just a string' })
        expect(invalid.voiceProfile).toBeNull()
        expect(invalid.rejected).toEqual([
            { section: 'voiceProfile', index: 0, label: '', reason: 'invalid' }
        ])
    })

    it('reports an import that would change nothing', () => {
        const plan = planOf({ editors: [] })
        expect(importPlanIsEmpty(plan)).toBe(true)
        expect(importPlanIsEmpty(planOf({ editors: [{ id: 'e1', name: 'One' }] }))).toBe(false)
    })
})

// ---------------------------------------------------------------------------
// Application
// ---------------------------------------------------------------------------

describe('applyImportPlan', () => {
    it('appends without touching what is already configured', () => {
        const current = populated()
        const before = JSON.parse(JSON.stringify(current)) as PluginSettingsV1
        const plan = planOf(exportSettings(populated(), only('backends', 'editors')), current)
        applyImportPlan(current, plan)

        expect(current.backends.slice(0, 2)).toEqual(before.backends)
        expect(current.editors.slice(0, 2)).toEqual(before.editors)
        expect(current.backends).toHaveLength(4)
        expect(current.editors).toHaveLength(4)
        // Existing cross-references still resolve to the ORIGINAL entities.
        expect(current.editors[0]?.backend?.backendId).toEqual('b1')
        expect(current.panels[0]?.memberEditorIds).toEqual(['e1', 'e2'])
    })

    it('leaves the result schema-valid, ids unique across every section', () => {
        const current = populated()
        applyImportPlan(current, planOf(exportSettings(populated(), ALL_SECTIONS), current))
        expect(pluginSettingsSchema.safeParse(current).success).toBe(true)
        const ids = [
            ...current.backends,
            ...current.editors,
            ...current.panels,
            ...current.actions,
            ...current.rules
        ].map((entity) => entity.id)
        expect(new Set(ids).size).toBe(ids.length)
    })
})

// ---------------------------------------------------------------------------
// The section caps must mirror the schema, or the report lies
// ---------------------------------------------------------------------------

describe('section maximums', () => {
    const sample = (section: string, count: number): unknown[] =>
        Array.from({ length: count }, (_, index) => {
            switch (section) {
                case 'backends':
                    return apiBackend(`b${index}`, '')
                case 'editors':
                    return { id: `e${index}`, name: `Editor ${index}` }
                case 'panels':
                    return { id: `p${index}`, name: `Panel ${index}`, memberEditorIds: ['e0'] }
                case 'actions':
                    return { id: `a${index}`, actionId: `a${index}` }
                default:
                    return {
                        id: `r${index}`,
                        match: { matchType: 'folder', value: 'X' },
                        effect: 'assign'
                    }
            }
        })

    it('matches what the schema actually accepts', () => {
        // The caps are duplicated as constants (zod does not expose them);
        // this pins the duplication so a schema change cannot drift silently.
        for (const [section, max] of Object.entries({
            backends: 50,
            editors: 200,
            panels: 50,
            actions: 200,
            rules: 200
        })) {
            expect(
                pluginSettingsSchema.safeParse({ [section]: sample(section, max) }).success
            ).toBe(true)
            expect(
                pluginSettingsSchema.safeParse({ [section]: sample(section, max + 1) }).success
            ).toBe(false)
        }
    })
})
