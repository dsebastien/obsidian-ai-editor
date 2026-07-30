import { describe, expect, it } from 'bun:test'
import { rawFindingSchema, type RawFinding } from '../operations/contract'
import {
    AGGREGATION_CRITIQUE_MAX,
    AGGREGATION_FINDINGS_PER_MEMBER,
    AGGREGATION_MAX_MEMBERS,
    AGGREGATION_MIN_FINDINGS_BUDGET,
    AGGREGATION_SUGGESTION_MAX,
    AGGREGATION_SUMMARY_MAX,
    panelFindingsBudget,
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
            // The cap is a truncation like any other: the chairperson is told
            // the list is a prefix, or it will conclude the member found
            // nothing else (`omittedFindings` on the operation contract).
            expect(clamped.members[0]?.omittedFindings).toBe(5)
        }
    })

    it('skips a panel with no member stream at all', () => {
        expect(planPanelAggregation([]).kind).toBe('skip')
    })
})

describe('planPanelAggregation compaction', () => {
    const bulky = rawFindingSchema.parse({
        quote: 'the quoted span',
        prefix: 'before ',
        suffix: ' after',
        occurrence: 2,
        critique: 'c'.repeat(AGGREGATION_CRITIQUE_MAX + 50),
        suggestion: 's'.repeat(AGGREGATION_SUGGESTION_MAX + 50),
        rationale: 'because',
        confidence: 0.9,
        severity: 'warning',
        evidence: [{ title: 'A source', verification: 'verified' }]
    })

    it('drops what the chairperson never uses and truncates what it reads', () => {
        const plan = planPanelAggregation([member({ findings: [bulky] })])
        expect(plan.kind).toBe('aggregate')
        if (plan.kind !== 'aggregate') {
            return
        }
        const sent = plan.members[0]?.findings[0]
        expect(sent?.prefix).toBeUndefined()
        expect(sent?.suffix).toBeUndefined()
        expect(sent?.occurrence).toBeUndefined()
        expect(sent?.rationale).toBeUndefined()
        expect(sent?.confidence).toBeUndefined()
        expect(sent?.evidence).toEqual([])
        // Weighting survives.
        expect(sent?.severity).toBe('warning')
        expect(sent?.critique.length).toBe(AGGREGATION_CRITIQUE_MAX + 1) // + the ellipsis
        expect(sent?.suggestion?.length).toBe(AGGREGATION_SUGGESTION_MAX + 1)
    })

    it('never truncates a quote — the top-fix pointer resolves by it', () => {
        const long = rawFindingSchema.parse({
            quote: 'q'.repeat(1_500),
            critique: 'Too long a sentence.'
        })
        const plan = planPanelAggregation([member({ findings: [long] })])
        if (plan.kind !== 'aggregate') {
            throw new Error('expected an aggregation')
        }
        expect(plan.members[0]?.findings[0]?.quote).toBe(long.quote)
    })

    it('truncates a member summary rather than dropping it', () => {
        const plan = planPanelAggregation([
            member({ findings: [], summary: 'x'.repeat(AGGREGATION_SUMMARY_MAX + 100) })
        ])
        if (plan.kind !== 'aggregate') {
            throw new Error('expected an aggregation')
        }
        expect(plan.members[0]?.summary?.length).toBe(AGGREGATION_SUMMARY_MAX + 1)
    })

    it('reports nothing omitted when everything fits', () => {
        const plan = planPanelAggregation([member({ findings: [raw('a'), raw('b')] })], {
            contextBudgetChars: 200_000,
            charterChars: 0
        })
        if (plan.kind !== 'aggregate') {
            throw new Error('expected an aggregation')
        }
        expect(plan.members[0]?.findings).toHaveLength(2)
        expect(plan.members[0]?.omittedFindings).toBe(0)
    })
})

describe('planPanelAggregation budget', () => {
    /** A finding costing exactly `chars` (quote + a 10-char critique). */
    function costing(chars: number, tag: string): RawFinding {
        const quote = `${tag}${'q'.repeat(chars - tag.length - 10)}`
        return rawFindingSchema.parse({ quote, critique: 'c'.repeat(10) })
    }

    /** 4 500 characters of findings budget (3 characters of names paid first). */
    const tight = { contextBudgetChars: 9_000, charterChars: 0 }

    it('fits findings round-robin so one verbose member cannot starve the others', () => {
        const plan = planPanelAggregation(
            [
                member({
                    editorName: 'A',
                    findings: [1, 2, 3].map((n) => costing(2_000, `a${n}`))
                }),
                member({ editorName: 'B', findings: [1, 2, 3].map((n) => costing(200, `b${n}`)) }),
                member({ editorName: 'C', findings: [1, 2, 3].map((n) => costing(200, `c${n}`)) })
            ],
            tight
        )
        if (plan.kind !== 'aggregate') {
            throw new Error('expected an aggregation')
        }
        // Filling member by member would spend 4 000 on A and 400 on B and
        // leave C — the last member of the panel — entirely unheard while the
        // scorecard claims to weigh it. Round-robin gives C a turn first.
        expect(plan.members.map((entry) => entry.findings.length)).toEqual([2, 1, 1])
        expect(plan.members.map((entry) => entry.omittedFindings)).toEqual([1, 2, 2])
    })

    it('keeps each member a prefix — one oversized finding ends that member', () => {
        const plan = planPanelAggregation(
            [
                member({
                    editorName: 'A',
                    // The third would fit in what is left; it is omitted anyway.
                    findings: [costing(2_010, 'a1'), costing(2_010, 'a2'), costing(200, 'a3')]
                }),
                member({ editorName: 'B', findings: [costing(2_010, 'b1'), costing(2_010, 'b2')] })
            ],
            tight
        )
        if (plan.kind !== 'aggregate') {
            throw new Error('expected an aggregation')
        }
        expect(plan.members[0]?.findings.map((finding) => finding.quote.slice(0, 2))).toEqual([
            'a1'
        ])
        expect(plan.members[0]?.omittedFindings).toBe(2)
        expect(plan.members[1]?.omittedFindings).toBe(1)
    })

    it('is deterministic — the same input yields the same payload', () => {
        const members = [
            member({ editorName: 'A', findings: [costing(1_500, 'a1'), costing(1_500, 'a2')] }),
            member({ editorName: 'B', findings: [costing(1_500, 'b1'), costing(1_500, 'b2')] })
        ]
        expect(JSON.stringify(planPanelAggregation(members, tight))).toBe(
            JSON.stringify(planPanelAggregation(members, tight))
        )
    })

    it('leaves the contract caps as the only limit when no budget is given', () => {
        const findings = Array.from({ length: 10 }, (_unused, index) => costing(2_000, `a${index}`))
        const unbudgeted = planPanelAggregation([member({ editorName: 'A', findings })])
        const budgeted = planPanelAggregation([member({ editorName: 'A', findings })], tight)

        if (unbudgeted.kind !== 'aggregate' || budgeted.kind !== 'aggregate') {
            throw new Error('expected an aggregation')
        }
        expect(unbudgeted.members[0]?.findings).toHaveLength(10)
        expect(unbudgeted.members[0]?.omittedFindings).toBe(0)
        expect(budgeted.members[0]?.findings).toHaveLength(2)
        expect(budgeted.members[0]?.omittedFindings).toBe(8)
    })

    it('charges the charter against the same allowance', () => {
        const findings = Array.from({ length: 5 }, (_unused, index) => costing(2_000, `a${index}`))
        const roomy = planPanelAggregation([member({ editorName: 'A', findings })], {
            contextBudgetChars: 20_000,
            charterChars: 0
        })
        const charterHeavy = planPanelAggregation([member({ editorName: 'A', findings })], {
            contextBudgetChars: 20_000,
            charterChars: 5_000
        })
        if (roomy.kind !== 'aggregate' || charterHeavy.kind !== 'aggregate') {
            throw new Error('expected an aggregation')
        }
        expect(roomy.members[0]?.findings).toHaveLength(4)
        expect(charterHeavy.members[0]?.findings).toHaveLength(2)
    })
})

describe('panelFindingsBudget', () => {
    it('spends a share of the context budget, minus the charter and envelopes', () => {
        expect(
            panelFindingsBudget({ contextBudgetChars: 200_000, charterChars: 5_000 }, 1_000)
        ).toBe(100_000 - 5_000 - 1_000)
    })

    it('never goes below the floor, however small the context budget', () => {
        expect(panelFindingsBudget({ contextBudgetChars: 1_000, charterChars: 900 }, 500)).toBe(
            AGGREGATION_MIN_FINDINGS_BUDGET
        )
    })

    it('never goes below the floor when the charter alone exceeds the allowance', () => {
        expect(panelFindingsBudget({ contextBudgetChars: 20_000, charterChars: 50_000 }, 0)).toBe(
            AGGREGATION_MIN_FINDINGS_BUDGET
        )
    })
})
