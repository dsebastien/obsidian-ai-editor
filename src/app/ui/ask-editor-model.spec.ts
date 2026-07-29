import { describe, expect, it } from 'bun:test'
import { canSubmitAsk, defaultAskEditor, normalizeInstruction } from './ask-editor-model'
import type { AskEditorChoice } from './ask-editor-model'

describe('normalizeInstruction', () => {
    it('trims surrounding whitespace and returns the instruction', () => {
        expect(normalizeInstruction('  Is this argument convincing?\n')).toBe(
            'Is this argument convincing?'
        )
    })

    it('preserves interior newlines (Enter inserts newlines by design)', () => {
        expect(normalizeInstruction('First point.\nSecond point.')).toBe(
            'First point.\nSecond point.'
        )
    })

    it('returns null for blank input', () => {
        expect(normalizeInstruction('')).toBeNull()
        expect(normalizeInstruction('   \n\t ')).toBeNull()
    })
})

describe('canSubmitAsk', () => {
    it('enables only when a normalized instruction exists', () => {
        expect(canSubmitAsk('Check the tone')).toBe(true)
        expect(canSubmitAsk('   ')).toBe(false)
        expect(canSubmitAsk('')).toBe(false)
    })
})

describe('defaultAskEditor', () => {
    const choices: AskEditorChoice[] = [
        { id: 'editor-1', name: 'Hater' },
        { id: 'editor-2', name: 'Mentor' }
    ]

    it('picks the first choice (settings order)', () => {
        expect(defaultAskEditor(choices)).toEqual({ id: 'editor-1', name: 'Hater' })
    })

    it('returns null for an empty choice list', () => {
        expect(defaultAskEditor([])).toBeNull()
    })
})
