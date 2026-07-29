import { describe, expect, it } from 'bun:test'
import { azureOpenAiAdapter } from './azure-openai'
import {
    DOCUMENT_TEXT,
    TEST_API_KEY,
    makeConfig,
    reviewOperation,
    validPanelResult,
    validReviewResult,
    wrongSchemaResult
} from './spec-fixtures'
import { ProviderError } from './types'

function azureConfig(overrides: Parameters<typeof makeConfig>[0] = {}) {
    return makeConfig({
        kind: 'azure-openai',
        baseUrl: 'https://my-resource.openai.azure.com',
        azureDeployment: 'gpt-4-1-prod',
        azureApiVersion: '2024-10-21',
        ...overrides
    })
}

function build(overrides: Parameters<typeof makeConfig>[0] = {}) {
    return azureOpenAiAdapter.buildRequest({
        operation: reviewOperation(),
        systemPrompt: 'You are a flow and structure editor.',
        model: 'ignored-for-azure',
        config: azureConfig(overrides)
    })
}

function chatResponse(result: unknown): unknown {
    return { choices: [{ message: { role: 'assistant', content: JSON.stringify(result) } }] }
}

describe('azureOpenAiAdapter.buildRequest', () => {
    it('builds the deployment-based URL with api-version', () => {
        const request = build()
        expect(request.url).toBe(
            'https://my-resource.openai.azure.com/openai/deployments/gpt-4-1-prod/chat/completions?api-version=2024-10-21'
        )
        expect(request.method).toBe('POST')
    })

    it('authenticates with the api-key header, not a bearer token', () => {
        const request = build()
        expect(request.headers['api-key']).toBe(TEST_API_KEY)
        expect(request.headers['authorization']).toBeUndefined()
    })

    it('URL-encodes deployment and api-version', () => {
        const request = build({ azureDeployment: 'my deployment/v2' })
        expect(request.url).toContain('/openai/deployments/my%20deployment%2Fv2/')
    })

    it('trims trailing slashes off the base URL', () => {
        const request = build({ baseUrl: 'https://my-resource.openai.azure.com/' })
        expect(request.url.startsWith('https://my-resource.openai.azure.com/openai/')).toBe(true)
    })

    it('omits a model field (the deployment selects the model)', () => {
        const body = JSON.parse(build().body) as Record<string, unknown>
        expect(body['model']).toBeUndefined()
        expect(body['stream']).toBe(false)
    })

    it('carries system prompt, document payload and json_schema format', () => {
        const body = JSON.parse(build().body) as {
            messages: { role: string; content: string }[]
            response_format: { type: string }
        }
        expect(body.messages[0]?.role).toBe('system')
        expect(body.messages[1]?.content).toContain(DOCUMENT_TEXT)
        expect(body.response_format.type).toBe('json_schema')
    })

    it('never leaks the API key into the body or URL', () => {
        const request = build()
        expect(request.body).not.toContain(TEST_API_KEY)
        expect(request.url).not.toContain(TEST_API_KEY)
    })

    it('lists every missing config field in one invalid-config error, key redacted', () => {
        try {
            build({ baseUrl: '', azureDeployment: '', azureApiVersion: '', apiKey: '' })
            expect.unreachable()
        } catch (error) {
            expect(error).toBeInstanceOf(ProviderError)
            expect((error as ProviderError).code).toBe('invalid-config')
            const message = (error as Error).message
            expect(message).toContain('base URL')
            expect(message).toContain('deployment')
            expect(message).toContain('api version')
            expect(message).toContain('API key')
            expect(message).not.toContain(TEST_API_KEY)
        }
    })
})

describe('azureOpenAiAdapter.parseBufferedResponse', () => {
    it('parses a valid review result', () => {
        const result = azureOpenAiAdapter.parseBufferedResponse(chatResponse(validReviewResult()))
        expect(result.kind).toBe('review')
    })

    it('parses a valid aggregate-panel result', () => {
        const result = azureOpenAiAdapter.parseBufferedResponse(chatResponse(validPanelResult()))
        expect(result.kind).toBe('aggregate-panel')
        if (result.kind === 'aggregate-panel') {
            expect(result.memberVerdicts[0]?.editorName).toBe('Hater')
        }
    })

    it('throws invalid-output on wrong-schema and malformed payloads', () => {
        try {
            azureOpenAiAdapter.parseBufferedResponse(chatResponse(wrongSchemaResult()))
            expect.unreachable()
        } catch (error) {
            expect((error as ProviderError).code).toBe('invalid-output')
        }
        expect(() =>
            azureOpenAiAdapter.parseBufferedResponse({
                choices: [{ message: { content: 'not json' } }]
            })
        ).toThrow(ProviderError)
        expect(() => azureOpenAiAdapter.parseBufferedResponse(undefined)).toThrow(ProviderError)
    })
})

describe('azureOpenAiAdapter.capabilities', () => {
    it('is buffered-only until Azure streaming is verified', () => {
        expect(azureOpenAiAdapter.capabilities()).toEqual({
            streaming: false,
            jsonSchema: true,
            reportsUsage: true
        })
    })
})
