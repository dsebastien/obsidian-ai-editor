import { describe, expect, it } from 'bun:test'
import { asFindingId } from '../domain/ids'
import type { PanelResult } from '../domain/operations/contract'
import { panelResultSchema } from '../domain/operations/contract'
import type { PanelRunState } from '../services/orchestration/run-controller'
import {
    buildScorecardView,
    resolveTopFix,
    scorecardMemberName,
    type TopFixCandidate
} from './panel-scorecard'

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
        panelName: 'Pre-publish review',
        memberNames: ['Hater', 'Beginner'],
        status: 'done',
        missingMembers: [],
        result: result(),
        resultStale: false,
        error: null,
        errorDiagnostics: null,
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
            expect(view.panelName).toBe('Pre-publish review')
            // The block sits directly above the member EDITORS' sections, so
            // the name has to say which kind it is (Business Rules #11) — the
            // ring next to it is decoration.
            expect(view.panelLabel).toBe('Pre-publish review (panel)')
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

    it('carries the aggregation diagnostics through on failure, still behind reveal() (issue #42)', () => {
        const diagnostics = { summary: 'The tool wrote 12 bytes.', reveal: () => 'stderr text' }
        const view = buildScorecardView(
            panel({
                status: 'error',
                result: null,
                error: 'The tool exited with status 1.',
                errorDiagnostics: diagnostics
            }),
            []
        )
        expect(view.status.kind).toBe('failed')
        expect(view.status.diagnostics).toBe(diagnostics)
        // The status line never absorbs the content.
        expect(view.status.detail).not.toContain('stderr text')
        expect(view.status.label).not.toContain('stderr text')
    })

    it('exposes no diagnostics outside a failed aggregation', () => {
        const diagnostics = { summary: 'stale', reveal: () => 'stale content' }
        // A stale capture must not survive a status that is not `failed` —
        // mirrors `statusOf`'s detail rule.
        const view = buildScorecardView(
            panel({ status: 'done', errorDiagnostics: diagnostics }),
            []
        )
        expect(view.status.diagnostics).toBeNull()
    })

    it('points a missing aggregation backend at the setting that fixes it', () => {
        const view = buildScorecardView(panel({ status: 'unavailable', result: null }), [])
        expect(view.status.kind).toBe('unavailable')
        expect(view.status.label).toContain('Settings → Panels')
    })

    it('still names the missing members when aggregation never ran', () => {
        const view = buildScorecardView(
            panel({
                status: 'skipped',
                result: null,
                memberNames: ['A', 'B'],
                missingMembers: ['A', 'B']
            }),
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
                memberNames: ['Hater', 'Fact Checker'],
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
                memberNames: ['Hater'],
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

describe('resolveTopFix', () => {
    const findings = [
        candidate('f-1', 'Hater', 'the   weak opening'),
        candidate('f-2', 'Beginner', 'the weak opening'),
        candidate('f-3', 'Hater', 'a second span')
    ]

    it('is null without a quote — a fix that points at nothing reveals nothing', () => {
        expect(resolveTopFix({ editorName: 'Hater' }, findings)).toBeNull()
        expect(resolveTopFix({ quote: '' }, findings)).toBeNull()
    })

    it('prefers an exact match inside the credited member', () => {
        expect(
            resolveTopFix({ editorName: 'Hater', quote: 'the   weak opening' }, findings)?.id
        ).toBe(asFindingId('f-1'))
    })

    it('falls back to an exact match from any member', () => {
        expect(
            resolveTopFix({ editorName: 'Fact Checker', quote: 'a second span' }, findings)?.id
        ).toBe(asFindingId('f-3'))
    })

    it('never lets a normalized match displace an exact one from another member', () => {
        // 'the weak opening' matches f-2 exactly and f-1 only after
        // normalization, even though f-1 belongs to the credited member.
        expect(
            resolveTopFix({ editorName: 'Hater', quote: 'the weak opening' }, findings)?.id
        ).toBe(asFindingId('f-2'))
    })

    it('normalizes whitespace and case only when nothing matched exactly', () => {
        expect(resolveTopFix({ quote: 'A SECOND\n  span' }, findings)?.id).toBe(asFindingId('f-3'))
    })

    it('returns null rather than guessing at an unknown quote', () => {
        expect(
            resolveTopFix({ editorName: 'Hater', quote: 'never said this' }, findings)
        ).toBeNull()
    })
})

describe('buildScorecardView roster reconciliation', () => {
    it('drops a member the panel invented and keeps the one it hid', () => {
        // `memberVerdicts` is model-authored text: a misspelled name must not
        // produce a row for an editor that never ran, nor swallow the real one.
        const view = buildScorecardView(
            panel({
                memberNames: ['Beginner', 'Hater'],
                result: result({
                    memberVerdicts: [
                        { editorName: 'Beginner Reader', verdict: 'kill' },
                        { editorName: 'Hater', verdict: 'needs-work' }
                    ]
                })
            }),
            []
        )
        expect(view.members.map((entry) => entry.editorName)).toEqual(['Hater', 'Beginner'])
        expect(view.members[1]?.unnamed).toBeTrue()
        expect(view.members[1]?.missing).toBeFalse()
    })

    it('marks a member the scorecard never mentions as unnamed, not missing', () => {
        const view = buildScorecardView(
            panel({
                memberNames: ['Hater', 'Beginner'],
                result: result({ memberVerdicts: [{ editorName: 'Hater', verdict: 'publish' }] })
            }),
            []
        )
        expect(view.members[0]?.unnamed).toBeFalse()
        expect(view.members[1]).toMatchObject({
            editorName: 'Beginner',
            unnamed: true,
            missing: false,
            verdict: null
        })
    })
})

describe('buildScorecardView top-fix credit', () => {
    it('credits the member whose finding the row actually reveals', () => {
        // The pointer resolved OUTSIDE the credited member (cross-member
        // fallback), so the row must name the owner of what the click shows.
        const view = buildScorecardView(
            panel({
                result: result({
                    topFixes: [
                        { action: 'Rewrite it', editorName: 'Hater', quote: 'a jargon-heavy line' }
                    ]
                })
            }),
            [candidate('f-2', 'Beginner', 'a jargon-heavy line')]
        )
        expect(view.topFixes[0]?.findingId).toBe(asFindingId('f-2'))
        expect(view.topFixes[0]?.editorName).toBe('Beginner')
    })

    it('keeps the panel’s credit when the fix resolves to nothing', () => {
        const view = buildScorecardView(
            panel({
                result: result({
                    topFixes: [{ action: 'Cut the second half', editorName: 'Hater' }]
                })
            }),
            []
        )
        expect(view.topFixes[0]?.findingId).toBeNull()
        expect(view.topFixes[0]?.editorName).toBe('Hater')
    })
})

describe('buildScorecardView staleness', () => {
    it('flags a scorecard kept across a continuation', () => {
        const view = buildScorecardView(panel({ status: 'waiting', resultStale: true }), [])
        expect(view.stale).toBeTrue()
        // The verdict and fixes are still shown: they describe findings that
        // are all still on the note.
        expect(view.verdict).not.toBeNull()
    })

    it('is never stale without a scorecard to be stale about', () => {
        const view = buildScorecardView(
            panel({ status: 'waiting', result: null, resultStale: true }),
            []
        )
        expect(view.stale).toBeFalse()
    })
})

describe('scorecardMemberName', () => {
    const base = {
        editorName: 'Hater',
        verdict: null,
        verdictLabel: null,
        keyPoint: null,
        missing: false,
        unnamed: false
    }

    it('leads with the member — the row exists to say what THIS member concluded', () => {
        expect(
            scorecardMemberName({ ...base, verdictLabel: 'Needs work', keyPoint: 'Thin evidence' })
        ).toBe('Hater — Needs work — Thin evidence')
    })

    it('spells out a member the panel could not weigh', () => {
        expect(scorecardMemberName({ ...base, missing: true })).toBe(
            'Hater — no review — not weighed by the panel'
        )
    })

    it('distinguishes "ran but unmentioned" from "did not run"', () => {
        expect(scorecardMemberName({ ...base, unnamed: true })).toBe(
            'Hater — reviewed, but not named in the scorecard'
        )
    })

    it('is just the name when the panel said nothing about the member', () => {
        expect(scorecardMemberName(base)).toBe('Hater')
    })
})

/**
 * Disabled-editor lens over the scorecard (Business Rules #21, adversarial
 * review 2026-08-06): the section list below already hides a disabled
 * member's persona, but the scorecard block kept its member row, dissent
 * positions and top-fix credit visible. The lens filters the VIEW only — the
 * stored result is untouched, so re-enabling restores every row.
 */
describe('buildScorecardView disabled-member lens', () => {
    it('omits a disabled member row and keeps the rest', () => {
        const view = buildScorecardView(
            panel({
                result: result({
                    memberVerdicts: [
                        { editorName: 'Hater', verdict: 'needs-work', keyPoint: 'Too soft' },
                        { editorName: 'Beginner', verdict: 'publish' }
                    ]
                })
            }),
            [],
            new Set(['Hater'])
        )
        expect(view.members.map((member) => member.editorName)).toEqual(['Beginner'])
        // The panel-level synthesis is the panel's voice, not the member's.
        expect(view.verdict).not.toBeNull()
    })

    it('drops a disabled member from missingMembers too', () => {
        const view = buildScorecardView(
            panel({ status: 'skipped', result: null, missingMembers: ['Hater'] }),
            [],
            new Set(['Hater'])
        )
        expect(view.missingMembers).toEqual([])
        expect(view.members.map((member) => member.editorName)).toEqual(['Beginner'])
    })

    it('filters a disabled member out of dissent positions, dropping emptied entries', () => {
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
                        },
                        {
                            subject: 'Only the disabled member spoke',
                            positions: [{ editorName: 'Hater', stance: 'Cut it all' }]
                        }
                    ]
                })
            }),
            [],
            new Set(['Hater'])
        )
        expect(view.dissent).toHaveLength(1)
        expect(view.dissent[0]?.positions.map((p) => p.editorName)).toEqual(['Beginner'])
    })

    it('suppresses a disabled member credit on an unresolved top fix, keeping the action row', () => {
        const view = buildScorecardView(
            panel({
                result: result({
                    topFixes: [
                        { action: 'Rewrite it', editorName: 'Hater', quote: 'the weak opening' }
                    ]
                })
            }),
            // No candidates: a disabled member's findings never reach the
            // candidate list (`topFixCandidates` filters them), so the fix
            // cannot resolve and the model's credit is all that is left.
            [],
            new Set(['Hater'])
        )
        expect(view.topFixes).toHaveLength(1)
        expect(view.topFixes[0]?.action).toBe('Rewrite it')
        expect(view.topFixes[0]?.editorName).toBeNull()
        expect(view.topFixes[0]?.findingId).toBeNull()
    })

    it('defaults to no filtering — solo and all-enabled panels are untouched', () => {
        const view = buildScorecardView(
            panel({
                result: result({
                    memberVerdicts: [{ editorName: 'Hater', verdict: 'needs-work' }]
                })
            }),
            []
        )
        expect(view.members.map((member) => member.editorName).sort()).toEqual([
            'Beginner',
            'Hater'
        ])
    })
})
