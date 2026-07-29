import { describe, expect, it } from 'bun:test'
import { extractJsonPayload, validateOperationResult } from './result'
import { validPanelResult, validReviewResult, wrongSchemaResult } from './spec-fixtures'
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
        const result = validateOperationResult(validReviewResult())
        expect(result.kind).toBe('review')
        if (result.kind === 'review') {
            expect(result.findings[0]?.evidence).toEqual([])
        }
        expect(validateOperationResult(validPanelResult()).kind).toBe('aggregate-panel')
    })

    it('rejects wrong-schema payloads with issue paths, not payload content', () => {
        try {
            validateOperationResult(wrongSchemaResult())
            expect.unreachable()
        } catch (error) {
            expect(error).toBeInstanceOf(ProviderError)
            expect((error as ProviderError).code).toBe('invalid-output')
            const message = (error as Error).message
            expect(message).toContain('findings.0.quote')
            expect(message).not.toContain('finding without the required quote')
        }
    })

    it('rejects payloads without a known kind', () => {
        expect(() => validateOperationResult({ findings: [] })).toThrow(ProviderError)
        expect(() => validateOperationResult({ kind: 'poetry' })).toThrow(ProviderError)
        expect(() => validateOperationResult(null)).toThrow(ProviderError)
        expect(() => validateOperationResult('review')).toThrow(ProviderError)
    })

    it('rejects a result whose kind is valid but whose body belongs to another kind', () => {
        const crossKind = { ...validPanelResult(), kind: 'review' }
        expect(() => validateOperationResult(crossKind)).toThrow(ProviderError)
    })
})
