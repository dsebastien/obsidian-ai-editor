import { describe, expect, it } from 'bun:test'
import { ollamaAdapter } from './ollama'
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
    return ollamaAdapter.buildRequest({
        operation: reviewOperation(),
        systemPrompt: 'You are a beginner reader.',
        model: 'llama3.3',
        config: makeConfig({ kind: 'ollama', apiKey: '', ...overrides })
    })
}

function chatResponse(result: unknown): unknown {
    return {
        model: 'llama3.3',
        message: { role: 'assistant', content: JSON.stringify(result) },
        done: true,
        prompt_eval_count: 12,
        eval_count: 34
    }
}

describe('ollamaAdapter.buildRequest', () => {
    it('posts to /api/chat on the loopback default', () => {
        const request = build()
        expect(request.url).toBe('http://127.0.0.1:11434/api/chat')
        expect(request.method).toBe('POST')
        expect(request.headers).toEqual({ 'content-type': 'application/json' })
    })

    it('honors a base URL override and trims trailing slashes', () => {
        const request = build({ baseUrl: 'http://192.168.1.10:11434/' })
        expect(request.url).toBe('http://192.168.1.10:11434/api/chat')
    })

    it('requests buffered JSON output', () => {
        const body = JSON.parse(build().body) as {
            model: string
            format: string
            stream: boolean
            messages: { role: string; content: string }[]
        }
        expect(body.model).toBe('llama3.3')
        expect(body.format).toBe('json')
        expect(body.stream).toBe(false)
        expect(body.messages[0]).toEqual({ role: 'system', content: 'You are a beginner reader.' })
        expect(body.messages[1]?.content).toContain(DOCUMENT_TEXT)
        expect(body.messages[1]?.content).toContain('"kind" set to "review"')
    })

    it('sends think: false by default (thinking off)', () => {
        const body = JSON.parse(build().body) as { think: boolean }
        expect(body.think).toBe(false)
    })

    it('sends think: true for any non-off thinking mode', () => {
        for (const thinking of ['on', 'budget'] as const) {
            const body = JSON.parse(build({ thinking }).body) as { think: boolean }
            expect(body.think).toBe(true)
        }
    })

    it('sends no auth header and never embeds a configured key', () => {
        const request = build({ apiKey: TEST_API_KEY })
        expect(request.headers['authorization']).toBeUndefined()
        expect(request.body).not.toContain(TEST_API_KEY)
    })

    it('rejects an empty model with invalid-config, key redacted', () => {
        try {
            ollamaAdapter.buildRequest({
                operation: reviewOperation(),
                systemPrompt: 'persona',
                model: '',
                config: makeConfig({ kind: 'ollama' })
            })
            expect.unreachable()
        } catch (error) {
            expect(error).toBeInstanceOf(ProviderError)
            expect((error as ProviderError).code).toBe('invalid-config')
            expect((error as Error).message).not.toContain(TEST_API_KEY)
        }
    })
})

describe('ollamaAdapter.parseBufferedResponse', () => {
    it('parses a valid review result', () => {
        const { result, salvage } = ollamaAdapter.parseBufferedResponse(
            chatResponse(validReviewResult())
        )
        expect(salvage).toBeNull()
        expect(result.kind).toBe('review')
        if (result.kind === 'review') {
            expect(result.summary).toBe('Solid draft overall')
        }
    })

    it('parses a valid aggregate-panel result', () => {
        const { result } = ollamaAdapter.parseBufferedResponse(chatResponse(validPanelResult()))
        expect(result.kind).toBe('aggregate-panel')
    })

    it('ignores message.thinking — only content is parsed', () => {
        const raw = {
            model: 'qwen3',
            message: {
                role: 'assistant',
                thinking: 'Let me reason about this document at length…',
                content: JSON.stringify(validReviewResult())
            },
            done: true
        }
        const { result } = ollamaAdapter.parseBufferedResponse(raw)
        expect(result.kind).toBe('review')
        if (result.kind === 'review') {
            expect(result.summary).toBe('Solid draft overall')
        }
    })

    it('throws invalid-output when only thinking arrived (no content)', () => {
        const raw = {
            message: { role: 'assistant', thinking: 'reasoning only', content: '' }
        }
        expect(() => ollamaAdapter.parseBufferedResponse(raw)).toThrow(ProviderError)
    })

    it('salvages a schema-violating finding instead of failing the review', () => {
        const { result, salvage } = ollamaAdapter.parseBufferedResponse(
            chatResponse(wrongSchemaResult())
        )
        if (result.kind !== 'review') {
            throw new Error('expected a review result')
        }
        expect(result.findings).toEqual([])
        expect(salvage).toEqual({ discardedFindings: 1, invalidProposals: 0 })
    })

    it('throws invalid-output on malformed envelopes and non-JSON content', () => {
        expect(() => ollamaAdapter.parseBufferedResponse(null)).toThrow(ProviderError)
        expect(() => ollamaAdapter.parseBufferedResponse({})).toThrow(ProviderError)
        expect(() => ollamaAdapter.parseBufferedResponse({ message: {} })).toThrow(ProviderError)
        expect(() =>
            ollamaAdapter.parseBufferedResponse({ message: { content: 'plain prose' } })
        ).toThrow(ProviderError)
    })
})

describe('ollamaAdapter.capabilities', () => {
    it('is buffered with no server-side schema enforcement', () => {
        expect(ollamaAdapter.capabilities()).toEqual({
            streaming: false,
            jsonSchema: false,
            reportsUsage: true
        })
    })
})
