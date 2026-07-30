import { describe, expect, test } from 'bun:test'
import { builtInActionIdSchema, pluginSettingsSchema } from '../domain/settings/settings-schema'
import type { PluginSettingsV1 } from '../domain/settings/settings-schema'
import {
    applyEntityDeletion,
    builtInActionLabel,
    clampInt,
    computeDeletionImpact,
    decodeActionTarget,
    deletionImpactLines,
    describeBackendRef,
    encodeActionTarget,
    isBuiltInActionId,
    isInsecureRemoteUrl,
    moveItem,
    normalizeChipValue,
    ruleSummary,
    setBuiltInActionBinding,
    setCustomActionClass
} from './helpers'

const fixture = (): PluginSettingsV1 =>
    pluginSettingsSchema.parse({
        backends: [{ id: 'b1', family: 'api', kind: 'anthropic', label: 'Claude' }],
        defaultBackend: { backendId: 'b1', model: '' },
        editors: [
            { id: 'e1', name: 'Concision', backend: { backendId: 'b1', model: 'sonnet' } },
            { id: 'e2', name: 'Hater' }
        ],
        panels: [
            {
                id: 'p1',
                name: 'Publish gate',
                memberEditorIds: ['e1'],
                aggregationBackend: { backendId: 'b1', model: '' }
            },
            { id: 'p2', name: 'Duo', memberEditorIds: ['e1', 'e2'] }
        ],
        actions: [
            {
                id: 'critique',
                actionId: 'critique',
                binding: { targetType: 'editor', targetId: 'e1' }
            },
            {
                id: 'c1',
                actionId: 'c1',
                customName: 'Zing',
                binding: { targetType: 'panel', targetId: 'p1' }
            }
        ],
        rules: [
            {
                id: 'r1',
                name: '',
                match: { matchType: 'folder', value: 'Blog' },
                effect: 'assign',
                defaultTarget: { targetType: 'editor', targetId: 'e1' }
            }
        ],
        behavior: { defaultCommentEditorId: 'e1' }
    })

describe('computeDeletionImpact', () => {
    test('backend deletion reports every referencing entity', () => {
        const issues = computeDeletionImpact(fixture(), 'backend', 'b1')
        const entities = issues.map((issue) => `${issue.entity}:${issue.entityId}`).sort()
        expect(entities).toEqual(['default-backend:default', 'editor:e1', 'panel:p1'])
    })

    test('editor deletion reports panels, actions, rules, and comment default', () => {
        const issues = computeDeletionImpact(fixture(), 'editor', 'e1')
        const entities = issues.map((issue) => `${issue.entity}:${issue.entityId}`).sort()
        expect(entities).toEqual([
            'action:critique',
            'behavior:defaultCommentEditor',
            'panel:p1',
            'panel:p2',
            'rule:r1'
        ])
    })

    test('a lightly referenced entity only reports its actual references', () => {
        const issues = computeDeletionImpact(fixture(), 'editor', 'e2')
        expect(issues).toEqual([
            { entity: 'panel', entityId: 'p2', missing: 'editor', missingId: 'e2' }
        ])
    })

    test('pre-existing issues are not attributed to the deletion', () => {
        const settings = fixture()
        const broken: PluginSettingsV1 = {
            ...settings,
            editors: settings.editors.filter((editor) => editor.id !== 'e2'),
            panels: settings.panels
        }
        // p2 already references the missing e2; deleting e2 "again" adds nothing.
        expect(computeDeletionImpact(broken, 'editor', 'e2')).toEqual([])
    })
})

describe('deletionImpactLines', () => {
    test('editor deletion mentions cascade deletion of an emptied panel', () => {
        const lines = deletionImpactLines(fixture(), 'editor', 'e1')
        expect(
            lines.some((line) => line.includes('Publish gate') && line.includes('deleted'))
        ).toBe(true)
        // Cascade: the custom action bound to the doomed panel is unbound too.
        expect(lines.some((line) => line.includes('Zing'))).toBe(true)
        expect(lines.some((line) => line.includes('Duo'))).toBe(true)
        expect(lines.some((line) => line.includes('margin comments'))).toBe(true)
    })

    test('backend deletion mentions the global default', () => {
        const lines = deletionImpactLines(fixture(), 'backend', 'b1')
        expect(lines.some((line) => line.includes('global default backend'))).toBe(true)
        expect(lines.some((line) => line.includes('Concision'))).toBe(true)
    })
})

describe('applyEntityDeletion', () => {
    test('editor deletion cleans every reference and cascades emptied panels', () => {
        const settings = fixture()
        applyEntityDeletion(settings, 'editor', 'e1')
        expect(settings.editors.map((editor) => editor.id)).toEqual(['e2'])
        expect(settings.panels.map((panel) => panel.id)).toEqual(['p2'])
        const p2 = settings.panels[0]
        expect(p2?.memberEditorIds).toEqual(['e2'])
        expect(settings.actions.every((action) => action.binding === null)).toBe(true)
        expect(settings.rules[0]?.defaultTarget).toBeNull()
        expect(settings.behavior.defaultCommentEditorId).toBe('')
    })

    test('backend deletion resets references to inherit', () => {
        const settings = fixture()
        applyEntityDeletion(settings, 'backend', 'b1')
        expect(settings.backends).toEqual([])
        expect(settings.defaultBackend).toBeNull()
        expect(settings.editors[0]?.backend).toBeNull()
        expect(settings.panels[0]?.aggregationBackend).toBeNull()
    })

    test('panel deletion unbinds actions and rules pointing at it', () => {
        const settings = fixture()
        applyEntityDeletion(settings, 'panel', 'p1')
        expect(settings.panels.map((panel) => panel.id)).toEqual(['p2'])
        const custom = settings.actions.find((action) => action.id === 'c1')
        expect(custom?.binding).toBeNull()
        // The editor-bound action is untouched.
        const critique = settings.actions.find((action) => action.id === 'critique')
        expect(critique?.binding).not.toBeNull()
    })
})

describe('setBuiltInActionBinding', () => {
    test('creates, updates, and clears bindings', () => {
        const settings = fixture()
        setBuiltInActionBinding(settings, 'rephrase', { targetType: 'panel', targetId: 'p2' })
        expect(settings.actions.find((action) => action.actionId === 'rephrase')?.binding).toEqual({
            targetType: 'panel',
            targetId: 'p2'
        })

        setBuiltInActionBinding(settings, 'rephrase', { targetType: 'editor', targetId: 'e2' })
        expect(settings.actions.find((action) => action.actionId === 'rephrase')?.binding).toEqual({
            targetType: 'editor',
            targetId: 'e2'
        })

        setBuiltInActionBinding(settings, 'rephrase', null)
        expect(settings.actions.find((action) => action.actionId === 'rephrase')).toBeUndefined()
    })
})

describe('setCustomActionClass', () => {
    const customOf = (settings: PluginSettingsV1) =>
        settings.actions.find((action) => action.id === 'c1')

    test('sets the class and clears a panel binding the new class cannot use', () => {
        const settings = fixture()
        // The fixture's custom action is bound to a panel.
        setCustomActionClass(settings, 'c1', 'review')
        expect(customOf(settings)?.customVerbClass).toEqual('review')
        expect(customOf(settings)?.binding).toEqual({ targetType: 'panel', targetId: 'p1' })

        setCustomActionClass(settings, 'c1', 'transform')
        expect(customOf(settings)?.customVerbClass).toEqual('transform')
        // Kept, it would resolve to `panel-binding-invalid` and the action
        // would silently vanish from every surface.
        expect(customOf(settings)?.binding).toBeNull()
    })

    test('keeps an editor binding across every class, and accepts clearing the class', () => {
        const settings = fixture()
        setCustomActionClass(settings, 'c1', 'transform')
        const action = customOf(settings)
        if (!action) {
            throw new Error('missing custom action')
        }
        action.binding = { targetType: 'editor', targetId: 'e1' }
        for (const verbClass of ['generate', 'review', 'transform', null] as const) {
            setCustomActionClass(settings, 'c1', verbClass)
            expect(customOf(settings)?.customVerbClass).toEqual(verbClass)
            expect(customOf(settings)?.binding).toEqual({ targetType: 'editor', targetId: 'e1' })
        }
    })

    test('is a no-op for an unknown entity id', () => {
        const settings = fixture()
        setCustomActionClass(settings, 'ghost', 'review')
        expect(settings.actions.map((action) => action.customVerbClass)).toEqual([null, null])
    })
})

describe('action target encoding', () => {
    test('round-trips editor and panel targets', () => {
        for (const target of [
            { targetType: 'editor' as const, targetId: 'e1' },
            { targetType: 'panel' as const, targetId: 'p1' }
        ]) {
            expect(decodeActionTarget(encodeActionTarget(target))).toEqual(target)
        }
    })

    test('malformed values decode to null', () => {
        expect(decodeActionTarget('')).toBeNull()
        expect(decodeActionTarget('editor:')).toBeNull()
        expect(decodeActionTarget('bogus:e1')).toBeNull()
    })
})

describe('labels & summaries', () => {
    test('every built-in verb has a label', () => {
        for (const id of builtInActionIdSchema.options) {
            expect(builtInActionLabel(id).length).toBeGreaterThan(0)
        }
    })

    test('isBuiltInActionId distinguishes verbs from UUIDs', () => {
        expect(isBuiltInActionId('critique')).toBe(true)
        expect(isBuiltInActionId('0b8f9c1a-1111-2222-3333-444455556666')).toBe(false)
    })

    test('describeBackendRef covers inherit, missing, and model override', () => {
        const settings = fixture()
        expect(describeBackendRef(settings, null)).toContain('Inherits')
        expect(describeBackendRef(settings, { backendId: 'nope', model: '' })).toContain('Unknown')
        expect(describeBackendRef(settings, { backendId: 'b1', model: 'opus' })).toBe(
            'Claude · opus'
        )
        expect(describeBackendRef(settings, { backendId: 'b1', model: '' })).toBe('Claude')
    })

    test('ruleSummary names targets and the kill switch', () => {
        const settings = fixture()
        const rule = settings.rules[0]
        if (!rule) {
            throw new Error('fixture rule missing')
        }
        expect(ruleSummary(settings, rule)).toBe('folder "Blog" → reviewed by Concision')
        expect(ruleSummary(settings, { ...rule, effect: 'disabled' })).toBe(
            'folder "Blog" → plugin disabled'
        )
        expect(
            ruleSummary(settings, {
                ...rule,
                defaultTarget: { targetType: 'panel', targetId: 'p1' }
            })
        ).toBe('folder "Blog" → reviewed by panel Publish gate (Concision)')
    })

    test('ruleSummary says so when a rule does nothing', () => {
        const settings = fixture()
        const rule = settings.rules[0]
        if (!rule) {
            throw new Error('fixture rule missing')
        }
        expect(ruleSummary(settings, { ...rule, defaultTarget: null })).toContain('does nothing')
        expect(
            ruleSummary(settings, {
                ...rule,
                defaultTarget: { targetType: 'editor', targetId: 'gone' }
            })
        ).toBe('folder "Blog" → deleted editor (rule does nothing)')
        expect(
            ruleSummary(settings, {
                ...rule,
                defaultTarget: { targetType: 'panel', targetId: 'gone' }
            })
        ).toBe('folder "Blog" → deleted panel (rule does nothing)')
    })
})

describe('moveItem', () => {
    test('moves items and returns null for no-ops', () => {
        expect(moveItem(['a', 'b', 'c'], 0, 2)).toEqual(['b', 'c', 'a'])
        expect(moveItem(['a', 'b', 'c'], 2, 1)).toEqual(['a', 'c', 'b'])
        expect(moveItem(['a', 'b'], 0, 0)).toBeNull()
        expect(moveItem(['a', 'b'], -1, 1)).toBeNull()
        expect(moveItem(['a', 'b'], 0, 2)).toBeNull()
    })
})

describe('clampInt', () => {
    test('clamps, parses, and falls back', () => {
        expect(clampInt('5', 1, 10, 3)).toBe(5)
        expect(clampInt('999', 1, 10, 3)).toBe(10)
        expect(clampInt('-4', 1, 10, 3)).toBe(1)
        expect(clampInt('abc', 1, 10, 3)).toBe(3)
        expect(clampInt('  7  ', 1, 10, 3)).toBe(7)
    })
})

describe('normalizeChipValue', () => {
    test('tags lose leading hashes, folders lose trailing slashes', () => {
        expect(normalizeChipValue('#daily', 'tag')).toBe('daily')
        expect(normalizeChipValue('##nested/tag', 'tag')).toBe('nested/tag')
        expect(normalizeChipValue('Private/', 'folder')).toBe('Private')
        expect(normalizeChipValue('Private/Sub//', 'folder')).toBe('Private/Sub')
        expect(normalizeChipValue('/', 'folder')).toBe('')
        expect(normalizeChipValue('   ', 'tag')).toBe('')
    })
})

describe('isInsecureRemoteUrl', () => {
    test('flags plain HTTP to remote hosts only', () => {
        expect(isInsecureRemoteUrl('http://example.com/v1')).toBe(true)
        expect(isInsecureRemoteUrl('http://10.0.0.5:8080')).toBe(true)
        expect(isInsecureRemoteUrl('http://localhost:11434')).toBe(false)
        expect(isInsecureRemoteUrl('http://127.0.0.1')).toBe(false)
        expect(isInsecureRemoteUrl('http://[::1]:11434')).toBe(false)
        expect(isInsecureRemoteUrl('https://example.com')).toBe(false)
        expect(isInsecureRemoteUrl('')).toBe(false)
    })
})
