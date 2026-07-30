import { describe, expect, it } from 'bun:test'
import type { EditorRunState } from '../services/orchestration/run-controller'
import { generateMoreView } from './generate-more'

type Input = Pick<EditorRunState, 'status' | 'editorName' | 'continuing' | 'continuationError'>

function state(overrides: Partial<Input> = {}): Input {
    return {
        status: 'done',
        editorName: 'Hater',
        continuing: false,
        continuationError: null,
        ...overrides
    }
}

describe('generateMoreView', () => {
    it('states how many findings the round would add to', () => {
        // Every press is a paid request on a note that already has findings:
        // the count is what makes it read as "add to these", not "refresh".
        const view = generateMoreView(state(), 3)
        expect(view.visible).toBeTrue()
        expect(view.text).toBe('Generate more (3)')
        expect(view.ariaLabel).toBe(
            'Ask Hater for more findings, on top of the 3 it already reported'
        )
        expect(view.disabled).toBeFalse()
    })

    it('says "the 1" rather than "the 1 findings"', () => {
        expect(generateMoreView(state(), 1).ariaLabel).toContain('on top of the 1 it already')
    })

    it('offers a round after a pass that found nothing — that is a real answer to challenge', () => {
        expect(generateMoreView(state(), 0).text).toBe('Generate more (0)')
    })

    it('is disabled, not hidden, while its own pass runs — one press is one round', () => {
        const view = generateMoreView(state({ status: 'running', continuing: true }), 2)
        expect(view.visible).toBeTrue()
        expect(view.busy).toBeTrue()
        expect(view.disabled).toBeTrue()
        expect(view.text).toBe('Generating…')
    })

    it('is absent for an editor that never finished — there is nothing to extend', () => {
        for (const status of ['pending', 'running', 'error', 'cancelled'] as const) {
            expect(generateMoreView(state({ status }), 0).visible).toBeFalse()
        }
    })

    it('reports a failed pass beside the button, with the editor still done', () => {
        // The completed pass's findings are untouched; the section must not
        // look broken because an optional extra round did not land.
        const view = generateMoreView(state({ continuationError: 'Timed out' }), 4)
        expect(view.visible).toBeTrue()
        expect(view.disabled).toBeFalse()
        expect(view.error).toBe('Timed out')
    })
})
