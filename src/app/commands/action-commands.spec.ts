import { describe, expect, it } from 'bun:test'
import {
    actionBindingSchema,
    apiBackendSchema,
    editorConfigSchema,
    pluginSettingsSchema
} from '../domain/settings/settings-schema'
import type { PluginSettingsV1 } from '../domain/settings/settings-schema'
import { desiredActionCommands, diffActionCommands } from './action-commands'
import type { ActionCommandView } from './action-commands'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeSettings(actions: Record<string, unknown>[]): PluginSettingsV1 {
    return pluginSettingsSchema.parse({
        backends: [
            apiBackendSchema.parse({
                id: 'backend-1',
                family: 'api',
                kind: 'anthropic',
                label: 'Claude',
                defaultModel: 'claude-test-1'
            })
        ],
        defaultBackend: { backendId: 'backend-1', model: '' },
        editors: [editorConfigSchema.parse({ id: 'editor-1', name: 'Concision Editor' })],
        actions: actions.map((action) => actionBindingSchema.parse(action))
    })
}

const BOUND = { targetType: 'editor', targetId: 'editor-1' }

function view(overrides: Partial<ActionCommandView> = {}): ActionCommandView {
    return { id: 'action-humanize', name: 'Humanize', bindingId: 'humanize', ...overrides }
}

// ---------------------------------------------------------------------------
// desiredActionCommands
// ---------------------------------------------------------------------------

describe('desiredActionCommands', () => {
    it('creates one action-<bindingId> command per dispatchable binding', () => {
        const settings = makeSettings([
            { id: 'humanize', actionId: 'humanize', binding: BOUND },
            {
                id: 'custom-uuid-1',
                actionId: 'custom-uuid-1',
                customName: 'Make checklist',
                customVerbClass: 'transform',
                customInstruction: { text: 'Checklist it.', notePaths: [], followLinks: false },
                binding: BOUND
            }
        ])
        expect(desiredActionCommands(settings)).toEqual([
            { id: 'action-humanize', name: 'Humanize', bindingId: 'humanize' },
            { id: 'action-custom-uuid-1', name: 'Make checklist', bindingId: 'custom-uuid-1' }
        ])
    })

    it('never desires a command for an undispatchable binding', () => {
        const settings = makeSettings([
            { id: 'humanize', actionId: 'humanize', binding: null },
            { id: 'rephrase', actionId: 'rephrase', binding: BOUND }
        ])
        expect(desiredActionCommands(settings).map((command) => command.id)).toEqual([
            'action-rephrase'
        ])
    })
})

// ---------------------------------------------------------------------------
// diffActionCommands
// ---------------------------------------------------------------------------

describe('diffActionCommands', () => {
    it('adds new commands and removes stale ones', () => {
        const registered = new Map([['action-old', 'Old']])
        const diff = diffActionCommands(registered, [view()])
        expect(diff.add).toEqual([view()])
        expect(diff.remove).toEqual(['action-old'])
    })

    it('re-adds a command whose name changed under its unchanged id', () => {
        const registered = new Map([['action-custom-1', 'Old name']])
        const renamed = view({ id: 'action-custom-1', name: 'New name', bindingId: 'custom-1' })
        const diff = diffActionCommands(registered, [renamed])
        expect(diff.add).toEqual([renamed])
        expect(diff.remove).toEqual([])
    })

    it('is a no-op when nothing changed', () => {
        const registered = new Map([['action-humanize', 'Humanize']])
        const diff = diffActionCommands(registered, [view()])
        expect(diff.add).toEqual([])
        expect(diff.remove).toEqual([])
    })
})
