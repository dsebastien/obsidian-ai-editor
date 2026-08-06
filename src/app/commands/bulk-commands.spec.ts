import { describe, expect, it } from 'bun:test'
import type { Plugin } from 'obsidian'
import {
    apiBackendSchema,
    editorConfigSchema,
    pluginSettingsSchema
} from '../domain/settings/settings-schema'
import type { PluginSettingsV1 } from '../domain/settings/settings-schema'
import {
    desiredBulkCommands,
    diffBulkCommands,
    registerGlobalDismissCommand
} from './bulk-commands'
import type { GlobalDismissController } from './bulk-commands'

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

// ---------------------------------------------------------------------------
// registerGlobalDismissCommand
// ---------------------------------------------------------------------------

interface CapturedCommand {
    readonly id: string
    readonly name: string
    readonly checkCallback?: (checking: boolean) => boolean
}

function fakePlugin(captured: CapturedCommand[]): Plugin {
    return {
        addCommand: (command: CapturedCommand): CapturedCommand => {
            captured.push(command)
            return command
        }
    } as unknown as Plugin
}

function fakeController(dismissable: boolean): {
    controller: GlobalDismissController
    dismissed: (string | null)[]
} {
    const dismissed: (string | null)[] = []
    return {
        controller: {
            canDismissAll: (): boolean => dismissable,
            dismissAllFindings: (editorId: string | null): void => {
                dismissed.push(editorId)
            }
        },
        dismissed
    }
}

describe('registerGlobalDismissCommand', () => {
    it('registers ONE static command with a stable, editor-free id', () => {
        const captured: CapturedCommand[] = []
        registerGlobalDismissCommand(fakePlugin(captured), fakeController(true).controller)
        expect(captured.map((command) => ({ id: command.id, name: command.name }))).toEqual([
            { id: 'dismiss-all-findings', name: 'Dismiss all findings' }
        ])
        expect(captured[0]?.checkCallback).toBeDefined()
    })

    it('is hidden when the active run has nothing to dismiss', () => {
        const captured: CapturedCommand[] = []
        const { controller, dismissed } = fakeController(false)
        registerGlobalDismissCommand(fakePlugin(captured), controller)
        expect(captured[0]?.checkCallback?.(true)).toBe(false)
        // Even a direct (non-checking) invocation must not dispatch: Obsidian
        // calls the same callback for hotkeys, so the gate runs both ways.
        expect(captured[0]?.checkCallback?.(false)).toBe(false)
        expect(dismissed).toEqual([])
    })

    it('reports available without dispatching while checking', () => {
        const captured: CapturedCommand[] = []
        const { controller, dismissed } = fakeController(true)
        registerGlobalDismissCommand(fakePlugin(captured), controller)
        expect(captured[0]?.checkCallback?.(true)).toBe(true)
        expect(dismissed).toEqual([])
    })

    it('dismisses across EVERY editor of the run when invoked', () => {
        const captured: CapturedCommand[] = []
        const { controller, dismissed } = fakeController(true)
        registerGlobalDismissCommand(fakePlugin(captured), controller)
        expect(captured[0]?.checkCallback?.(false)).toBe(true)
        // `null` is the controller's "every editor" scope — the whole point
        // of the global command.
        expect(dismissed).toEqual([null])
    })
})
