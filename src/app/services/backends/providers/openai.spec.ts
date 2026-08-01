import { describe, expect, it } from 'bun:test'
import { chatCompletionContent, openAiAdapter } from './openai'
import {
    DOCUMENT_TEXT,
    TEST_API_KEY,
    aggregatePanelOperation,
    makeConfig,
    reviewOperation,
    validPanelResult,
    validReviewResult,
    wrongSchemaResult
} from './spec-fixtures'
import { ProviderError } from './types'

function build(overrides: Parameters<typeof makeConfig>[0] = {}) {
    return openAiAdapter.buildRequest({
        operation: reviewOperation(),
        systemPrompt: 'You are a rigorous fact checker.',
        model: 'gpt-4.1',
        config: makeConfig({ kind: 'openai', ...overrides })
    })
}

function chatResponse(result: unknown): unknown {
    return {
        id: 'chatcmpl-1',
        choices: [
            {
                index: 0,
                message: { role: 'assistant', content: JSON.stringify(result) },
                finish_reason: 'stop'
            }
        ],
        usage: { prompt_tokens: 10, completion_tokens: 20 }
    }
}

describe('openAiAdapter.buildRequest', () => {
    it('targets Chat Completions with bearer auth', () => {
        const request = build()
        expect(request.url).toBe('https://api.openai.com/v1/chat/completions')
        expect(request.method).toBe('POST')
        expect(request.headers['authorization']).toBe(`Bearer ${TEST_API_KEY}`)
        expect(request.headers['content-type']).toBe('application/json')
    })

    it('uses server-enforced json_schema for native OpenAI', () => {
        const body = JSON.parse(build().body) as {
            model: string
            stream: boolean
            response_format: { type: string; json_schema: { name: string; schema: unknown } }
            messages: { role: string; content: string }[]
        }
        expect(body.model).toBe('gpt-4.1')
        expect(body.stream).toBe(false)
        expect(body.response_format.type).toBe('json_schema')
        expect(body.response_format.json_schema.name).toBe('operation_result')
        expect(body.messages[0]).toEqual({
            role: 'system',
            content: 'You are a rigorous fact checker.'
        })
        expect(body.messages[1]?.content).toContain(DOCUMENT_TEXT)
        expect(body.messages[1]?.content).toContain('"kind" set to "review"')
    })

    it('serializes an aggregate-panel operation with member reviews', () => {
        const request = openAiAdapter.buildRequest({
            operation: aggregatePanelOperation(),
            systemPrompt: 'You chair the pre-publish panel.',
            model: 'gpt-4.1',
            config: makeConfig({ kind: 'openai' })
        })
        const body = JSON.parse(request.body) as { messages: { content: string }[] }
        expect(body.messages[1]?.content).toContain('Cliché opener')
        expect(body.messages[1]?.content).toContain('"kind" set to "aggregate-panel"')
    })

    it('covers openai-compatible via base URL override with json_object mode', () => {
        const request = openAiAdapter.buildRequest({
            operation: reviewOperation(),
            systemPrompt: 'persona',
            model: 'llama-3.3-70b',
            config: makeConfig({
                kind: 'openai-compatible',
                baseUrl: 'https://openrouter.ai/api/v1/'
            })
        })
        expect(request.url).toBe('https://openrouter.ai/api/v1/chat/completions')
        const body = JSON.parse(request.body) as { response_format: { type: string } }
        expect(body.response_format).toEqual({ type: 'json_object' })
    })

    it('omits the auth header for keyless compatible servers', () => {
        const request = openAiAdapter.buildRequest({
            operation: reviewOperation(),
            systemPrompt: 'persona',
            model: 'local-model',
            config: makeConfig({
                kind: 'openai-compatible',
                apiKey: '',
                baseUrl: 'http://127.0.0.1:1234/v1'
            })
        })
        expect(request.headers['authorization']).toBeUndefined()
    })

    it('omits reasoning_effort by default (provider default)', () => {
        const body = JSON.parse(build().body) as Record<string, unknown>
        expect(body['reasoning_effort']).toBeUndefined()
    })

    it('passes reasoning_effort through for every non-default level', () => {
        for (const effort of ['minimal', 'low', 'medium', 'high'] as const) {
            const body = JSON.parse(build({ reasoningEffort: effort }).body) as Record<
                string,
                unknown
            >
            expect(body['reasoning_effort']).toBe(effort)
        }
    })

    it('never sends reasoning_effort for openai-compatible backends', () => {
        const body = JSON.parse(
            build({
                kind: 'openai-compatible',
                baseUrl: 'https://openrouter.example/api/v1',
                reasoningEffort: 'high'
            }).body
        ) as Record<string, unknown>
        expect(body['reasoning_effort']).toBeUndefined()
    })

    it('merges the extra request body into openai-compatible requests, extras winning', () => {
        const body = JSON.parse(
            build({
                kind: 'openai-compatible',
                baseUrl: 'https://openrouter.example/api/v1',
                extraBodyJson:
                    '{"reasoning": {"effort": "high"}, "response_format": {"type": "text"}}'
            }).body
        ) as Record<string, unknown>
        expect(body['reasoning']).toEqual({ effort: 'high' })
        // Extras override colliding keys — that is the point of the escape hatch.
        expect(body['response_format']).toEqual({ type: 'text' })
        // Untouched core fields survive the merge.
        expect(body['model']).toBe('gpt-4.1')
        expect(Array.isArray(body['messages'])).toBe(true)
    })

    it('ignores the extra request body for native OpenAI', () => {
        const body = JSON.parse(build({ extraBodyJson: '{"think": true}' }).body) as Record<
            string,
            unknown
        >
        expect(body['think']).toBeUndefined()
    })

    it('rejects invalid extra request body JSON with invalid-config, key redacted', () => {
        for (const extraBodyJson of ['{not json', '[1,2]', '"scalar"']) {
            try {
                build({
                    kind: 'openai-compatible',
                    baseUrl: 'https://openrouter.example/api/v1',
                    extraBodyJson
                })
                expect.unreachable()
            } catch (error) {
                expect(error).toBeInstanceOf(ProviderError)
                expect((error as ProviderError).code).toBe('invalid-config')
                expect((error as Error).message).not.toContain(TEST_API_KEY)
            }
        }
    })

    it('never leaks the API key into the body', () => {
        expect(build().body).not.toContain(TEST_API_KEY)
    })

    it('rejects native OpenAI without an API key', () => {
        try {
            build({ apiKey: '' })
            expect.unreachable()
        } catch (error) {
            expect(error).toBeInstanceOf(ProviderError)
            expect((error as ProviderError).code).toBe('invalid-config')
        }
    })

    it('rejects openai-compatible without a base URL, without leaking the key', () => {
        try {
            openAiAdapter.buildRequest({
                operation: reviewOperation(),
                systemPrompt: 'persona',
                model: 'm',
                config: makeConfig({ kind: 'openai-compatible', baseUrl: '' })
            })
            expect.unreachable()
        } catch (error) {
            expect((error as ProviderError).code).toBe('invalid-config')
            expect((error as Error).message).not.toContain(TEST_API_KEY)
        }
    })

    it('rejects an empty model', () => {
        expect(() =>
            openAiAdapter.buildRequest({
                operation: reviewOperation(),
                systemPrompt: 'persona',
                model: '',
                config: makeConfig({ kind: 'openai' })
            })
        ).toThrow(ProviderError)
    })
})

describe('openAiAdapter.parseBufferedResponse', () => {
    it('parses a valid review result', () => {
        const { result, salvage } = openAiAdapter.parseBufferedResponse(
            chatResponse(validReviewResult())
        )
        expect(salvage).toBeNull()
        expect(result.kind).toBe('review')
        if (result.kind === 'review') {
            expect(result.findings).toHaveLength(1)
            expect(result.findings[0]?.severity).toBe('suggestion')
        }
    })

    it('parses a valid aggregate-panel result', () => {
        const { result } = openAiAdapter.parseBufferedResponse(chatResponse(validPanelResult()))
        expect(result.kind).toBe('aggregate-panel')
        if (result.kind === 'aggregate-panel') {
            expect(result.topFixes.map((fix) => fix.action)).toEqual([
                'Rewrite the opening sentence'
            ])
        }
    })

    it('tolerates fenced JSON content from sloppy compatible servers', () => {
        const raw = {
            choices: [
                {
                    message: {
                        content: '```json\n' + JSON.stringify(validReviewResult()) + '\n```'
                    }
                }
            ]
        }
        expect(openAiAdapter.parseBufferedResponse(raw).result.kind).toBe('review')
    })

    it('salvages a schema-violating finding instead of failing the review', () => {
        const { result, salvage } = openAiAdapter.parseBufferedResponse(
            chatResponse(wrongSchemaResult())
        )
        if (result.kind !== 'review') {
            throw new Error('expected a review result')
        }
        expect(result.findings).toEqual([])
        expect(salvage).toEqual({ discardedFindings: 1, invalidProposals: 0 })
    })

    it('throws invalid-output on non-JSON content', () => {
        const raw = { choices: [{ message: { content: 'Sorry, I cannot do that.' } }] }
        expect(() => openAiAdapter.parseBufferedResponse(raw)).toThrow(ProviderError)
    })

    it('throws invalid-output on refusals and broken envelopes', () => {
        expect(() =>
            openAiAdapter.parseBufferedResponse({
                choices: [{ message: { refusal: 'No.', content: null } }]
            })
        ).toThrow(ProviderError)
        expect(() => openAiAdapter.parseBufferedResponse({})).toThrow(ProviderError)
        expect(() => openAiAdapter.parseBufferedResponse({ choices: [] })).toThrow(ProviderError)
        expect(() => openAiAdapter.parseBufferedResponse(null)).toThrow(ProviderError)
    })
})

describe('chatCompletionContent', () => {
    it('names the provider in envelope errors', () => {
        try {
            chatCompletionContent({}, 'Azure OpenAI')
            expect.unreachable()
        } catch (error) {
            expect((error as Error).message).toContain('Azure OpenAI')
        }
    })
})

describe('openAiAdapter.capabilities', () => {
    it('reports streaming + server-side schema + usage', () => {
        expect(openAiAdapter.capabilities()).toEqual({
            streaming: true,
            jsonSchema: true,
            reportsUsage: true
        })
    })
})

describe('openrouter profile', () => {
    const buildOpenRouter = (overrides: Parameters<typeof makeConfig>[0] = {}) =>
        openAiAdapter.buildRequest({
            operation: reviewOperation(),
            systemPrompt: 'persona',
            model: 'anthropic/claude-sonnet-4.5',
            config: makeConfig({ kind: 'openrouter', apiKey: 'sk-or-key', ...overrides })
        })

    it('defaults the base URL to the OpenRouter endpoint', () => {
        const request = buildOpenRouter()
        expect(request.url).toBe('https://openrouter.ai/api/v1/chat/completions')
    })

    it('honors an explicit base URL override', () => {
        const request = buildOpenRouter({ baseUrl: 'https://proxy.example.com/api/v1' })
        expect(request.url).toBe('https://proxy.example.com/api/v1/chat/completions')
    })

    it('sends the attribution headers and bearer auth', () => {
        const request = buildOpenRouter()
        expect(request.headers['authorization']).toBe('Bearer sk-or-key')
        expect(request.headers['http-referer']).toBe(
            'https://github.com/dsebastien/obsidian-ai-editor'
        )
        expect(request.headers['x-title']).toBe('AI Editor (Obsidian)')
    })

    it('requires an API key', () => {
        expect(() => buildOpenRouter({ apiKey: '' })).toThrow(
            /OpenRouter backend .* has no API key/
        )
    })

    it('uses json_object mode (schema rides in the prompt)', () => {
        const body = JSON.parse(buildOpenRouter().body) as { response_format: { type: string } }
        expect(body.response_format).toEqual({ type: 'json_object' })
    })

    it("forwards reasoning effort as OpenRouter's unified reasoning param", () => {
        const body = JSON.parse(buildOpenRouter({ reasoningEffort: 'high' }).body) as Record<
            string,
            unknown
        >
        expect(body['reasoning']).toEqual({ effort: 'high' })
        expect(body['reasoning_effort']).toBeUndefined()
    })

    it('omits the reasoning param on default effort', () => {
        const body = JSON.parse(buildOpenRouter().body) as Record<string, unknown>
        expect(body['reasoning']).toBeUndefined()
    })

    it('merges the advanced extra request body (extras win)', () => {
        const body = JSON.parse(
            buildOpenRouter({
                extraBodyJson: '{"provider": {"order": ["anthropic"]}, "stream": true}'
            }).body
        ) as Record<string, unknown>
        expect(body['provider']).toEqual({ order: ['anthropic'] })
        expect(body['stream']).toBe(true)
    })
})
