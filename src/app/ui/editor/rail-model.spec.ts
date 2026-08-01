import { describe, expect, it } from 'bun:test'
import {
    DAEMON_ARMED_TITLE,
    DAEMON_LABEL,
    NAME_ELLIPSIS,
    NAME_MAX_CHARS,
    NAME_MAX_CHARS_COMPACT,
    NARROW_PANEL_HINT,
    buildRailViewModel,
    chipClickAction,
    editorRing,
    panelRing,
    railErrorReason,
    railMotion,
    truncateName
} from './rail-model'
import type {
    RailEditorState,
    RailEditorStatus,
    RailMotionState,
    RailPanelState,
    RailState,
    RailViewModel
} from './rail-model'

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

    describe('narrow pane (compact form)', () => {
        it('is not compact by default', () => {
            const vm = buildRailViewModel(state())
            expect(vm.compact).toBe(false)
            expect(vm.button.tooltip).not.toContain(NARROW_PANEL_HINT)
            expect(vm.button.tooltip).toBe(vm.button.ariaLabel)
        })

        it('keeps the button LABELLED in a narrow pane', () => {
            // The compact form used to swap the label for a glyph. Every row
            // next to it now carries a name, so a lone glyph button was the
            // one unreadable control on a rail otherwise made of words.
            const review = buildRailViewModel(state({ narrow: true }))
            expect(review.compact).toBe(true)
            expect(review.button.label).toBe('Review')
            expect(review.button.action).toBe('review')

            const cancel = buildRailViewModel(state({ narrow: true, running: true }))
            expect(cancel.button.label).toBe('Cancel')
            expect(cancel.button.action).toBe('cancel')
        })

        it('keeps every editor name visible, only shorter', () => {
            // The whole point of the redesign: a narrow pane makes the rail
            // denser, it never hides the names.
            const long = editor({ name: 'Ruthlessly Concise Structural Editor' })
            const wide = buildRailViewModel(state({ editors: [long] }))
            const narrow = buildRailViewModel(state({ narrow: true, editors: [long] }))

            expect(wide.dots[0]?.displayName.length).toBeGreaterThan(
                narrow.dots[0]?.displayName.length ?? 0
            )
            expect(narrow.dots[0]?.displayName.length).toBeGreaterThan(0)
            expect(narrow.dots[0]?.displayName).toStartWith('Ruthlessly')
            // The full name is never lost: it is the accessible name.
            expect(narrow.dots[0]?.ariaLabel).toContain(long.name)
            expect(narrow.dots[0]?.name).toBe(long.name)
        })

        it('drops the daemon word but never its state', () => {
            const wide = buildRailViewModel(state({ daemonMode: true })).daemon
            const narrow = buildRailViewModel(state({ narrow: true, daemonMode: true })).daemon
            expect(wide.label).toBe(DAEMON_LABEL)
            expect(narrow.label).toBeNull()
            expect(narrow.text).toBe(wide.text)
            expect(narrow.ariaLabel).toBe(wide.ariaLabel)
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

    describe('rows', () => {
        it('shows every editor name as text, not only as a tooltip', () => {
            const vm = buildRailViewModel(
                state({
                    editors: [
                        editor({ id: 'a', name: 'Hater' }),
                        editor({ id: 'b', name: 'Beginner' })
                    ]
                })
            )
            expect(vm.dots.map((dot) => dot.displayName)).toEqual(['Hater', 'Beginner'])
            expect(vm.dots.every((dot) => dot.displayName === dot.name)).toBeTrue()
        })

        it('bounds an absurd name rather than letting it size the rail', () => {
            const name = 'A'.repeat(400)
            const vm = buildRailViewModel(state({ editors: [editor({ name })] }))
            expect(vm.dots[0]?.displayName.length).toBe(NAME_MAX_CHARS)
            expect(vm.dots[0]?.displayName).toEndWith(NAME_ELLIPSIS)
            // Truncated visibly, never in the accessible name (WCAG 2.5.3:
            // the visible text stays a prefix of the accessible name).
            expect(vm.dots[0]?.ariaLabel).toContain(name)
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

    describe('daemon toggle', () => {
        it('is present with daemon mode off — it is what turns it on', () => {
            const daemon = buildRailViewModel(state()).daemon
            expect(daemon.enabled).toBe(false)
            expect(daemon.armed).toBe(false)
            expect(daemon.ariaLabel).toBe('Daemon mode off')
        })

        it('warns what the click starts while the mode is off', () => {
            // The cost belongs on the OFF tooltip, where it describes what
            // the next click begins — not on ON, where it would nag about a
            // decision already made.
            const daemon = buildRailViewModel(state()).daemon
            expect(daemon.tooltip).toMatch(/calls your backends/i)
        })

        it('reports the mode as on without an armed refresh', () => {
            const daemon = buildRailViewModel(state({ daemonMode: true })).daemon
            expect(daemon.enabled).toBe(true)
            expect(daemon.armed).toBe(false)
            expect(daemon.ariaLabel).toBe('Daemon mode on')
            expect(daemon.tooltip).toMatch(/Click to turn it off/i)
        })

        it('adds the armed state on the same control, not a second one', () => {
            const daemon = buildRailViewModel(state({ daemonMode: true, daemonArmed: true })).daemon
            expect(daemon.enabled).toBe(true)
            expect(daemon.armed).toBe(true)
            expect(daemon.ariaLabel).toBe('Daemon mode on, refresh armed')
            expect(daemon.tooltip).toContain(DAEMON_ARMED_TITLE)
        })

        it('never reports armed while the mode is off', () => {
            // `daemonArmed` is fed from the scheduler and the mode from
            // settings; a stale arm must not render as a running countdown.
            const daemon = buildRailViewModel(state({ daemonArmed: true })).daemon
            expect(daemon.enabled).toBe(false)
            expect(daemon.armed).toBe(false)
        })
    })
})

describe('truncateName', () => {
    it('leaves a name that fits untouched', () => {
        expect(truncateName('Hater', 28)).toBe('Hater')
        expect(truncateName('12345', 5)).toBe('12345')
    })

    it('cuts to the budget INCLUDING the ellipsis', () => {
        expect(truncateName('123456789', 5)).toBe(`1234${NAME_ELLIPSIS}`)
        expect(truncateName('123456789', 5).length).toBe(5)
    })

    it('never leaves a space dangling before the ellipsis', () => {
        expect(truncateName('Concision Editor', 11)).toBe(`Concision${NAME_ELLIPSIS}`)
    })

    it('degrades to the ellipsis alone rather than to an empty row', () => {
        expect(truncateName('Hater', 1)).toBe(NAME_ELLIPSIS)
        expect(truncateName('Hater', 0)).toBe(NAME_ELLIPSIS)
        expect(truncateName('Hater', -3)).toBe(NAME_ELLIPSIS)
    })

    it('gives a narrow pane a smaller budget than a wide one', () => {
        expect(NAME_MAX_CHARS_COMPACT).toBeLessThan(NAME_MAX_CHARS)
        // Both still leave room for a real name, not an acronym.
        expect(NAME_MAX_CHARS_COMPACT).toBeGreaterThan(8)
    })
})

describe('ring mapping', () => {
    it('maps every editor status to exactly one ring', () => {
        expect(editorRing('idle')).toBe('idle')
        expect(editorRing('pending')).toBe('pending')
        expect(editorRing('running')).toBe('busy')
        expect(editorRing('transforming')).toBe('busy')
        expect(editorRing('done')).toBe('done')
        expect(editorRing('error')).toBe('error')
        expect(editorRing('cancelled')).toBe('muted')
    })

    it('maps every scorecard status to the same ring vocabulary', () => {
        expect(panelRing('waiting')).toBe('pending')
        expect(panelRing('running')).toBe('busy')
        expect(panelRing('ready')).toBe('done')
        expect(panelRing('failed')).toBe('error')
        expect(panelRing('cancelled')).toBe('muted')
        expect(panelRing('skipped')).toBe('muted')
        expect(panelRing('unavailable')).toBe('muted')
    })

    it('is what the row view models carry', () => {
        const vm = buildRailViewModel(
            state({
                editors: [editor({ status: 'running' })],
                panel: {
                    name: 'Pre-publish review',
                    color: 'var(--color-pink)',
                    status: 'waiting',
                    memberIds: ['editor-1']
                }
            })
        )
        expect(vm.dots[0]?.ring).toBe('busy')
        expect(vm.panel?.ring).toBe('pending')
        expect(vm.panel?.displayName).toBe('Pre-publish review')
    })
})

describe('railMotion', () => {
    function view(overrides: Partial<RailState> = {}): RailViewModel {
        return buildRailViewModel(state(overrides))
    }

    function advance(previous: RailMotionState | null, overrides: Partial<RailState> = {}) {
        return railMotion(previous, view(overrides))
    }

    it('plays nothing on the very first render of a rail with no run', () => {
        const { cues } = advance(null)
        expect(cues).toEqual({ stagger: false, bumped: [], settled: [], panelSettled: false })
    })

    it('staggers the rows in when a run starts', () => {
        const first = advance(null)
        const second = railMotion(first.state, view({ runKey: 'snap-1', running: true }))
        expect(second.cues.stagger).toBeTrue()
    })

    it('does not re-stagger on every render inside one run', () => {
        const start = railMotion(null, view({ runKey: 'snap-1', running: true }))
        const streaming = railMotion(
            start.state,
            view({
                runKey: 'snap-1',
                running: true,
                editors: [editor({ status: 'running', findingCount: 1 })]
            })
        )
        expect(streaming.cues.stagger).toBeFalse()
    })

    it('staggers again for the NEXT run', () => {
        const first = railMotion(null, view({ runKey: 'snap-1', running: true }))
        const second = railMotion(first.state, view({ runKey: 'snap-2', running: true }))
        expect(second.cues.stagger).toBeTrue()
    })

    it('bumps a count badge that changed value', () => {
        const two = railMotion(
            null,
            view({ runKey: 'snap-1', editors: [editor({ status: 'running', findingCount: 2 })] })
        )
        const three = railMotion(
            two.state,
            view({ runKey: 'snap-1', editors: [editor({ status: 'running', findingCount: 3 })] })
        )
        expect(three.cues.bumped).toEqual(['editor-1'])
    })

    it('does not bump a badge that did not change, nor one that went away', () => {
        const two = railMotion(
            null,
            view({ runKey: 'snap-1', editors: [editor({ status: 'running', findingCount: 2 })] })
        )
        const same = railMotion(
            two.state,
            view({ runKey: 'snap-1', editors: [editor({ status: 'done', findingCount: 2 })] })
        )
        expect(same.cues.bumped).toEqual([])
        const gone = railMotion(
            two.state,
            view({ runKey: 'snap-1', editors: [editor({ status: 'idle', findingCount: 0 })] })
        )
        expect(gone.cues.bumped).toEqual([])
    })

    it('never bumps a row that is appearing for the first time', () => {
        const first = railMotion(null, view({ runKey: 'snap-1', editors: [editor({ id: 'a' })] }))
        const added = railMotion(
            first.state,
            view({
                runKey: 'snap-1',
                editors: [editor({ id: 'a' }), editor({ id: 'b', status: 'done', findingCount: 4 })]
            })
        )
        expect(added.cues.bumped).toEqual([])
    })

    it('reports an editor settling out of flight', () => {
        const running = railMotion(
            null,
            view({ runKey: 'snap-1', editors: [editor({ status: 'running' })] })
        )
        for (const status of ['done', 'error', 'cancelled'] as const) {
            const settled = railMotion(
                running.state,
                view({ runKey: 'snap-1', editors: [editor({ status })] })
            )
            expect(settled.cues.settled).toEqual(['editor-1'])
        }
    })

    it('does not report a run being dropped as everyone settling', () => {
        // Every editor back to `idle` is the run going away, not seven
        // editors finishing at once.
        const running = railMotion(
            null,
            view({ runKey: 'snap-1', editors: [editor({ status: 'running' })] })
        )
        const dropped = railMotion(running.state, view({ editors: [editor({ status: 'idle' })] }))
        expect(dropped.cues.settled).toEqual([])
    })

    it('suppresses per-row cues while the whole list is animating in', () => {
        const before = railMotion(
            null,
            view({ runKey: 'snap-1', editors: [editor({ status: 'running', findingCount: 2 })] })
        )
        const newRun = railMotion(
            before.state,
            view({ runKey: 'snap-2', editors: [editor({ status: 'done', findingCount: 9 })] })
        )
        expect(newRun.cues).toEqual({
            stagger: true,
            bumped: [],
            settled: [],
            panelSettled: false
        })
    })

    it('reports the panel settling, once', () => {
        const panel = (status: RailPanelState['status']): Partial<RailState> => ({
            runKey: 'snap-1',
            panel: {
                name: 'Pre-publish review',
                color: 'var(--color-pink)',
                status,
                memberIds: ['editor-1']
            }
        })
        const running = railMotion(null, view(panel('running')))
        const ready = railMotion(running.state, view(panel('ready')))
        expect(ready.cues.panelSettled).toBeTrue()
        const again = railMotion(ready.state, view(panel('ready')))
        expect(again.cues.panelSettled).toBeFalse()
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
                name: 'Pre-publish review',
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
        expect(vm.panel?.ariaLabel).toContain('Pre-publish review (panel)')
        expect(vm.panel?.title).toContain('open the AI Editor Review panel')
    })

    it('names the member GROUP as a panel too — the bracket is decoration', () => {
        expect(buildRailViewModel(withPanel()).panel?.groupLabel).toBe('Pre-publish review (panel)')
    })

    it('carries the verdict as the chip badge once the scorecard exists', () => {
        expect(buildRailViewModel(withPanel()).panel?.badge).toBe('Needs work')
    })

    it('carries the verdict in the accessible name too, not only in the badge', () => {
        // The badge is aria-hidden and disappears in compact mode, so a
        // verdict living only there reaches nobody in a narrow pane and no
        // screen reader anywhere (WCAG 2.5.3 — the chip's only visible text).
        const vm = buildRailViewModel(withPanel())
        expect(vm.panel?.ariaLabel).toContain('Needs work')
        expect(vm.panel?.title).toContain('Needs work')
    })

    it('has no badge while the scorecard does not exist yet', () => {
        const vm = buildRailViewModel(
            state({
                editors: members,
                panel: {
                    name: 'Pre-publish review',
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
                'Pre-publish review (panel) — '.length
            )
        }
    })
})
