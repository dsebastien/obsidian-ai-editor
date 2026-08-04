import { describe, expect, it } from 'bun:test'
import type { FetchFn } from './resolve-fetch'
import {
    CLI_HEALTH_CHECK_TIMEOUT_MS,
    HEALTH_CHECK_TIMEOUT_MS,
    checkBackendHealth,
    classifyHealthEvent,
    healthCheckTimeoutMs
} from './health-check'
import { cliBackendSchema } from '../../domain/settings/settings-schema'
import type { CliBackend } from '../../domain/settings/settings-schema'
import { TEST_API_KEY, makeConfig, validReviewResult } from './providers/spec-fixtures'

function makeCliConfig(overrides: Record<string, unknown> = {}): CliBackend {
    const executablePath = (overrides['executablePath'] as string) ?? '/usr/local/bin/claude'
    return cliBackendSchema.parse({
        id: 'cli-1',
        family: 'cli',
        kind: 'claude-code',
        label: 'Claude Code',
        enabled: true,
        consent: { launchPath: executablePath, toolsPath: '' },
        ...overrides,
        executablePath
    })
}

/**
 * Health-check specs: the pure classification of every terminal event, plus the
 * real executor path behind a fake fetch (no network).
 */

interface RecordedCall {
    readonly url: string
    /** Serialized request body — the only part these specs assert on. */
    readonly body: string
}

function makeFetch(body: string, status = 200): { calls: RecordedCall[]; fetchImpl: FetchFn } {
    const calls: RecordedCall[] = []
    const fetchImpl = ((url: string | URL, init?: RequestInit) => {
        calls.push({ url: String(url), body: typeof init?.body === 'string' ? init.body : '' })
        return Promise.resolve(new Response(body, { status }))
    }) as unknown as FetchFn
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
        const result = classifyHealthEvent(
            {
                type: 'result',
                runId: 'r',
                result: { kind: 'review', findings: [] }
            },
            'api',
            HEALTH_CHECK_TIMEOUT_MS
        )
        expect(result.status).toBe('ok')
        expect(result.code).toBe('')
    })

    it('separates a reachable endpoint with an unusable answer from a failure', () => {
        const result = classifyHealthEvent(
            {
                type: 'error',
                runId: 'r',
                error: { code: 'invalid-output', message: 'not a tool call' }
            },
            'api',
            HEALTH_CHECK_TIMEOUT_MS
        )
        expect(result.status).toBe('unusable')
        expect(result.code).toBe('invalid-output')
        expect(result.message).toContain('stronger model')
    })

    it('reports auth failures verbatim from the transport', () => {
        const result = classifyHealthEvent(
            {
                type: 'error',
                runId: 'r',
                error: { code: 'auth', message: 'Provider rejected the credentials (HTTP 401)' }
            },
            'api',
            HEALTH_CHECK_TIMEOUT_MS
        )
        expect(result.status).toBe('failed')
        expect(result.code).toBe('auth')
        expect(result.message).toBe('Provider rejected the credentials (HTTP 401)')
    })

    it('tells the user a slow local model may still work when the probe times out', () => {
        const result = classifyHealthEvent(
            {
                type: 'error',
                runId: 'r',
                error: { code: 'timeout', message: 'whatever the executor said' }
            },
            'api',
            HEALTH_CHECK_TIMEOUT_MS
        )
        expect(result.status).toBe('failed')
        expect(result.message).toContain(String(HEALTH_CHECK_TIMEOUT_MS / 1_000))
        expect(result.message).toContain('Request timeout')
    })

    it('points a CLI backend at its own timeout, not the Behavior tab', () => {
        // The Behavior tab's request timeout does nothing for a CLI backend;
        // sending the user there would be sending them to the wrong control.
        const result = classifyHealthEvent(
            {
                type: 'error',
                runId: 'r',
                error: { code: 'timeout', message: 'whatever the executor said' }
            },
            'cli',
            CLI_HEALTH_CHECK_TIMEOUT_MS
        )
        expect(result.message).toContain(String(CLI_HEALTH_CHECK_TIMEOUT_MS / 1_000))
        expect(result.message).not.toContain('Request timeout')
    })

    it('quotes the bound that was actually applied, not the ceiling', () => {
        // A CLI backend whose Timeout is 60 s is probed for 60 s. Telling that
        // user 'no answer within 120 s' after one minute reads as the plugin
        // hanging rather than as their own setting doing its job.
        const result = classifyHealthEvent(
            {
                type: 'error',
                runId: 'r',
                error: { code: 'timeout', message: 'whatever the executor said' }
            },
            'cli',
            60_000
        )
        expect(result.message).toContain('60 s')
        expect(result.message).not.toContain('120 s')
    })

    it('explains an unusable CLI answer as an agent wrapping its result in prose', () => {
        const result = classifyHealthEvent(
            {
                type: 'error',
                runId: 'r',
                error: { code: 'invalid-output', message: 'not JSON' }
            },
            'cli',
            CLI_HEALTH_CHECK_TIMEOUT_MS
        )
        expect(result.status).toBe('unusable')
        expect(result.message).toContain('prose')
    })

    it('fails on a missing terminal event instead of assuming success', () => {
        expect(classifyHealthEvent(null, 'api', HEALTH_CHECK_TIMEOUT_MS).status).toBe('failed')
        expect(
            classifyHealthEvent({ type: 'progress', runId: 'r' }, 'api', HEALTH_CHECK_TIMEOUT_MS)
                .status
        ).toBe('failed')
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
        // Bound on the fixed prompt overhead (schema + format rules), NOT on
        // the document: it grew with the v2 edits schema and may grow again,
        // but a real note leaking in would blow far past this.
        expect(body.length).toBeLessThan(8_000)
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
            Promise.reject(new TypeError('Failed to fetch'))) as unknown as FetchFn
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
        }) as unknown as FetchFn
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

// ---------------------------------------------------------------------------
// CLI backends: the probe goes through the same boundary a real run does
// ---------------------------------------------------------------------------

describe('healthCheckTimeoutMs', () => {
    it('bounds an API probe well under the request timeout', () => {
        expect(healthCheckTimeoutMs(makeConfig())).toBe(HEALTH_CHECK_TIMEOUT_MS)
    })

    it('gives a CLI probe longer, an agent does more before it answers', () => {
        expect(healthCheckTimeoutMs(makeCliConfig())).toBe(CLI_HEALTH_CHECK_TIMEOUT_MS)
    })

    it('never outlives the backend’s own timeout', () => {
        // Probing for longer than the setting under test would certify a
        // configuration that cannot actually run.
        expect(healthCheckTimeoutMs(makeCliConfig({ timeoutSeconds: 30 }))).toBe(30_000)
    })
})

describe('checkBackendHealth (CLI)', () => {
    it('reports an executable that is not there, with the path in the message', async () => {
        const result = await checkBackendHealth({
            backend: makeCliConfig({ executablePath: '/definitely/not/here/claude' }),
            model: '',
            timeoutMs: 5_000
        })
        expect(result.status).toBe('failed')
        expect(result.message).toContain('/definitely/not/here/claude')
    })

    it('reports a path that is not a file at all', async () => {
        const result = await checkBackendHealth({
            backend: makeCliConfig({ executablePath: '/tmp' }),
            model: '',
            timeoutMs: 5_000
        })
        expect(result.status).toBe('failed')
        expect(result.message).toContain('not a file')
    })

    it('refuses a relative path the way the boundary would', async () => {
        const result = await checkBackendHealth({
            backend: makeCliConfig({ executablePath: 'claude' }),
            model: '',
            timeoutMs: 5_000
        })
        expect(result.status).toBe('failed')
        expect(result.message).toContain('absolute')
    })

    it('never launches a backend the user has not consented to — not even to test it', async () => {
        // The executable is REAL and would run: `process.execPath` exists and
        // is executable on any machine that can run this suite. The only thing
        // stopping the probe is the missing consent, and the check for it lives
        // in `createBackendExecutor` rather than in the dialog that happens to
        // call this today.
        const started = Date.now()
        const result = await checkBackendHealth({
            backend: makeCliConfig({
                executablePath: process.execPath,
                consent: { launchPath: '', toolsPath: '' }
            }),
            model: '',
            timeoutMs: 5_000
        })
        expect(result.status).toBe('failed')
        expect(result.message).toContain('has not been allowed to run')
        // No runtime was started, so this cannot have taken a process launch.
        expect(Date.now() - started).toBeLessThan(1_000)
    })
})
