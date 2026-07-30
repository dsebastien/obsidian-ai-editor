import { describe, expect, it } from 'bun:test'
import { rawFindingSchema, type RawFinding } from '../operations/contract'
import {
    AGGREGATION_FINDINGS_PER_MEMBER,
    AGGREGATION_MAX_MEMBERS,
    planPanelAggregation,
    type PanelMemberReview
} from './panel-aggregation'

function raw(quote: string): RawFinding {
    return rawFindingSchema.parse({ quote, critique: `About ${quote}` })
}

function member(overrides: Partial<PanelMemberReview> = {}): PanelMemberReview {
    return {
        editorName: 'Devil’s Advocate',
        status: 'done',
        findings: [raw('claim')],
        ...overrides
    }
}

describe('planPanelAggregation', () => {
    it('aggregates when every member succeeded, with nothing missing', () => {
        const plan = planPanelAggregation([
            member({ editorName: 'A', summary: 'Solid' }),
            member({ editorName: 'B', verdict: 'needs-work' })
        ])

        expect(plan.kind).toBe('aggregate')
        expect(plan.missingMembers).toEqual([])
        if (plan.kind !== 'aggregate') {
            return
        }
        expect(plan.members.map((entry) => entry.editorName)).toEqual(['A', 'B'])
        expect(plan.members.every((entry) => !entry.failed)).toBeTrue()
        expect(plan.members[0]?.summary).toBe('Solid')
        expect(plan.members[1]?.verdict).toBe('needs-work')
    })

    it('completes with the survivors and names the failures — never drops them', () => {
        const plan = planPanelAggregation([
            member({ editorName: 'A' }),
            member({ editorName: 'B', status: 'error', findings: [] }),
            member({ editorName: 'C', status: 'cancelled', findings: [raw('partial')] })
        ])

        expect(plan.kind).toBe('aggregate')
        expect(plan.missingMembers).toEqual(['B', 'C'])
        if (plan.kind !== 'aggregate') {
            return
        }
        // Failures still travel, flagged, so the chairperson knows the panel
        // was incomplete instead of writing a confident partial scorecard.
        expect(plan.members.map((entry) => entry.failed)).toEqual([false, true, true])
        // A cancelled member's partial findings are NOT presented as a review.
        expect(plan.members[2]?.findings).toEqual([])
    })

    it('treats a clean read as success — no findings is a verdict, not a failure', () => {
        const plan = planPanelAggregation([
            member({ editorName: 'A', findings: [], summary: 'Nothing to flag' })
        ])
        expect(plan.kind).toBe('aggregate')
        expect(plan.missingMembers).toEqual([])
    })

    it('skips aggregation when no member succeeded, still naming everyone', () => {
        const plan = planPanelAggregation([
            member({ editorName: 'A', status: 'error' }),
            member({ editorName: 'B', status: 'cancelled' })
        ])

        expect(plan.kind).toBe('skip')
        expect(plan.missingMembers).toEqual(['A', 'B'])
        if (plan.kind === 'skip') {
            expect(plan.reason).toBe('no-member-succeeded')
        }
    })

    it('treats a non-terminal member as missing rather than trusting it', () => {
        const plan = planPanelAggregation([
            member({ editorName: 'A' }),
            member({ editorName: 'B', status: 'running' })
        ])
        expect(plan.missingMembers).toEqual(['B'])
    })

    it('clamps members and findings to the operation contract caps', () => {
        const many = Array.from({ length: AGGREGATION_MAX_MEMBERS + 3 }, (_unused, index) =>
            member({ editorName: `E${index}` })
        )
        const flooded = member({
            editorName: 'Flood',
            findings: Array.from({ length: AGGREGATION_FINDINGS_PER_MEMBER + 5 }, (_unused, i) =>
                raw(`quote-${i}`)
            )
        })

        const capped = planPanelAggregation(many)
        const clamped = planPanelAggregation([flooded])

        expect(capped.kind).toBe('aggregate')
        if (capped.kind === 'aggregate') {
            expect(capped.members).toHaveLength(AGGREGATION_MAX_MEMBERS)
        }
        if (clamped.kind === 'aggregate') {
            expect(clamped.members[0]?.findings).toHaveLength(AGGREGATION_FINDINGS_PER_MEMBER)
        }
    })

    it('skips a panel with no member stream at all', () => {
        expect(planPanelAggregation([]).kind).toBe('skip')
    })
})
