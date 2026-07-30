import { describe, expect, it } from 'bun:test'
import {
    DAEMON_ARMED_TITLE,
    NARROW_PANEL_HINT,
    buildRailViewModel,
    chipClickAction,
    railErrorReason
} from './rail-model'
import type { RailEditorState, RailEditorStatus, RailPanelState, RailState } from './rail-model'

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

        it('shows the label as text in a wide pane', () => {
            expect(buildRailViewModel(state()).button.text).toBe('Review')
            expect(buildRailViewModel(state({ running: true })).button.text).toBe('Cancel')
        })
    })

    describe('narrow pane (compact form)', () => {
        it('is not compact by default', () => {
            const vm = buildRailViewModel(state())
            expect(vm.compact).toBe(false)
            expect(vm.button.tooltip).not.toContain(NARROW_PANEL_HINT)
            expect(vm.button.tooltip).toBe(vm.button.ariaLabel)
        })

        it('replaces the button label with a glyph, keeping the semantics', () => {
            const review = buildRailViewModel(state({ narrow: true }))
            expect(review.compact).toBe(true)
            expect(review.button.label).toBe('Review')
            expect(review.button.action).toBe('review')
            expect(review.button.text).not.toBe('Review')
            expect(review.button.text.length).toBeGreaterThan(0)

            const cancel = buildRailViewModel(state({ narrow: true, running: true }))
            expect(cancel.button.label).toBe('Cancel')
            expect(cancel.button.text).not.toBe('Cancel')
            expect(cancel.button.text).not.toBe(review.button.text)
        })

        it('nudges towards the side panel in the button tooltip only', () => {
            const vm = buildRailViewModel(state({ narrow: true }))
            expect(vm.button.tooltip).toContain('Review this note')
            expect(vm.button.tooltip).toContain(NARROW_PANEL_HINT)
            // The accessible name names the control; it never becomes an
            // instruction paragraph, and it is the same in both layouts.
            expect(vm.button.ariaLabel).toBe('Review this note with the enabled editors')
            expect(buildRailViewModel(state()).button.ariaLabel).toBe(vm.button.ariaLabel)
        })

        it('points the hint at a command that exists', () => {
            // The palette entry is "Open review panel" (review-commands.ts) —
            // following the hint must open the panel, not start a review.
            expect(NARROW_PANEL_HINT).toContain('Open review panel')
        })

        it('keeps the disabled rule and the chips unchanged', () => {
            const wide = buildRailViewModel(state({ editors: [editor({ findingCount: 3 })] }))
            const narrow = buildRailViewModel(
                state({ narrow: true, editors: [editor({ findingCount: 3 })] })
            )
            expect(narrow.dots).toEqual(wide.dots)
            expect(buildRailViewModel(state({ narrow: true, editors: [] })).button.disabled).toBe(
                true
            )
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

        it('labels each status as "name — status", with singular/plural counts', () => {
            const byStatus = (s: RailEditorState) =>
                buildRailViewModel(state({ editors: [s] })).dots[0]

            expect(byStatus(editor({ status: 'idle' }))?.ariaLabel).toBe('Concision Editor — idle')
            expect(byStatus(editor({ status: 'pending' }))?.ariaLabel).toBe(
                'Concision Editor — waiting'
            )
            expect(byStatus(editor({ status: 'running' }))?.ariaLabel).toBe(
                'Concision Editor — reviewing'
            )
            expect(byStatus(editor({ status: 'transforming' }))?.ariaLabel).toBe(
                'Concision Editor — transforming'
            )
            expect(byStatus(editor({ status: 'done', findingCount: 1 }))?.ariaLabel).toBe(
                'Concision Editor — 1 finding'
            )
            expect(byStatus(editor({ status: 'done', findingCount: 8 }))?.ariaLabel).toBe(
                'Concision Editor — 8 findings'
            )
            expect(byStatus(editor({ status: 'error' }))?.ariaLabel).toBe(
                'Concision Editor — failed'
            )
            expect(byStatus(editor({ status: 'cancelled' }))?.ariaLabel).toBe(
                'Concision Editor — cancelled'
            )
        })

        it('appends the short failure reason to a failed label', () => {
            const vm = buildRailViewModel(
                state({ editors: [editor({ status: 'error', errorReason: 'timeout' })] })
            )
            expect(vm.dots[0]?.ariaLabel).toBe('Concision Editor — failed (timeout)')
            expect(vm.dots[0]?.title).toBe('Concision Editor — failed (timeout)')
        })

        it('counts findings streamed so far into the running label', () => {
            const vm = buildRailViewModel(
                state({ editors: [editor({ status: 'running', findingCount: 2 })], running: true })
            )
            expect(vm.dots[0]?.ariaLabel).toBe('Concision Editor — reviewing, 2 findings so far')
        })

        it('uses the aria-label as the hover title', () => {
            const vm = buildRailViewModel(state())
            expect(vm.dots[0]?.title).toBe(vm.dots[0]?.ariaLabel ?? '')
        })

        it('offers a retry affordance only on failed and cancelled editors', () => {
            const byStatus = (s: RailEditorState) =>
                buildRailViewModel(state({ editors: [s] })).dots[0]

            expect(byStatus(editor({ status: 'error' }))?.retryAriaLabel).toBe(
                'Retry Concision Editor'
            )
            expect(byStatus(editor({ status: 'cancelled' }))?.retryAriaLabel).toBe(
                'Retry Concision Editor'
            )
            expect(byStatus(editor({ status: 'idle' }))?.retryAriaLabel).toBeNull()
            expect(byStatus(editor({ status: 'pending' }))?.retryAriaLabel).toBeNull()
            expect(byStatus(editor({ status: 'running' }))?.retryAriaLabel).toBeNull()
            expect(byStatus(editor({ status: 'transforming' }))?.retryAriaLabel).toBeNull()
            expect(byStatus(editor({ status: 'done' }))?.retryAriaLabel).toBeNull()
        })
    })

    describe('railErrorReason', () => {
        it('maps operation error codes to short human reasons', () => {
            expect(railErrorReason('timeout')).toBe('timeout')
            expect(railErrorReason('network')).toBe('network')
            expect(railErrorReason('auth')).toBe('authentication')
            expect(railErrorReason('rate-limit')).toBe('rate limit')
            expect(railErrorReason('invalid-output')).toBe('invalid output')
        })

        it('returns undefined for codes with no useful short form', () => {
            expect(railErrorReason('unknown')).toBeUndefined()
            expect(railErrorReason('cancelled')).toBeUndefined()
            expect(railErrorReason('')).toBeUndefined()
        })
    })

    describe('daemon indicator', () => {
        it('is absent by default and when not armed', () => {
            expect(buildRailViewModel(state()).daemon).toBeNull()
            expect(buildRailViewModel(state({ daemonArmed: false })).daemon).toBeNull()
        })

        it('carries the tooltip text while a daemon refresh is armed', () => {
            const vm = buildRailViewModel(state({ daemonArmed: true }))
            expect(vm.daemon).toEqual({ title: DAEMON_ARMED_TITLE })
        })
    })
})

describe('chipClickAction', () => {
    const inFlight: RailEditorStatus[] = ['pending', 'running', 'transforming']

    it('is a no-op while the chip is in flight, even with revealable findings', () => {
        for (const status of inFlight) {
            expect(chipClickAction(status, 0, false)).toBe('none')
            expect(chipClickAction(status, 3, true)).toBe('none')
        }
    })

    it('cycles findings when the editor has revealable findings', () => {
        expect(chipClickAction('done', 1, false)).toBe('cycle-findings')
        expect(chipClickAction('done', 5, true)).toBe('cycle-findings')
        // Partial results before a failure/cancellation stay revealable.
        expect(chipClickAction('error', 2, true)).toBe('cycle-findings')
        expect(chipClickAction('cancelled', 2, false)).toBe('cycle-findings')
    })

    it('opens the panel with zero revealable findings but a summary or error', () => {
        expect(chipClickAction('done', 0, true)).toBe('open-panel')
        expect(chipClickAction('error', 0, true)).toBe('open-panel')
        expect(chipClickAction('cancelled', 0, true)).toBe('open-panel')
    })

    it('does nothing when there is nothing to show', () => {
        expect(chipClickAction('idle', 0, false)).toBe('none')
        expect(chipClickAction('done', 0, false)).toBe('none')
    })
})

describe('buildRailViewModel panel entity (Business Rules #11)', () => {
    const members = [
        editor({ id: 'e-1', name: 'Hater' }),
        editor({ id: 'e-2', name: 'Beginner' }),
        editor({ id: 'e-3', name: 'Outsider' })
    ]

    function withPanel(overrides: Partial<RailPanelState> = {}): RailState {
        return state({
            editors: members,
            panel: {
                name: 'Pre-publish Review',
                color: 'var(--color-pink)',
                status: 'ready',
                memberIds: ['e-1', 'e-2'],
                verdictLabel: 'Needs work',
                ...overrides
            }
        })
    }

    it('has no panel at all for a solo run', () => {
        const vm = buildRailViewModel(state())
        expect(vm.panel).toBeNull()
        expect(vm.dots.every((dot) => !dot.member)).toBeTrue()
    })

    it('marks exactly the panel’s members, leaving other editors their own', () => {
        const vm = buildRailViewModel(withPanel())
        expect(vm.dots.map((dot) => dot.member)).toEqual([true, true, false])
    })

    it('names the panel as a panel in its accessible name, not only by shape', () => {
        // A ring is invisible to assistive tech; #11 has to hold there too.
        const vm = buildRailViewModel(withPanel())
        expect(vm.panel?.ariaLabel).toContain('Pre-publish Review (panel)')
        expect(vm.panel?.title).toContain('open the review panel')
    })

    it('carries the verdict as the chip badge once the scorecard exists', () => {
        expect(buildRailViewModel(withPanel()).panel?.badge).toBe('Needs work')
    })

    it('has no badge while the scorecard does not exist yet', () => {
        const vm = buildRailViewModel(
            state({
                editors: members,
                panel: {
                    name: 'Pre-publish Review',
                    color: 'var(--color-pink)',
                    status: 'running',
                    memberIds: ['e-1', 'e-2']
                }
            })
        )
        expect(vm.panel?.badge).toBeNull()
    })

    it('says what happened for every aggregation outcome', () => {
        const kinds = [
            'waiting',
            'running',
            'ready',
            'failed',
            'cancelled',
            'skipped',
            'unavailable'
        ] as const
        for (const status of kinds) {
            const vm = buildRailViewModel(withPanel({ status }))
            expect(vm.panel?.status).toBe(status)
            expect(vm.panel?.ariaLabel.length).toBeGreaterThan(
                'Pre-publish Review (panel) — '.length
            )
        }
    })
})
