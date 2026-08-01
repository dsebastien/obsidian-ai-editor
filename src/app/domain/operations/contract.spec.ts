import { describe, expect, it } from 'bun:test'
import {
    CONTRACT_VERSION,
    operationRequestSchema,
    operationResultSchema,
    panelResultSchema,
    rawFindingSchema
} from './contract'

const base = {
    contractVersion: CONTRACT_VERSION,
    runId: 'run-1',
    snapshotHash: 'abc123'
}

describe('rawFindingSchema', () => {
    it('accepts a minimal finding and applies defaults', () => {
        const finding = rawFindingSchema.parse({
            quote: 'Every docker pull',
            critique: 'Redundant with the previous sentence.'
        })
        expect(finding.severity).toEqual('suggestion')
        expect(finding.evidence).toEqual([])
        expect(finding.edits).toEqual([])
        expect(finding.invalidProposal).toBeFalse()
    })

    it('accepts a full finding', () => {
        const finding = rawFindingSchema.parse({
            quote: 'AWS us-east-1 degraded',
            prefix: 'October 20, 2025, ',
            suffix: ', and Docker Hub runs there',
            occurrence: 0,
            critique: 'Uncited factual claim.',
            edits: [{ op: 'replace', text: 'AWS us-east-1 was degraded (see incident report)' }],
            rationale: 'Adds the citation.',
            severity: 'warning',
            confidence: 0.9,
            evidence: [
                {
                    title: 'AWS status history',
                    url: 'https://health.aws.amazon.com/',
                    verification: 'requires-verification'
                }
            ]
        })
        expect(finding.evidence.length).toEqual(1)
        expect(finding.edits).toHaveLength(1)
    })

    it('rejects an empty quote', () => {
        expect(() => rawFindingSchema.parse({ quote: '', critique: 'x' })).toThrow()
    })

    it('rejects an oversized quote', () => {
        expect(() => rawFindingSchema.parse({ quote: 'a'.repeat(2_001), critique: 'x' })).toThrow()
    })

    it('rejects out-of-range confidence', () => {
        expect(() =>
            rawFindingSchema.parse({ quote: 'q', critique: 'c', confidence: 1.5 })
        ).toThrow()
    })
})

describe('operationRequestSchema', () => {
    it('parses a review request', () => {
        const parsed = operationRequestSchema.parse({
            ...base,
            kind: 'review',
            text: '# Note\n\nBody.'
        })
        expect(parsed.kind).toEqual('review')
    })

    it('parses a transform-selection request', () => {
        const parsed = operationRequestSchema.parse({
            ...base,
            kind: 'transform-selection',
            text: 'abcdef',
            selection: { from: 1, to: 4 },
            instruction: 'Rephrase this.'
        })
        expect(parsed.kind).toEqual('transform-selection')
    })

    it('parses an aggregate-panel request', () => {
        const parsed = operationRequestSchema.parse({
            ...base,
            kind: 'aggregate-panel',
            members: [
                {
                    editorName: 'Devil’s Advocate',
                    findings: [],
                    verdict: 'needs-work'
                }
            ]
        })
        expect(parsed.kind).toEqual('aggregate-panel')
        if (parsed.kind === 'aggregate-panel') {
            expect(parsed.members[0]?.failed).toBeFalse()
        }
    })

    it('rejects an unknown kind', () => {
        expect(() => operationRequestSchema.parse({ ...base, kind: 'summon-cthulhu' })).toThrow()
    })

    it('rejects a wrong contract version', () => {
        expect(() =>
            operationRequestSchema.parse({
                ...base,
                contractVersion: CONTRACT_VERSION + 1,
                kind: 'review',
                text: 'x'
            })
        ).toThrow()
    })

    it('rejects a thread turn without a message', () => {
        expect(() =>
            operationRequestSchema.parse({
                ...base,
                kind: 'thread-turn',
                findingId: 'f1',
                quote: 'q',
                critique: 'c',
                history: [],
                message: ''
            })
        ).toThrow()
    })
})

describe('operationResultSchema', () => {
    it('parses a review result with findings', () => {
        const parsed = operationResultSchema.parse({
            kind: 'review',
            findings: [{ quote: 'q', critique: 'c' }],
            summary: 'Overall solid.'
        })
        expect(parsed.kind).toEqual('review')
        if (parsed.kind === 'review') {
            expect(parsed.findings.length).toEqual(1)
        }
    })

    it('parses a panel result', () => {
        const parsed = operationResultSchema.parse({
            kind: 'aggregate-panel',
            recommendation: 'needs-work',
            memberVerdicts: [
                { editorName: 'Editor', verdict: 'publish' },
                { editorName: 'Hater', verdict: 'kill', keyPoint: 'Weak thesis.' }
            ],
            topFixes: [
                { action: 'Tighten the intro.', editorName: 'Editor', quote: 'In this article' },
                { action: 'Cite the outage claim.' }
            ],
            dissent: [
                {
                    subject: 'Whether to publish at all',
                    positions: [
                        { editorName: 'Hater', stance: 'The thesis does not hold.' },
                        { editorName: 'Editor', stance: 'It reads fine.' }
                    ]
                }
            ]
        })
        expect(parsed.kind).toEqual('aggregate-panel')
        if (parsed.kind === 'aggregate-panel') {
            expect(parsed.missingMembers).toEqual([])
            expect(parsed.topFixes.length).toEqual(2)
            // The pointer back to a member finding is optional: a structural
            // fix that anchors to no span must stay expressible.
            expect(parsed.topFixes[1]?.quote).toBeUndefined()
            expect(parsed.dissent[0]?.positions.length).toEqual(2)
        }
    })

    it('defaults a panel result with no dissent to an empty list', () => {
        const parsed = panelResultSchema.parse({
            kind: 'aggregate-panel',
            recommendation: 'publish',
            memberVerdicts: [],
            topFixes: []
        })
        expect(parsed.dissent).toEqual([])
    })

    it('rejects a top fix with no action', () => {
        expect(() =>
            panelResultSchema.parse({
                kind: 'aggregate-panel',
                recommendation: 'publish',
                memberVerdicts: [],
                topFixes: [{ editorName: 'Hater', quote: 'something' }]
            })
        ).toThrow()
    })

    it('rejects a dissent entry with no positions', () => {
        expect(() =>
            panelResultSchema.parse({
                kind: 'aggregate-panel',
                recommendation: 'publish',
                memberVerdicts: [],
                topFixes: [],
                dissent: [{ subject: 'The opening', positions: [] }]
            })
        ).toThrow()
    })

    it('rejects a panel result without a recommendation', () => {
        expect(() =>
            operationResultSchema.parse({
                kind: 'aggregate-panel',
                memberVerdicts: [],
                topFixes: []
            })
        ).toThrow()
    })

    it('rejects an insert-at result without insertion', () => {
        expect(() => operationResultSchema.parse({ kind: 'insert-at' })).toThrow()
    })
})
