import { describe, expect, it } from 'bun:test'
import { anthropicAdapter } from './anthropic'
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

function build(overrides: Parameters<typeof makeConfig>[0] = {}) {
    return anthropicAdapter.buildRequest({
        operation: reviewOperation(),
        systemPrompt: 'You are a ruthless concision editor.',
        model: 'claude-sonnet-4-5',
        config: makeConfig({ kind: 'anthropic', ...overrides })
    })
}

describe('anthropicAdapter.buildRequest', () => {
    it('targets the Messages API with the required headers', () => {
        const request = build()
        expect(request.url).toBe('https://api.anthropic.com/v1/messages')
        expect(request.method).toBe('POST')
        expect(request.headers['x-api-key']).toBe(TEST_API_KEY)
        expect(request.headers['anthropic-version']).toBe('2023-06-01')
        expect(request.headers['content-type']).toBe('application/json')
        expect(request.headers['anthropic-dangerous-direct-browser-access']).toBe('true')
    })

    it('honors a base URL override and trims trailing slashes', () => {
        const request = build({ baseUrl: 'https://proxy.example.test/' })
        expect(request.url).toBe('https://proxy.example.test/v1/messages')
    })

    it('forces the result tool with the operation result schema', () => {
        const body = JSON.parse(build().body) as Record<string, unknown>
        expect(body['model']).toBe('claude-sonnet-4-5')
        expect(body['system']).toBe('You are a ruthless concision editor.')
        expect(body['tool_choice']).toEqual({ type: 'tool', name: 'emit_result' })
        const tools = body['tools'] as { name: string; input_schema: Record<string, unknown> }[]
        expect(tools).toHaveLength(1)
        expect(tools[0]?.name).toBe('emit_result')
        const schema = tools[0]?.input_schema as { properties: { kind: { const: string } } }
        expect(schema.properties.kind.const).toBe('review')
    })

    it('carries the document and kind directive in the user message', () => {
        const body = JSON.parse(build().body) as {
            messages: { role: string; content: string }[]
        }
        expect(body.messages).toHaveLength(1)
        expect(body.messages[0]?.role).toBe('user')
        expect(body.messages[0]?.content).toContain(DOCUMENT_TEXT)
        expect(body.messages[0]?.content).toContain('"kind" set to "review"')
    })

    it('sends no thinking block by default (thinking off)', () => {
        const body = JSON.parse(build().body) as Record<string, unknown>
        expect(body['thinking']).toBeUndefined()
        expect(body['max_tokens']).toBe(8_192)
        expect(body['tool_choice']).toEqual({ type: 'tool', name: 'emit_result' })
    })

    it('sends adaptive thinking and keeps forced tool use when thinking is on', () => {
        const body = JSON.parse(build({ thinking: 'on' }).body) as Record<string, unknown>
        // 'on' = adaptive (current API mode) — manual budget_tokens is
        // rejected with HTTP 400 on every current model.
        expect(body['thinking']).toEqual({ type: 'adaptive' })
        // Adaptive thinking supports forced tool use — the structural
        // output guarantee stays.
        expect(body['tool_choice']).toEqual({ type: 'tool', name: 'emit_result' })
        // Thinking counts against max_tokens — raised so a long think
        // cannot truncate the result.
        expect(body['max_tokens']).toBe(32_000)
    })

    it('sends the legacy manual-thinking block with the configured budget in budget mode', () => {
        const body = JSON.parse(
            build({ thinking: 'budget', thinkingBudgetTokens: 4_096 }).body
        ) as Record<string, unknown>
        expect(body['thinking']).toEqual({ type: 'enabled', budget_tokens: 4_096 })
        // Budget rides on top of the output budget: budget_tokens < max_tokens
        // holds by construction.
        expect(body['max_tokens']).toBe(8_192 + 4_096)
        // Forced tool use is incompatible with legacy manual thinking — relaxes to auto.
        expect(body['tool_choice']).toEqual({ type: 'auto' })
    })

    it('clamps budget mode to the 32k output ceiling of legacy models', () => {
        const body = JSON.parse(
            build({ thinking: 'budget', thinkingBudgetTokens: 32_000 }).body
        ) as Record<string, unknown>
        // 8192 + 32000 would exceed the legacy models' 32k max_tokens cap
        // (HTTP 400 at validation time) — clamp the sum, and keep
        // budget_tokens strictly below max_tokens with result headroom.
        expect(body['max_tokens']).toBe(32_000)
        expect(body['thinking']).toEqual({ type: 'enabled', budget_tokens: 30_976 })
    })

    it('keeps the result tool available in both thinking modes', () => {
        for (const thinking of ['on', 'budget'] as const) {
            const body = JSON.parse(build({ thinking }).body) as {
                tools: { name: string }[]
            }
            expect(body.tools).toHaveLength(1)
            expect(body.tools[0]?.name).toBe('emit_result')
        }
    })

    it('never leaks the API key into the body', () => {
        expect(build().body).not.toContain(TEST_API_KEY)
    })

    it('rejects a missing API key without leaking anything', () => {
        expect(() => build({ apiKey: '' })).toThrow(ProviderError)
        try {
            build({ apiKey: '' })
        } catch (error) {
            expect((error as ProviderError).code).toBe('invalid-config')
        }
    })

    it('rejects an empty model', () => {
        expect(() =>
            anthropicAdapter.buildRequest({
                operation: reviewOperation(),
                systemPrompt: 'persona',
                model: '',
                config: makeConfig({ kind: 'anthropic' })
            })
        ).toThrow(ProviderError)
    })

    it('config errors never contain the API key', () => {
        try {
            anthropicAdapter.buildRequest({
                operation: reviewOperation(),
                systemPrompt: 'persona',
                model: '',
                config: makeConfig({ kind: 'anthropic', label: `broken ${TEST_API_KEY}` })
            })
            expect.unreachable()
        } catch (error) {
            expect((error as Error).message).not.toContain(TEST_API_KEY)
            expect((error as Error).message).toContain('[redacted]')
        }
    })
})

describe('anthropicAdapter.parseBufferedResponse', () => {
    function toolUseResponse(input: unknown): unknown {
        return {
            id: 'msg_1',
            content: [
                { type: 'text', text: 'Reporting now.' },
                { type: 'tool_use', id: 'toolu_1', name: 'emit_result', input }
            ],
            stop_reason: 'tool_use'
        }
    }

    it('parses a valid review result from the forced tool call', () => {
        const { result, salvage } = anthropicAdapter.parseBufferedResponse(
            toolUseResponse(validReviewResult())
        )
        expect(salvage).toBeNull()
        expect(result.kind).toBe('review')
        if (result.kind === 'review') {
            expect(result.findings[0]?.quote).toBe('Hello world')
            expect(result.findings[0]?.evidence).toEqual([])
        }
    })

    it('parses a valid aggregate-panel result', () => {
        const { result } = anthropicAdapter.parseBufferedResponse(
            toolUseResponse(validPanelResult())
        )
        expect(result.kind).toBe('aggregate-panel')
        if (result.kind === 'aggregate-panel') {
            expect(result.recommendation).toBe('needs-work')
            expect(result.missingMembers).toEqual(['Beginner'])
        }
    })

    it('skips thinking blocks interleaved with the tool call', () => {
        const raw = {
            id: 'msg_2',
            content: [
                { type: 'thinking', thinking: 'Long reasoning…', signature: 'sig_abc' },
                { type: 'redacted_thinking', data: 'opaque-blob' },
                { type: 'text', text: 'Reporting now.' },
                { type: 'tool_use', id: 'toolu_2', name: 'emit_result', input: validReviewResult() }
            ],
            stop_reason: 'tool_use'
        }
        const { result } = anthropicAdapter.parseBufferedResponse(raw)
        expect(result.kind).toBe('review')
        if (result.kind === 'review') {
            expect(result.findings[0]?.quote).toBe('Hello world')
        }
    })

    it('skips thinking blocks ahead of the text-JSON fallback', () => {
        const raw = {
            content: [
                { type: 'thinking', thinking: 'Reasoning…', signature: 'sig' },
                { type: 'text', text: JSON.stringify(validReviewResult()) }
            ]
        }
        expect(anthropicAdapter.parseBufferedResponse(raw).result.kind).toBe('review')
    })

    it('throws invalid-output when only thinking blocks arrived', () => {
        const raw = {
            content: [{ type: 'thinking', thinking: 'All budget spent reasoning', signature: 's' }]
        }
        expect(() => anthropicAdapter.parseBufferedResponse(raw)).toThrow(ProviderError)
    })

    it('accepts a text-block JSON fallback when no tool call is present', () => {
        const raw = {
            content: [{ type: 'text', text: JSON.stringify(validReviewResult()) }]
        }
        expect(anthropicAdapter.parseBufferedResponse(raw).result.kind).toBe('review')
    })

    it('salvages a schema-violating finding instead of failing the review', () => {
        const { result, salvage } = anthropicAdapter.parseBufferedResponse(
            toolUseResponse(wrongSchemaResult())
        )
        if (result.kind !== 'review') {
            throw new Error('expected a review result')
        }
        expect(result.findings).toEqual([])
        expect(salvage).toEqual({ discardedFindings: 1, invalidProposals: 0 })
    })

    it('throws invalid-output on non-JSON text with no tool call', () => {
        const raw = { content: [{ type: 'text', text: 'I refuse to answer in JSON.' }] }
        expect(() => anthropicAdapter.parseBufferedResponse(raw)).toThrow(ProviderError)
    })

    it('throws invalid-output on malformed envelopes', () => {
        expect(() => anthropicAdapter.parseBufferedResponse(null)).toThrow(ProviderError)
        expect(() => anthropicAdapter.parseBufferedResponse('nope')).toThrow(ProviderError)
        expect(() => anthropicAdapter.parseBufferedResponse({ content: 'not-an-array' })).toThrow(
            ProviderError
        )
        expect(() => anthropicAdapter.parseBufferedResponse({ content: [] })).toThrow(ProviderError)
    })
})

describe('anthropicAdapter.capabilities', () => {
    it('reports streaming + server-side schema + usage', () => {
        expect(anthropicAdapter.capabilities()).toEqual({
            streaming: true,
            jsonSchema: true,
            reportsUsage: true
        })
    })
})
