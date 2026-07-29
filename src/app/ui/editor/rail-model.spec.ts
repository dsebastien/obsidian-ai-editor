import { describe, expect, it } from 'bun:test'
import { buildRailViewModel } from './rail-model'
import type { RailEditorState, RailState } from './rail-model'

function editor(overrides: Partial<RailEditorState> = {}): RailEditorState {
    return {
        id: 'editor-1',
        name: 'Concision Editor',
        color: '#ff0000',
        status: 'idle',
        findingCount: 0,
        ...overrides
    }
}

function state(overrides: Partial<RailState> = {}): RailState {
    return { editors: [editor()], running: false, ...overrides }
}

describe('buildRailViewModel', () => {
    describe('button', () => {
        it('shows Review when no run is in flight', () => {
            const vm = buildRailViewModel(state({ running: false }))
            expect(vm.button.label).toBe('Review')
            expect(vm.button.action).toBe('review')
            expect(vm.button.disabled).toBe(false)
            expect(vm.button.ariaLabel.length).toBeGreaterThan(0)
        })

        it('shows Cancel while running', () => {
            const vm = buildRailViewModel(state({ running: true }))
            expect(vm.button.label).toBe('Cancel')
            expect(vm.button.action).toBe('cancel')
            expect(vm.button.disabled).toBe(false)
        })

        it('disables Review when there are no editors', () => {
            const vm = buildRailViewModel(state({ editors: [] }))
            expect(vm.button.action).toBe('review')
            expect(vm.button.disabled).toBe(true)
            expect(vm.dots).toEqual([])
        })
    })

    describe('dots', () => {
        it('carries editor identity, color, and status through', () => {
            const vm = buildRailViewModel(
                state({ editors: [editor({ id: 'e-9', color: 'rgb(1, 2, 3)', status: 'done' })] })
            )
            expect(vm.dots).toHaveLength(1)
            const dot = vm.dots[0]
            expect(dot?.editorId).toBe('e-9')
            expect(dot?.color).toBe('rgb(1, 2, 3)')
            expect(dot?.status).toBe('done')
        })

        it('shows no badge at zero findings', () => {
            const vm = buildRailViewModel(state({ editors: [editor({ status: 'done' })] }))
            expect(vm.dots[0]?.badge).toBeNull()
        })

        it('shows the finding count as badge, capped at 99+', () => {
            const editors = [
                editor({ id: 'a', status: 'done', findingCount: 1 }),
                editor({ id: 'b', status: 'done', findingCount: 42 }),
                editor({ id: 'c', status: 'done', findingCount: 100 })
            ]
            const vm = buildRailViewModel(state({ editors }))
            expect(vm.dots.map((d) => d.badge)).toEqual(['1', '42', '99+'])
        })

        it('badges live counts while running (streamed findings)', () => {
            const vm = buildRailViewModel(
                state({ editors: [editor({ status: 'running', findingCount: 3 })], running: true })
            )
            expect(vm.dots[0]?.badge).toBe('3')
            expect(vm.dots[0]?.ariaLabel).toContain('3 findings')
        })

        it('labels each status for assistive tech, with singular/plural counts', () => {
            const byStatus = (s: RailEditorState) =>
                buildRailViewModel(state({ editors: [s] })).dots[0]

            expect(byStatus(editor({ status: 'idle' }))?.ariaLabel).toBe('Concision Editor: idle')
            expect(byStatus(editor({ status: 'running' }))?.ariaLabel).toBe(
                'Concision Editor: reviewing'
            )
            expect(byStatus(editor({ status: 'done', findingCount: 1 }))?.ariaLabel).toBe(
                'Concision Editor: 1 finding'
            )
            expect(byStatus(editor({ status: 'done', findingCount: 8 }))?.ariaLabel).toBe(
                'Concision Editor: 8 findings'
            )
            expect(byStatus(editor({ status: 'error' }))?.ariaLabel).toBe(
                'Concision Editor: failed'
            )
        })

        it('uses the aria-label as the hover title', () => {
            const vm = buildRailViewModel(state())
            expect(vm.dots[0]?.title).toBe(vm.dots[0]?.ariaLabel ?? '')
        })
    })
})
