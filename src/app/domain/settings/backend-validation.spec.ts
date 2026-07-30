import { describe, expect, it } from 'bun:test'
import { isJsonObject, validateApiBackend } from './backend-validation'
import { apiBackendSchema } from './settings-schema'
import type { ApiBackend, ApiProviderKind } from './settings-schema'

function makeBackend(overrides: Record<string, unknown> = {}): ApiBackend {
    return apiBackendSchema.parse({
        id: 'backend-1',
        family: 'api',
        kind: 'anthropic',
        label: 'Claude',
        ...overrides
    })
}

describe('isJsonObject', () => {
    it('accepts only plain objects', () => {
        expect(isJsonObject('{"a":1}')).toBe(true)
        expect(isJsonObject('{}')).toBe(true)
        expect(isJsonObject('[1]')).toBe(false)
        expect(isJsonObject('"a"')).toBe(false)
        expect(isJsonObject('null')).toBe(false)
        expect(isJsonObject('nope')).toBe(false)
    })
})

describe('validateApiBackend', () => {
    it('accepts a labelled backend and trims what it normalizes', () => {
        const result = validateApiBackend(
            makeBackend({ label: '  Claude  ', baseUrl: ' https://x/v1 ', extraBodyJson: ' ' })
        )
        expect(result.ok).toBe(true)
        if (result.ok) {
            expect(result.backend.label).toBe('Claude')
            expect(result.backend.baseUrl).toBe('https://x/v1')
            expect(result.backend.extraBodyJson).toBe('')
        }
    })

    it('requires a label', () => {
        const result = validateApiBackend(makeBackend({ label: '   ' }))
        expect(result.ok).toBe(false)
        if (!result.ok) {
            expect(result.code).toBe('label-required')
        }
    })

    it('requires a base URL for openai-compatible endpoints', () => {
        const result = validateApiBackend(makeBackend({ kind: 'openai-compatible', baseUrl: '' }))
        expect(result.ok).toBe(false)
        if (!result.ok) {
            expect(result.code).toBe('base-url-required')
        }
    })

    it('requires an API key for OpenRouter', () => {
        const result = validateApiBackend(makeBackend({ kind: 'openrouter', apiKey: ' ' }))
        expect(result.ok).toBe(false)
        if (!result.ok) {
            expect(result.code).toBe('api-key-required')
        }
    })

    it('requires a deployment for Azure OpenAI', () => {
        const result = validateApiBackend(makeBackend({ kind: 'azure-openai' }))
        expect(result.ok).toBe(false)
        if (!result.ok) {
            expect(result.code).toBe('deployment-required')
        }
    })

    it('rejects an extra request body that is not a JSON object', () => {
        const result = validateApiBackend(
            makeBackend({ kind: 'openrouter', apiKey: 'k', extraBodyJson: '[1]' })
        )
        expect(result.ok).toBe(false)
        if (!result.ok) {
            expect(result.code).toBe('extra-body-not-object')
        }
    })

    it('accepts a missing model — resolution reports that, not validation', () => {
        expect(validateApiBackend(makeBackend({ defaultModel: '' })).ok).toBe(true)
    })

    it('accepts a missing key on providers that may not need one', () => {
        expect(
            validateApiBackend(
                makeBackend({ kind: 'ollama', baseUrl: 'http://localhost:11434', apiKey: '' })
            ).ok
        ).toBe(true)
    })

    it('reports schema violations the per-kind checks cannot express', () => {
        // Constructed around the schema on purpose: this is the shape a
        // hand-edited data.json or a future field can produce.
        const oversized: ApiBackend = { ...makeBackend(), label: 'x'.repeat(101) }
        const result = validateApiBackend(oversized)
        expect(result.ok).toBe(false)
        if (!result.ok) {
            expect(result.code).toBe('schema-invalid')
        }
    })

    it('states every requirement in words (both surfaces show these verbatim)', () => {
        const kinds: readonly ApiProviderKind[] = [
            'openai-compatible',
            'openrouter',
            'azure-openai'
        ]
        for (const kind of kinds) {
            const result = validateApiBackend(makeBackend({ kind, apiKey: '', baseUrl: '' }))
            expect(result.ok).toBe(false)
            if (!result.ok) {
                expect(result.message.length).toBeGreaterThan(0)
                expect(result.message.endsWith('.')).toBe(true)
            }
        }
    })
})
