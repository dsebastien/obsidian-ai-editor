import { describe, expect, it } from 'bun:test'
import {
    apiBackendSchema,
    editorConfigSchema,
    pluginSettingsSchema
} from '../domain/settings/settings-schema'
import type { PluginSettingsV1 } from '../domain/settings/settings-schema'
import { desiredBulkCommands, diffBulkCommands } from './bulk-commands'

function makeSettings(editors: Record<string, unknown>[]): PluginSettingsV1 {
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
        editors: editors.map((editor) => editorConfigSchema.parse(editor))
    })
}

describe('desiredBulkCommands', () => {
    it('creates an accept/dismiss pair per enabled review-capable editor', () => {
        const settings = makeSettings([
            { id: 'editor-1', name: 'Concision Editor' },
            { id: 'editor-2', name: 'Fact Checker' }
        ])
        expect(desiredBulkCommands(settings)).toEqual([
            {
                id: 'accept-all-editor-1',
                name: 'Accept all from Concision Editor',
                editorId: 'editor-1',
                kind: 'accept'
            },
            {
                id: 'dismiss-all-editor-1',
                name: 'Dismiss all from Concision Editor',
                editorId: 'editor-1',
                kind: 'dismiss'
            },
            {
                id: 'accept-all-editor-2',
                name: 'Accept all from Fact Checker',
                editorId: 'editor-2',
                kind: 'accept'
            },
            {
                id: 'dismiss-all-editor-2',
                name: 'Dismiss all from Fact Checker',
                editorId: 'editor-2',
                kind: 'dismiss'
            }
        ])
    })

    it('skips disabled editors and editors that cannot review', () => {
        const settings = makeSettings([
            { id: 'editor-1', name: 'Off', enabled: false },
            {
                id: 'editor-2',
                name: 'Rewriter',
                capabilities: { review: false, transform: true, generate: true, comment: false }
            },
            { id: 'editor-3', name: 'Reviewer' }
        ])
        expect(desiredBulkCommands(settings).map((command) => command.id)).toEqual([
            'accept-all-editor-3',
            'dismiss-all-editor-3'
        ])
    })

    it('keeps command ids stable across a rename so hotkeys survive', () => {
        const before = desiredBulkCommands(makeSettings([{ id: 'editor-1', name: 'Old name' }]))
        const after = desiredBulkCommands(makeSettings([{ id: 'editor-1', name: 'New name' }]))
        expect(after.map((command) => command.id)).toEqual(before.map((command) => command.id))
        const diff = diffBulkCommands(
            new Map(before.map((command) => [command.id, command.name])),
            after
        )
        expect(diff.remove).toEqual([])
        expect(diff.add.map((command) => command.name)).toEqual([
            'Accept all from New name',
            'Dismiss all from New name'
        ])
    })

    it('removes both commands of a deleted editor', () => {
        const registered = new Map(
            desiredBulkCommands(makeSettings([{ id: 'editor-1', name: 'Gone' }])).map((command) => [
                command.id,
                command.name
            ])
        )
        const diff = diffBulkCommands(registered, desiredBulkCommands(makeSettings([])))
        expect([...diff.remove].sort()).toEqual(['accept-all-editor-1', 'dismiss-all-editor-1'])
        expect(diff.add).toEqual([])
    })
})
