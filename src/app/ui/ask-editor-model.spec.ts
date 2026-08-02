import { describe, expect, it } from 'bun:test'
import {
    askChoiceLabel,
    canSubmitAsk,
    defaultAskEditor,
    normalizeInstruction
} from './ask-editor-model'
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

    it('honours a preferred editor (behavior.defaultCommentEditorId)', () => {
        expect(defaultAskEditor(choices, 'editor-2')).toEqual({ id: 'editor-2', name: 'Mentor' })
    })

    it('falls back to the first choice when the preferred one is not on offer', () => {
        // Deleted, disabled or review-incapable: never leave the picker empty.
        expect(defaultAskEditor(choices, 'gone')).toEqual({ id: 'editor-1', name: 'Hater' })
        expect(defaultAskEditor(choices, '')).toEqual({ id: 'editor-1', name: 'Hater' })
    })
})

describe('askChoiceLabel (issue #27)', () => {
    it('editors are bare names; panels carry the marker and the cost', () => {
        expect(askChoiceLabel({ id: 'e', name: 'Hater' })).toBe('Hater')
        expect(askChoiceLabel({ id: 'e', name: 'Hater', kind: 'editor' })).toBe('Hater')
        expect(
            askChoiceLabel({ id: 'p', name: 'Publish panel', kind: 'panel', requestCount: 5 })
        ).toBe('Publish panel (panel · 5 requests)')
        expect(
            askChoiceLabel({ id: 'p', name: 'Solo panel', kind: 'panel', requestCount: 1 })
        ).toBe('Solo panel (panel · 1 request)')
    })
})
