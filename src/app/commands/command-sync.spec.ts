import { describe, expect, it } from 'bun:test'
import { diffCommands } from './command-sync'

interface TestView {
    readonly id: string
    readonly name: string
    readonly editorId: string
}

const view = (overrides: Partial<TestView> = {}): TestView => ({
    id: 'accept-all-editor-1',
    name: 'Accept all from Concision Editor',
    editorId: 'editor-1',
    ...overrides
})

describe('diffCommands', () => {
    it('adds new commands and removes stale ones', () => {
        const diff = diffCommands(new Map([['accept-all-gone', 'Accept all from Gone']]), [view()])
        expect(diff.add).toEqual([view()])
        expect(diff.remove).toEqual(['accept-all-gone'])
    })

    it('re-adds a renamed command under its unchanged id (hotkeys survive)', () => {
        const renamed = view({ name: 'Accept all from Terser Editor' })
        const diff = diffCommands(
            new Map([['accept-all-editor-1', 'Accept all from Concision Editor']]),
            [renamed]
        )
        expect(diff.add).toEqual([renamed])
        expect(diff.remove).toEqual([])
    })

    it('is a no-op when nothing changed', () => {
        const diff = diffCommands(
            new Map([['accept-all-editor-1', 'Accept all from Concision Editor']]),
            [view()]
        )
        expect(diff.add).toEqual([])
        expect(diff.remove).toEqual([])
    })

    it('preserves the desired payload type so glue can dispatch from it', () => {
        const diff = diffCommands(new Map(), [view()])
        expect(diff.add[0]?.editorId).toBe('editor-1')
    })
})
