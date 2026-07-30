import { describe, expect, it } from 'bun:test'
import { HEALTH_CHECK_TIMEOUT_MS, checkBackendHealth, classifyHealthEvent } from './health-check'
import { TEST_API_KEY, makeConfig, validReviewResult } from './providers/spec-fixtures'

/**
 * Health-check specs: the pure classification of every terminal event, plus the
 * real executor path behind a fake fetch (no network).
 */

interface RecordedCall {
    readonly url: string
    /** Serialized request body — the only part these specs assert on. */
    readonly body: string
}

function makeFetch(body: string, status = 200): { calls: RecordedCall[]; fetchImpl: typeof fetch } {
    const calls: RecordedCall[] = []
    const fetchImpl = ((url: string | URL, init?: RequestInit) => {
        calls.push({ url: String(url), body: typeof init?.body === 'string' ? init.body : '' })
        return Promise.resolve(new Response(body, { status }))
    }) as unknown as typeof fetch
    return { calls, fetchImpl }
}

/**
 * Ollama's buffered envelope. Used for the success paths because Ollama is the
 * one shipped provider the executor runs buffered (no SSE decoder), which keeps
 * these specs about the health check rather than about stream framing — the
 * streaming paths have their own coverage in `api-editor-backend.spec.ts`.
 */
const OLLAMA_BACKEND = { kind: 'ollama' as const, baseUrl: 'http://localhost:11434', apiKey: '' }

function ollamaBody(content: string): string {
    return JSON.stringify({ message: { role: 'assistant', content } })
}

// ---------------------------------------------------------------------------
// classifyHealthEvent
// ---------------------------------------------------------------------------

describe('classifyHealthEvent', () => {
    it('is ok on a result', () => {
        const result = classifyHealthEvent({
            type: 'result',
            runId: 'r',
            result: { kind: 'review', findings: [] }
        })
        expect(result.status).toBe('ok')
        expect(result.code).toBe('')
    })

    it('separates a reachable endpoint with an unusable answer from a failure', () => {
        const result = classifyHealthEvent({
            type: 'error',
            runId: 'r',
            error: { code: 'invalid-output', message: 'not a tool call' }
        })
        expect(result.status).toBe('unusable')
        expect(result.code).toBe('invalid-output')
        expect(result.message).toContain('stronger model')
    })

    it('reports auth failures verbatim from the transport', () => {
        const result = classifyHealthEvent({
            type: 'error',
            runId: 'r',
            error: { code: 'auth', message: 'Provider rejected the credentials (HTTP 401)' }
        })
        expect(result.status).toBe('failed')
        expect(result.code).toBe('auth')
        expect(result.message).toBe('Provider rejected the credentials (HTTP 401)')
    })

    it('tells the user a slow local model may still work when the probe times out', () => {
        const result = classifyHealthEvent({
            type: 'error',
            runId: 'r',
            error: { code: 'timeout', message: 'whatever the executor said' }
        })
        expect(result.status).toBe('failed')
        expect(result.message).toContain(String(HEALTH_CHECK_TIMEOUT_MS / 1_000))
        expect(result.message).toContain('Request timeout')
    })

    it('fails on a missing terminal event instead of assuming success', () => {
        expect(classifyHealthEvent(null).status).toBe('failed')
        expect(classifyHealthEvent({ type: 'progress', runId: 'r' }).status).toBe('failed')
    })
})

// ---------------------------------------------------------------------------
// checkBackendHealth — the real executor, faked transport
// ---------------------------------------------------------------------------

describe('checkBackendHealth', () => {
    it('sends exactly one request and reports success on a valid answer', async () => {
        const { calls, fetchImpl } = makeFetch(ollamaBody(JSON.stringify(validReviewResult())))
        const result = await checkBackendHealth({
            backend: makeConfig(OLLAMA_BACKEND),
            model: 'test-model',
            fetchImpl,
            timeoutMs: 5_000
        })
        expect(result.status).toBe('ok')
        expect(calls.length).toBe(1)
    })

    it('probes with a short document, not the user’s note', async () => {
        const { calls, fetchImpl } = makeFetch(ollamaBody(JSON.stringify(validReviewResult())))
        await checkBackendHealth({
            backend: makeConfig(OLLAMA_BACKEND),
            model: 'test-model',
            fetchImpl,
            timeoutMs: 5_000
        })
        const body = calls[0]?.body ?? ''
        expect(body).toContain('quick brown fox')
        expect(body.length).toBeLessThan(4_000)
    })

    it('reports an unusable answer when the model ignores the structure', async () => {
        const { fetchImpl } = makeFetch(ollamaBody('Sure! Looks good.'))
        const result = await checkBackendHealth({
            backend: makeConfig(OLLAMA_BACKEND),
            model: 'test-model',
            fetchImpl,
            timeoutMs: 5_000
        })
        expect(result.status).toBe('unusable')
    })

    it('reports bad credentials as a failure', async () => {
        const { fetchImpl } = makeFetch('{"error":"nope"}', 401)
        const result = await checkBackendHealth({
            backend: makeConfig(),
            model: 'test-model',
            fetchImpl,
            timeoutMs: 5_000
        })
        expect(result.status).toBe('failed')
        expect(result.code).toBe('auth')
    })

    it('reports an unreachable endpoint as a failure', async () => {
        const fetchImpl = (() =>
            Promise.reject(new TypeError('Failed to fetch'))) as unknown as typeof fetch
        const result = await checkBackendHealth({
            backend: makeConfig(OLLAMA_BACKEND),
            model: 'test-model',
            fetchImpl,
            timeoutMs: 5_000
        })
        expect(result.status).toBe('failed')
        expect(result.code).toBe('network')
    })

    it('reports a misconfigured backend as a failure without touching the transport', async () => {
        let called = false
        const fetchImpl = (() => {
            called = true
            return Promise.resolve(new Response('{}', { status: 200 }))
        }) as unknown as typeof fetch
        const result = await checkBackendHealth({
            // Azure without a deployment cannot build a request at all.
            backend: makeConfig({ kind: 'azure-openai', baseUrl: 'https://x.openai.azure.com' }),
            model: 'test-model',
            fetchImpl,
            timeoutMs: 5_000
        })
        expect(result.status).toBe('failed')
        expect(called).toBe(false)
    })

    it('never echoes the API key in its message', async () => {
        const { fetchImpl } = makeFetch(`{"error":"key ${TEST_API_KEY} is invalid"}`, 401)
        const result = await checkBackendHealth({
            backend: makeConfig(),
            model: 'test-model',
            fetchImpl,
            timeoutMs: 5_000
        })
        expect(result.message).not.toContain(TEST_API_KEY)
    })
})
