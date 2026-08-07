import { describe, expect, it } from 'bun:test'
import { MEMORY_TEXT_MAX } from '../domain/operations/contract'
import { editorConfigSchema, pluginSettingsSchema } from '../domain/settings/settings-schema'
import {
    currentSettingsMemory,
    distillableEditorIds,
    memoryChangedOutside
} from './memory-commands'
import type { DistillGateEditor } from './memory-commands'

/**
 * Availability gate of `Distill editor learnings` (issue #4, BR #14):
 * hidden unless at least one ENABLED editor with memory on has journal
 * events this session.
 */

function editor(overrides: Partial<DistillGateEditor> = {}): DistillGateEditor {
    return { id: 'e1', enabled: true, memory: 'settings', ...overrides }
}

describe('distillableEditorIds', () => {
    it('returns editors that are enabled, memory-on, and hold journal events', () => {
        const editors = [
            editor(),
            editor({ id: 'e2', memory: 'note' }),
            editor({ id: 'e3', memory: 'off' })
        ]
        expect(distillableEditorIds(editors, () => true)).toEqual(['e1', 'e2'])
    })

    it('hides the command when no editor has memory enabled', () => {
        expect(distillableEditorIds([editor({ memory: 'off' })], () => true)).toEqual([])
    })

    it('hides the command when the journal holds no events for any candidate', () => {
        const editors = [editor(), editor({ id: 'e2', memory: 'note' })]
        expect(distillableEditorIds(editors, () => false)).toEqual([])
    })

    it('excludes disabled editors even with events waiting', () => {
        expect(distillableEditorIds([editor({ enabled: false })], () => true)).toEqual([])
    })

    it('checks events per editor, not globally', () => {
        const editors = [editor(), editor({ id: 'e2' })]
        expect(distillableEditorIds(editors, (id) => id === 'e2')).toEqual(['e2'])
    })

    it('an empty editor list yields no candidates', () => {
        expect(distillableEditorIds([], () => true)).toEqual([])
    })
})

/**
 * Save-time conflict gate (adversarial review 2026-08-07): a proposal
 * distilled FROM `previousMemory` must not silently overwrite a destination
 * that changed while the request or the review modal was open.
 */
describe('memoryChangedOutside', () => {
    it('no conflict when the destination still matches the distilled base', () => {
        expect(memoryChangedOutside('Old rules.', 'Old rules.')).toBeFalse()
    })

    it('conflict when the destination changed under the open proposal', () => {
        expect(memoryChangedOutside('Edited meanwhile.', 'Old rules.')).toBeTrue()
    })

    it('a deleted editor (null current) is not a content conflict — the save reports it', () => {
        expect(memoryChangedOutside(null, 'Old rules.')).toBeFalse()
    })
})

describe('currentSettingsMemory', () => {
    function settingsWith(memoryText: string) {
        return pluginSettingsSchema.parse({
            editors: [
                editorConfigSchema.parse({
                    id: 'e1',
                    name: 'Concision',
                    prompt: { text: 'persona', notePaths: [], followLinks: false },
                    memory: 'settings',
                    memoryText
                })
            ]
        })
    }

    it('reads the editor’s memory text, clipped like the distiller clips it', () => {
        expect(currentSettingsMemory(settingsWith('Rules.'), 'e1')).toEqual('Rules.')
        // Oversized text cannot pass the schema; inject it post-parse to
        // prove the derivation clips exactly like the distiller does.
        const settings = settingsWith('Rules.')
        const editor = settings.editors[0]
        if (!editor) {
            throw new Error('fixture editor missing')
        }
        editor.memoryText = 'x'.repeat(MEMORY_TEXT_MAX + 5)
        expect(currentSettingsMemory(settings, 'e1')).toHaveLength(MEMORY_TEXT_MAX)
    })

    it('returns null for an editor that no longer exists', () => {
        expect(currentSettingsMemory(settingsWith('Rules.'), 'ghost')).toBeNull()
    })
})
