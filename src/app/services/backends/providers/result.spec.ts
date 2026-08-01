import { describe, expect, it } from 'bun:test'
import { extractJsonPayload, validateOperationResult } from './result'
import { validPanelResult, validReviewResult } from './spec-fixtures'
import { ProviderError } from './types'

describe('extractJsonPayload', () => {
    it('parses a plain JSON object', () => {
        expect(extractJsonPayload('{"a": 1}')).toEqual({ a: 1 })
    })

    it('parses JSON wrapped in a bare code fence', () => {
        expect(extractJsonPayload('```\n{"a": 1}\n```')).toEqual({ a: 1 })
    })

    it('parses JSON wrapped in a json-tagged fence with surrounding whitespace', () => {
        expect(extractJsonPayload('  ```json\n{"a": 1}\n```  ')).toEqual({ a: 1 })
    })

    it('throws invalid-output on non-JSON text', () => {
        try {
            extractJsonPayload('Here is my review: the text is fine.')
            expect.unreachable()
        } catch (error) {
            expect(error).toBeInstanceOf(ProviderError)
            expect((error as ProviderError).code).toBe('invalid-output')
        }
    })

    it('throws invalid-output on truncated JSON', () => {
        expect(() => extractJsonPayload('{"kind": "review", "findings": [')).toThrow(ProviderError)
    })
})

describe('validateOperationResult', () => {
    it('accepts contract-conforming results and applies defaults', () => {
        const { result, salvage } = validateOperationResult(validReviewResult())
        expect(result.kind).toBe('review')
        if (result.kind === 'review') {
            expect(result.findings[0]?.evidence).toEqual([])
            expect(result.findings[0]?.invalidProposal).toBe(false)
        }
        expect(salvage).toBeNull()
        expect(validateOperationResult(validPanelResult()).result.kind).toBe('aggregate-panel')
    })

    it('reports non-review contract violations with issue paths, not payload content', () => {
        // A non-review kind keeps v1's strict all-or-nothing semantics.
        try {
            validateOperationResult({ kind: 'thread-turn', reply: 42 })
            expect.unreachable()
        } catch (error) {
            expect(error).toBeInstanceOf(ProviderError)
            expect((error as ProviderError).code).toBe('invalid-output')
            expect((error as Error).message).toContain('reply')
        }
    })

    it('rejects payloads without a known kind', () => {
        expect(() => validateOperationResult({ findings: [] })).toThrow(ProviderError)
        expect(() => validateOperationResult({ kind: 'poetry' })).toThrow(ProviderError)
        expect(() => validateOperationResult(null)).toThrow(ProviderError)
        expect(() => validateOperationResult('review')).toThrow(ProviderError)
    })

    it('rejects a result whose kind is valid but whose body belongs to another kind', () => {
        const crossKind = { ...validPanelResult(), kind: 'thread-turn' }
        expect(() => validateOperationResult(crossKind)).toThrow(ProviderError)
    })
})

/**
 * Per-finding salvage (contract v2 design §5): the ENVELOPE stays strict,
 * each finding degrades individually — fail closed, never silently.
 */
describe('validateOperationResult — review salvage', () => {
    const good = { quote: 'Hello world', critique: 'Generic opener' }

    it('drops a finding whose observation core is invalid, and counts it', () => {
        const { result, salvage } = validateOperationResult({
            kind: 'review',
            findings: [good, { critique: 'no quote at all' }, 'not even an object']
        })
        if (result.kind !== 'review') throw new Error('wrong kind')
        expect(result.findings).toHaveLength(1)
        expect(salvage).toEqual({ discardedFindings: 2, invalidProposals: 0 })
    })

    it('strips invalid edits but keeps the finding display-only with the marker', () => {
        const { result, salvage } = validateOperationResult({
            kind: 'review',
            findings: [
                { ...good, edits: [{ op: 'replace' }] }, // replace without text
                { ...good, edits: [{ op: 'polish', text: 'x' }] } // unknown op
            ]
        })
        if (result.kind !== 'review') throw new Error('wrong kind')
        expect(result.findings).toHaveLength(2)
        for (const finding of result.findings) {
            expect(finding.edits).toEqual([])
            expect(finding.invalidProposal).toBe(true)
        }
        expect(salvage).toEqual({ discardedFindings: 0, invalidProposals: 2 })
    })

    it('an empty-text replace is invalid — a covert delete is not an edit', () => {
        const { result, salvage } = validateOperationResult({
            kind: 'review',
            findings: [{ ...good, edits: [{ op: 'replace', text: '' }] }]
        })
        if (result.kind !== 'review') throw new Error('wrong kind')
        expect(result.findings[0]?.invalidProposal).toBe(true)
        expect(salvage?.invalidProposals).toBe(1)
    })

    it('a findings field that is not an array is an envelope failure, never salvaged to empty', () => {
        expect(() =>
            validateOperationResult({ kind: 'review', findings: 'sk-live-SECRET' })
        ).toThrow(ProviderError)
        try {
            validateOperationResult({ kind: 'review', findings: 'sk-live-SECRET' })
        } catch (error) {
            expect((error as Error).message).not.toContain('SECRET')
        }
    })

    it('a delete without text is a VALID edit', () => {
        const { result, salvage } = validateOperationResult({
            kind: 'review',
            findings: [{ ...good, edits: [{ op: 'delete' }] }]
        })
        if (result.kind !== 'review') throw new Error('wrong kind')
        expect(result.findings[0]?.edits).toEqual([{ op: 'delete' }])
        expect(salvage).toBeNull()
    })

    it('a model that sets invalidProposal itself is read fail-closed: edits stripped', () => {
        const { result, salvage } = validateOperationResult({
            kind: 'review',
            findings: [{ ...good, invalidProposal: true, edits: [{ op: 'replace', text: 'fine' }] }]
        })
        if (result.kind !== 'review') throw new Error('wrong kind')
        expect(result.findings[0]?.edits).toEqual([])
        expect(result.findings[0]?.invalidProposal).toBe(true)
        expect(salvage?.invalidProposals).toBe(1)
    })

    it('more than 10 edits invalidates the proposal, not the finding', () => {
        const { result, salvage } = validateOperationResult({
            kind: 'review',
            findings: [
                {
                    ...good,
                    edits: Array.from({ length: 11 }, () => ({ op: 'delete' }))
                }
            ]
        })
        if (result.kind !== 'review') throw new Error('wrong kind')
        expect(result.findings[0]?.edits).toEqual([])
        expect(result.findings[0]?.invalidProposal).toBe(true)
        expect(salvage?.invalidProposals).toBe(1)
    })

    it('clamps over-long edit hints like finding hints (tail/head)', () => {
        const { result } = validateOperationResult({
            kind: 'review',
            findings: [
                {
                    ...good,
                    edits: [
                        {
                            op: 'replace',
                            quote: 'Hello',
                            prefix: 'x'.repeat(300) + 'near',
                            suffix: 'after' + 'y'.repeat(300),
                            text: 'Hi'
                        }
                    ]
                }
            ]
        })
        if (result.kind !== 'review') throw new Error('wrong kind')
        const edit = result.findings[0]?.edits[0]
        expect(edit?.prefix?.length).toBe(200)
        expect(edit?.prefix?.endsWith('near')).toBeTrue()
        expect(edit?.suffix?.length).toBe(200)
        expect(edit?.suffix?.startsWith('after')).toBeTrue()
    })
})

describe('validateOperationResult — advisory field clamping', () => {
    it('clamps an over-long prefix to its tail and suffix to its head', () => {
        const longPrefix = 'x'.repeat(300) + 'near the quote'
        const longSuffix = 'right after' + 'y'.repeat(250)
        const { result } = validateOperationResult({
            kind: 'review',
            findings: [
                {
                    quote: 'the quoted span',
                    critique: 'too verbose',
                    prefix: longPrefix,
                    suffix: longSuffix
                }
            ]
        })
        if (result.kind !== 'review') throw new Error('wrong kind')
        const finding = result.findings[0]!
        expect(finding.prefix!.length).toEqual(200)
        expect(finding.prefix!.endsWith('near the quote')).toBeTrue()
        expect(finding.suffix!.length).toEqual(200)
        expect(finding.suffix!.startsWith('right after')).toBeTrue()
    })

    it('still discards structurally wrong findings (salvage, counted)', () => {
        const { result, salvage } = validateOperationResult({
            kind: 'review',
            findings: [{ prefix: 'x'.repeat(999) }]
        })
        if (result.kind !== 'review') throw new Error('wrong kind')
        expect(result.findings).toHaveLength(0)
        expect(salvage).toEqual({ discardedFindings: 1, invalidProposals: 0 })
    })
})

/**
 * The "runaway model" guard, verified rather than assumed (plan M9,
 * performance pass). Every bound below is the operation contract's; these
 * tests exist so a later widening of a `.max()` cannot silently remove the
 * property that a single backend response can never become an unbounded
 * amount of work for the editor.
 */
describe('validateOperationResult — a runaway response is bounded by the contract', () => {
    function finding(index: number): Record<string, unknown> {
        return {
            quote: `quoted span number ${index}`,
            critique: `critique number ${index}`,
            severity: 'suggestion'
        }
    }

    it('refuses 10 000 findings rather than ingesting them', () => {
        // This is why a note cannot accumulate ten thousand highlights from
        // one run: the result never gets past validation.
        const payload = {
            kind: 'review',
            findings: Array.from({ length: 10_000 }, (_, index) => finding(index))
        }
        try {
            validateOperationResult(payload)
            expect.unreachable()
        } catch (error) {
            expect(error).toBeInstanceOf(ProviderError)
            expect((error as ProviderError).code).toBe('invalid-output')
        }
    })

    it('accepts exactly 200 findings and refuses 201', () => {
        const at = {
            kind: 'review',
            findings: Array.from({ length: 200 }, (_, index) => finding(index))
        }
        const over = {
            kind: 'review',
            findings: Array.from({ length: 201 }, (_, index) => finding(index))
        }
        expect(validateOperationResult(at).result.kind).toBe('review')
        expect(() => validateOperationResult(over)).toThrow(ProviderError)
    })

    it('drops a finding with an oversized quote or critique (salvage), and strips an oversized edit text', () => {
        const oversized = (field: string, length: number): Record<string, unknown> => ({
            kind: 'review',
            findings: [{ ...finding(0), [field]: 'x'.repeat(length) }]
        })
        // Core bounds: the finding is dropped, the run survives, the loss is counted.
        for (const payload of [oversized('quote', 2_001), oversized('critique', 10_001)]) {
            const { result, salvage } = validateOperationResult(payload)
            if (result.kind !== 'review') throw new Error('wrong kind')
            expect(result.findings).toHaveLength(0)
            expect(salvage?.discardedFindings).toBe(1)
        }
        // Proposal bounds: the finding survives display-only.
        const { result, salvage } = validateOperationResult({
            kind: 'review',
            findings: [{ ...finding(0), edits: [{ op: 'replace', text: 'x'.repeat(10_001) }] }]
        })
        if (result.kind !== 'review') throw new Error('wrong kind')
        expect(result.findings[0]?.invalidProposal).toBe(true)
        expect(salvage?.invalidProposals).toBe(1)
    })

    it('parses and refuses a ~1 MB payload without hanging', () => {
        const body = JSON.stringify({
            kind: 'review',
            findings: Array.from({ length: 5_000 }, (_, index) => ({
                ...finding(index),
                critique: `critique number ${index} ${'padding '.repeat(20)}`
            }))
        })
        expect(body.length).toBeGreaterThan(1_000_000)
        const started = performance.now()
        const parsed = extractJsonPayload(body)
        expect(() => validateOperationResult(parsed)).toThrow(ProviderError)
        expect(performance.now() - started).toBeLessThan(2_000)
    })

    it('bounds a transform replacement and a thread reply too', () => {
        expect(() =>
            validateOperationResult({
                kind: 'transform-selection',
                replacement: 'x'.repeat(100_001)
            })
        ).toThrow(ProviderError)
        expect(() =>
            validateOperationResult({ kind: 'thread-turn', reply: 'x'.repeat(10_001) })
        ).toThrow(ProviderError)
    })
})
