import { describe, expect, it } from 'bun:test'
import type { EditorScopedSourceFinding } from '../commands/finding-navigation'
import type { FindingStatus } from '../services/orchestration/finding-store'
import { MIN_NAVIGABLE_FINDINGS, sectionNavigationView } from './panel-finding-nav'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function finding(overrides: {
    id: string
    editorId?: string
    from?: number
    status?: FindingStatus
    anchored?: boolean
    stale?: boolean
}): EditorScopedSourceFinding {
    const from = overrides.from ?? 0
    return {
        id: overrides.id,
        editorId: overrides.editorId ?? 'concision',
        status: overrides.status ?? 'open',
        anchor:
            overrides.anchored === false
                ? null
                : {
                      from,
                      to: from + 5,
                      state: overrides.stale === true ? 'stale' : 'anchored'
                  }
    }
}

const THREE = [
    finding({ id: 'a', from: 10 }),
    finding({ id: 'b', from: 20 }),
    finding({ id: 'c', from: 30 })
]

function view(
    findings: readonly EditorScopedSourceFinding[],
    currentFindingId: string | null = null
): ReturnType<typeof sectionNavigationView> {
    return sectionNavigationView(findings, 'concision', 'Concision Editor', currentFindingId)
}

// ---------------------------------------------------------------------------
// Which sections get controls
// ---------------------------------------------------------------------------

describe('sectionNavigationView — visibility', () => {
    it('renders nothing for an editor with no findings', () => {
        expect(view([]).visible).toBe(false)
    })

    it('renders nothing for a single finding — the row below IS the list', () => {
        expect(view([finding({ id: 'only', from: 10 })]).visible).toBe(false)
    })

    it('renders the controls from two revealable findings up', () => {
        const vm = view([finding({ id: 'a', from: 10 }), finding({ id: 'b', from: 20 })])
        expect(vm.visible).toBe(true)
        expect(vm.total).toBe(MIN_NAVIGABLE_FINDINGS)
    })

    it('does not count terminal findings — they are not revealable', () => {
        expect(
            view([
                finding({ id: 'a', from: 10 }),
                finding({ id: 'gone', from: 20, status: 'accepted' }),
                finding({ id: 'also-gone', from: 30, status: 'dismissed' })
            ]).visible
        ).toBe(false)
    })

    it('does not count unanchored findings — there is nowhere to step to', () => {
        expect(
            view([finding({ id: 'a', from: 10 }), finding({ id: 'orphan', anchored: false })])
                .visible
        ).toBe(false)
    })

    it('does not count stale findings — `revealFinding` refuses them', () => {
        expect(
            view([finding({ id: 'a', from: 10 }), finding({ id: 'stale', from: 20, stale: true })])
                .visible
        ).toBe(false)
    })

    it('ignores another editor entirely — a section steps through ITS findings', () => {
        expect(
            view([
                finding({ id: 'mine', from: 10 }),
                finding({ id: 'theirs', from: 20, editorId: 'hater' })
            ]).visible
        ).toBe(false)
    })
})

// ---------------------------------------------------------------------------
// The counter — read off the same ordered list the stepper walks
// ---------------------------------------------------------------------------

describe('sectionNavigationView — position', () => {
    it('says how many there are before the first step', () => {
        const vm = view(THREE)
        expect(vm.position).toBe(0)
        expect(vm.positionText).toBe('— of 3')
        expect(vm.groupAriaLabel).toBe(
            'Concision Editor: 3 findings to step through, none of them current yet'
        )
    })

    it('reports the current finding as "n of total"', () => {
        expect(view(THREE, 'b').positionText).toBe('2 of 3')
        expect(view(THREE, 'b').position).toBe(2)
        expect(view(THREE, 'b').groupAriaLabel).toBe('Concision Editor: finding 2 of 3')
    })

    it('numbers by DOCUMENT position, not arrival order', () => {
        // The store hands findings back in the order the editor reported
        // them; the stepper walks anchor order, so the counter must too.
        const arrival = [
            finding({ id: 'last', from: 30 }),
            finding({ id: 'first', from: 10 }),
            finding({ id: 'middle', from: 20 })
        ]
        expect(view(arrival, 'first').positionText).toBe('1 of 3')
        expect(view(arrival, 'middle').positionText).toBe('2 of 3')
        expect(view(arrival, 'last').positionText).toBe('3 of 3')
    })

    it('has no position when the cursor sits on ANOTHER editor’s finding', () => {
        // The triage cursor is per FILE, so this is the normal state of every
        // section but one. Claiming a position would be a lie.
        expect(view(THREE, 'someone-elses').positionText).toBe('— of 3')
    })

    it('has no position when the current finding left the set', () => {
        // Accepted, dismissed or gone stale under an edit: the cursor is
        // remembered but no longer points at anything steppable.
        const remaining = [finding({ id: 'a', from: 10 }), finding({ id: 'c', from: 30 })]
        expect(view(remaining, 'b').positionText).toBe('— of 2')
        expect(view(remaining, 'b').position).toBe(0)
    })

    it('counts only what the section shows — the hidden ones are already gone', () => {
        // The caller applies the severity lens before handing the list over,
        // so a filtered finding is neither counted nor steppable.
        expect(view([finding({ id: 'a', from: 10 }), finding({ id: 'b', from: 20 })]).total).toBe(2)
    })
})

// ---------------------------------------------------------------------------
// Accessible names
// ---------------------------------------------------------------------------

describe('sectionNavigationView — accessible names', () => {
    it('names the editor on both buttons', () => {
        // Every section carries an identically-labelled pair; the name has to
        // say which editor this one steps through (WCAG 2.4.6).
        const vm = view(THREE, 'a')
        expect(vm.previousAriaLabel).toBe('Previous finding from Concision Editor')
        expect(vm.nextAriaLabel).toBe('Next finding from Concision Editor')
    })

    it('carries the counter into the group name, since the pill is decorative', () => {
        expect(view(THREE, 'c').groupAriaLabel).toContain('3 of 3')
    })
})
