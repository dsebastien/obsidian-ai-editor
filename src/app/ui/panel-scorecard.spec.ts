import { describe, expect, it } from 'bun:test'
import { asFindingId } from '../domain/ids'
import type { PanelResult } from '../domain/operations/contract'
import { panelResultSchema } from '../domain/operations/contract'
import type { PanelRunState } from '../services/orchestration/run-controller'
import { buildScorecardView, resolveTopFixFinding, type TopFixCandidate } from './panel-scorecard'

function result(overrides: Partial<PanelResult> = {}): PanelResult {
    return panelResultSchema.parse({
        kind: 'aggregate-panel',
        recommendation: 'needs-work',
        memberVerdicts: [],
        topFixes: [],
        ...overrides
    })
}

function panel(overrides: Partial<PanelRunState> = {}): PanelRunState {
    return {
        panelId: 'p-1',
        panelName: 'Pre-publish Review',
        status: 'done',
        missingMembers: [],
        result: result(),
        error: null,
        ...overrides
    }
}

function candidate(id: string, editorName: string, quote: string): TopFixCandidate {
    return { id: asFindingId(id), editorName, quote }
}

describe('buildScorecardView status', () => {
    it('renders a view for every aggregation status — the reviews are never lost', () => {
        const statuses = [
            'waiting',
            'running',
            'done',
            'error',
            'cancelled',
            'skipped',
            'unavailable'
        ] as const
        for (const status of statuses) {
            const view = buildScorecardView(
                panel({ status, result: status === 'done' ? result() : null }),
                []
            )
            expect(view.panelName).toBe('Pre-publish Review')
            // The block sits directly above the member EDITORS' sections, so
            // the name has to say which kind it is (Business Rules #11) — the
            // ring next to it is decoration.
            expect(view.panelLabel).toBe('Pre-publish Review (panel)')
            expect(view.status.label.length).toBeGreaterThan(0)
        }
    })

    it('states that the member reviews survive a failed aggregation, and shows the reason', () => {
        const view = buildScorecardView(
            panel({ status: 'error', result: null, error: 'rate limit reached' }),
            []
        )
        expect(view.status.kind).toBe('failed')
        expect(view.status.label).toContain('member reviews below are unaffected')
        expect(view.status.detail).toBe('rate limit reached')
        expect(view.verdict).toBeNull()
    })

    it('points a missing aggregation backend at the setting that fixes it', () => {
        const view = buildScorecardView(panel({ status: 'unavailable', result: null }), [])
        expect(view.status.kind).toBe('unavailable')
        expect(view.status.label).toContain('Settings → Panels')
    })

    it('still names the missing members when aggregation never ran', () => {
        const view = buildScorecardView(
            panel({ status: 'skipped', result: null, missingMembers: ['A', 'B'] }),
            []
        )
        expect(view.missingMembers).toEqual(['A', 'B'])
        expect(view.members.map((entry) => entry.editorName)).toEqual(['A', 'B'])
        expect(view.members.every((entry) => entry.missing)).toBeTrue()
    })
})

describe('buildScorecardView verdicts', () => {
    it('relabels the overall verdict with the human vocabulary', () => {
        expect(buildScorecardView(panel(), []).verdict).toEqual({
            verdict: 'needs-work',
            label: 'Needs work'
        })
        expect(
            buildScorecardView(panel({ result: result({ recommendation: 'kill' }) }), []).verdict
                ?.label
        ).toBe('Not ready')
        expect(
            buildScorecardView(panel({ result: result({ recommendation: 'publish' }) }), []).verdict
                ?.label
        ).toBe('All good')
    })

    it('keeps the panel’s member order and relabels each verdict', () => {
        const view = buildScorecardView(
            panel({
                result: result({
                    memberVerdicts: [
                        { editorName: 'Hater', verdict: 'kill', keyPoint: 'Thesis collapses.' },
                        { editorName: 'Beginner', verdict: 'publish' }
                    ]
                })
            }),
            []
        )
        expect(view.members.map((entry) => entry.editorName)).toEqual(['Hater', 'Beginner'])
        expect(view.members[0]?.verdictLabel).toBe('Not ready')
        expect(view.members[0]?.keyPoint).toBe('Thesis collapses.')
        expect(view.members[1]?.verdictLabel).toBe('All good')
        expect(view.members[1]?.keyPoint).toBeNull()
    })

    it('appends a failed member the panel never mentioned, marked missing', () => {
        const view = buildScorecardView(
            panel({
                missingMembers: ['Fact Checker'],
                result: result({ memberVerdicts: [{ editorName: 'Hater', verdict: 'kill' }] })
            }),
            []
        )
        expect(view.members.map((entry) => entry.editorName)).toEqual(['Hater', 'Fact Checker'])
        expect(view.members[1]?.missing).toBeTrue()
        expect(view.members[1]?.verdict).toBeNull()
    })

    it('marks a member the panel listed AND reported missing', () => {
        const view = buildScorecardView(
            panel({
                missingMembers: ['Hater'],
                result: result({ memberVerdicts: [{ editorName: 'Hater' }] })
            }),
            []
        )
        expect(view.members).toHaveLength(1)
        expect(view.members[0]?.missing).toBeTrue()
    })
})

describe('buildScorecardView dissent and top fixes', () => {
    it('carries dissent through as structure, one entry per subject', () => {
        const view = buildScorecardView(
            panel({
                result: result({
                    dissent: [
                        {
                            subject: 'Whether the opening works',
                            positions: [
                                { editorName: 'Hater', stance: 'It buries the point' },
                                { editorName: 'Beginner', stance: 'Clear enough' }
                            ]
                        }
                    ]
                })
            }),
            []
        )
        expect(view.dissent).toHaveLength(1)
        expect(view.dissent[0]?.positions.map((p) => p.editorName)).toEqual(['Hater', 'Beginner'])
    })

    it('ranks top fixes in the order the panel gave them', () => {
        const view = buildScorecardView(
            panel({
                result: result({
                    topFixes: [{ action: 'Cut the second half' }, { action: 'Cite the claim' }]
                })
            }),
            []
        )
        expect(view.topFixes.map((fix) => fix.rank)).toEqual([1, 2])
        expect(view.topFixes.map((fix) => fix.action)).toEqual([
            'Cut the second half',
            'Cite the claim'
        ])
    })

    it('resolves a top fix to the finding it quotes', () => {
        const findings = [
            candidate('f-1', 'Hater', 'the weak opening'),
            candidate('f-2', 'Beginner', 'a jargon-heavy line')
        ]
        const view = buildScorecardView(
            panel({
                result: result({
                    topFixes: [
                        { action: 'Rewrite it', editorName: 'Hater', quote: 'the weak opening' },
                        { action: 'Cut the second half' }
                    ]
                })
            }),
            findings
        )
        expect(view.topFixes[0]?.findingId).toBe(asFindingId('f-1'))
        expect(view.topFixes[0]?.editorName).toBe('Hater')
        // A structural fix keeps its row without a pointer.
        expect(view.topFixes[1]?.findingId).toBeNull()
    })
})

describe('resolveTopFixFinding', () => {
    const findings = [
        candidate('f-1', 'Hater', 'the   weak opening'),
        candidate('f-2', 'Beginner', 'the weak opening'),
        candidate('f-3', 'Hater', 'a second span')
    ]

    it('is null without a quote — a fix that points at nothing reveals nothing', () => {
        expect(resolveTopFixFinding({ editorName: 'Hater' }, findings)).toBeNull()
        expect(resolveTopFixFinding({ quote: '' }, findings)).toBeNull()
    })

    it('prefers an exact match inside the credited member', () => {
        expect(
            resolveTopFixFinding({ editorName: 'Hater', quote: 'the   weak opening' }, findings)
        ).toBe(asFindingId('f-1'))
    })

    it('falls back to an exact match from any member', () => {
        expect(
            resolveTopFixFinding({ editorName: 'Fact Checker', quote: 'a second span' }, findings)
        ).toBe(asFindingId('f-3'))
    })

    it('never lets a normalized match displace an exact one from another member', () => {
        // 'the weak opening' matches f-2 exactly and f-1 only after
        // normalization, even though f-1 belongs to the credited member.
        expect(
            resolveTopFixFinding({ editorName: 'Hater', quote: 'the weak opening' }, findings)
        ).toBe(asFindingId('f-2'))
    })

    it('normalizes whitespace and case only when nothing matched exactly', () => {
        expect(resolveTopFixFinding({ quote: 'A SECOND\n  span' }, findings)).toBe(
            asFindingId('f-3')
        )
    })

    it('returns null rather than guessing at an unknown quote', () => {
        expect(
            resolveTopFixFinding({ editorName: 'Hater', quote: 'never said this' }, findings)
        ).toBeNull()
    })
})
