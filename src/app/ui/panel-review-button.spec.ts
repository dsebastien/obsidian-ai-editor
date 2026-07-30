import { describe, expect, it } from 'bun:test'
import { panelReviewButtonState } from './panel-review-button'
import type { PanelReviewButtonInput } from './panel-review-button'

const OK: PanelReviewButtonInput = {
    noteName: 'idea.md',
    gate: { status: 'ok' },
    busy: false
}

describe('panelReviewButtonState', () => {
    it('is enabled and names the bound note when a review could start', () => {
        const vm = panelReviewButtonState(OK)
        expect(vm.disabled).toBe(false)
        expect(vm.busy).toBe(false)
        expect(vm.text).toBe('Review')
        expect(vm.ariaLabel).toBe('Review idea.md')
        expect(vm.tooltip).toContain('idea.md')
    })

    it('is disabled with a generic tooltip when nothing is bound', () => {
        const vm = panelReviewButtonState({ noteName: null, gate: null, busy: false })
        expect(vm.disabled).toBe(true)
        expect(vm.busy).toBe(false)
        expect(vm.tooltip).toBe('Open a note to review it')
    })

    it('is disabled when a note name exists but no gate was evaluated', () => {
        const vm = panelReviewButtonState({ noteName: 'idea.md', gate: null, busy: false })
        expect(vm.disabled).toBe(true)
    })

    it('shows the busy state instead of dispatching while a run is in flight', () => {
        const vm = panelReviewButtonState({ ...OK, busy: true })
        expect(vm.busy).toBe(true)
        expect(vm.disabled).toBe(true)
        expect(vm.text).toBe('Reviewing…')
        expect(vm.ariaLabel).toBe('Reviewing idea.md')
        expect(vm.tooltip).toContain('already running')
    })

    it('busy wins over every gate refusal (a rule added mid-run does not hide the run)', () => {
        for (const gate of [
            { status: 'excluded' } as const,
            { status: 'rule-disabled', ruleLabel: 'Private notes' } as const,
            { status: 'no-editor' } as const
        ]) {
            const vm = panelReviewButtonState({ noteName: 'idea.md', gate, busy: true })
            expect(vm.busy).toBe(true)
            expect(vm.text).toBe('Reviewing…')
        }
    })

    it('refuses an excluded note and points at the Behavior tab', () => {
        const vm = panelReviewButtonState({ ...OK, gate: { status: 'excluded' } })
        expect(vm.disabled).toBe(true)
        expect(vm.busy).toBe(false)
        expect(vm.tooltip).toContain('excluded')
        expect(vm.tooltip).toContain('Behavior tab')
    })

    it('refuses a kill-switched note, naming the rule and the Rules tab', () => {
        const vm = panelReviewButtonState({
            ...OK,
            gate: { status: 'rule-disabled', ruleLabel: 'Journal' }
        })
        expect(vm.disabled).toBe(true)
        expect(vm.tooltip).toContain('Journal')
        expect(vm.tooltip).toContain('Rules tab')
    })

    it('refuses when no editor can review', () => {
        const vm = panelReviewButtonState({ ...OK, gate: { status: 'no-editor' } })
        expect(vm.disabled).toBe(true)
        expect(vm.tooltip).toContain('No editor')
    })

    it('always carries the bound note in the accessible name', () => {
        for (const gate of [
            { status: 'ok' } as const,
            { status: 'excluded' } as const,
            { status: 'rule-disabled', ruleLabel: 'r' } as const,
            { status: 'no-editor' } as const
        ]) {
            expect(panelReviewButtonState({ noteName: 'a.md', gate, busy: false }).ariaLabel).toBe(
                'Review a.md'
            )
        }
    })
})
