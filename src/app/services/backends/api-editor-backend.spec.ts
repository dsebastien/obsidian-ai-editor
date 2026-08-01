import { describe, expect, it } from 'bun:test'
import type { OperationEvent } from '../../domain/operations/contract'
import type { ApiBackend } from '../../domain/settings/settings-schema'
import { createApiEditorExecutor } from './api-editor-backend'
import { makeConfig, reviewOperation, validReviewResult } from './providers/spec-fixtures'

/**
 * Executor specs with a fake fetch: no network, adversarially chunked SSE
 * fixtures, protocol assertions (runId echo, exactly one terminal event,
 * terminal last) on every path.
 */

const RUN_ID = 'run-1' // reviewOperation()'s runId

interface RecordedCall {
    readonly url: string
    readonly init: RequestInit
}

/** Streams `bodyText` as UTF-8 chunks of `chunkSize` characters. */
function makeStreamingFetch(
    bodyText: string,
    chunkSize: number
): { calls: RecordedCall[]; fetchImpl: typeof fetch } {
    const calls: RecordedCall[] = []
    const fetchImpl = ((url: string | URL, init?: RequestInit) => {
        calls.push({ url: String(url), init: init ?? {} })
        const encoder = new TextEncoder()
        const chunks: Uint8Array[] = []
        for (let i = 0; i < bodyText.length; i += chunkSize) {
            chunks.push(encoder.encode(bodyText.slice(i, i + chunkSize)))
        }
        let index = 0
        const stream = new ReadableStream<Uint8Array>({
            pull(controller) {
                const next = chunks[index]
                index += 1
                if (next === undefined) {
                    controller.close()
                } else {
                    controller.enqueue(next)
                }
            }
        })
        return Promise.resolve(new Response(stream, { status: 200 }))
    }) as unknown as typeof fetch
    return { calls, fetchImpl }
}

/** Returns a JSON (or raw text) body in one buffered response. */
function makeBufferedFetch(
    body: string,
    status = 200
): { calls: RecordedCall[]; fetchImpl: typeof fetch } {
    const calls: RecordedCall[] = []
    const fetchImpl = ((url: string | URL, init?: RequestInit) => {
        calls.push({ url: String(url), init: init ?? {} })
        return Promise.resolve(new Response(body, { status }))
    }) as unknown as typeof fetch
    return { calls, fetchImpl }
}

function makeExecutor(
    fetchImpl: typeof fetch,
    overrides: Partial<ApiBackend> = {},
    timeoutMs = 5_000
) {
    return createApiEditorExecutor({
        backendConfig: makeConfig(overrides),
        model: 'test-model',
        systemPrompt: 'You are a ruthless concision editor.',
        timeoutMs,
        fetchImpl
    })
}

async function collect(iterable: AsyncIterable<OperationEvent>): Promise<OperationEvent[]> {
    const events: OperationEvent[] = []
    for await (const event of iterable) {
        events.push(event)
    }
    return events
}

/** Parses the JSON body a fake-fetch call was invoked with. */
function sentJsonBody(call: RecordedCall | undefined): Record<string, unknown> {
    const body = call?.init.body
    if (typeof body !== 'string') {
        throw new Error('expected a string request body')
    }
    return JSON.parse(body) as Record<string, unknown>
}

/** Protocol invariants: runId echo, exactly one terminal event, terminal last. */
function expectProtocol(events: OperationEvent[]): OperationEvent {
    expect(events.length).toBeGreaterThan(0)
    for (const event of events) {
        expect(event.runId).toBe(RUN_ID)
    }
    const terminal = events.filter((event) => event.type === 'result' || event.type === 'error')
    expect(terminal).toHaveLength(1)
    const last = events[events.length - 1]
    expect(last).toBe(terminal[0] as OperationEvent)
    return terminal[0] as OperationEvent
}

// ---------------------------------------------------------------------------
// SSE fixtures
// ---------------------------------------------------------------------------

function anthropicSse(resultJson: string): string {
    const splitAt = Math.floor(resultJson.length / 2)
    const parts = [resultJson.slice(0, splitAt), resultJson.slice(splitAt)]
    const lines = [
        'event: message_start',
        'data: {"type":"message_start","message":{"id":"msg_1"}}',
        '',
        'event: content_block_start',
        `data: ${JSON.stringify({
            type: 'content_block_start',
            index: 0,
            content_block: { type: 'tool_use', id: 'tu_1', name: 'emit_result', input: {} }
        })}`,
        ''
    ]
    for (const part of parts) {
        lines.push(
            'event: content_block_delta',
            `data: ${JSON.stringify({
                type: 'content_block_delta',
                index: 0,
                delta: { type: 'input_json_delta', partial_json: part }
            })}`,
            ''
        )
    }
    lines.push(
        'event: content_block_stop',
        'data: {"type":"content_block_stop","index":0}',
        '',
        'event: message_stop',
        'data: {"type":"message_stop"}',
        ''
    )
    return lines.join('\n')
}

function openAiSse(resultJson: string): string {
    const splitAt = Math.floor(resultJson.length / 2)
    const parts = [resultJson.slice(0, splitAt), resultJson.slice(splitAt)]
    const lines = ['data: {"choices":[{"delta":{"role":"assistant","content":""}}]}', '']
    for (const part of parts) {
        lines.push(`data: ${JSON.stringify({ choices: [{ delta: { content: part } }] })}`, '')
    }
    lines.push('data: [DONE]', '')
    return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Buffered path
// ---------------------------------------------------------------------------

describe('createApiEditorExecutor — buffered', () => {
    it('executes a non-streaming provider (Ollama) and emits one result', async () => {
        const payload = JSON.stringify({
            message: { role: 'assistant', content: JSON.stringify(validReviewResult()) }
        })
        const { calls, fetchImpl } = makeBufferedFetch(payload)
        const executor = makeExecutor(fetchImpl, { kind: 'ollama', apiKey: '' })

        const events = await collect(executor(reviewOperation(), new AbortController().signal))

        const terminal = expectProtocol(events)
        expect(terminal.type).toBe('result')
        if (terminal.type !== 'result') {
            throw new Error('expected result')
        }
        expect(terminal.result.kind).toBe('review')
        if (terminal.result.kind !== 'review') {
            throw new Error('expected review result')
        }
        expect(terminal.result.findings).toHaveLength(1)
        expect(terminal.result.findings[0]?.quote).toBe('Hello world')
        expect(terminal.result.summary).toBe('Solid draft overall')

        expect(calls).toHaveLength(1)
        expect(calls[0]?.url).toBe('http://127.0.0.1:11434/api/chat')
        const sentBody = sentJsonBody(calls[0])
        expect(sentBody['stream']).toBe(false)
    })

    it('maps a provider payload violating the contract to invalid-output', async () => {
        const payload = JSON.stringify({
            message: { role: 'assistant', content: 'this is not JSON at all' }
        })
        const { fetchImpl } = makeBufferedFetch(payload)
        const executor = makeExecutor(fetchImpl, { kind: 'ollama', apiKey: '' })

        const events = await collect(executor(reviewOperation(), new AbortController().signal))

        const terminal = expectProtocol(events)
        expect(terminal.type).toBe('error')
        if (terminal.type !== 'error') {
            throw new Error('expected error')
        }
        expect(terminal.error.code).toBe('invalid-output')
    })

    it('maps HTTP 401 to an auth error without reading the body', async () => {
        const { fetchImpl } = makeBufferedFetch('{"error":"bad key sk-super-secret"}', 401)
        const executor = makeExecutor(fetchImpl, { kind: 'ollama', apiKey: '' })

        const events = await collect(executor(reviewOperation(), new AbortController().signal))

        const terminal = expectProtocol(events)
        if (terminal.type !== 'error') {
            throw new Error('expected error')
        }
        expect(terminal.error.code).toBe('auth')
        expect(terminal.error.message).not.toContain('sk-super-secret')
    })

    it('maps an invalid backend configuration to a single error event without any fetch', async () => {
        const { calls, fetchImpl } = makeBufferedFetch('{}')
        const executor = makeExecutor(fetchImpl, { kind: 'anthropic', apiKey: '' })

        const events = await collect(executor(reviewOperation(), new AbortController().signal))

        const terminal = expectProtocol(events)
        if (terminal.type !== 'error') {
            throw new Error('expected error')
        }
        expect(terminal.error.code).toBe('unknown')
        expect(terminal.error.message).toContain('no API key')
        expect(calls).toHaveLength(0)
    })
})

// ---------------------------------------------------------------------------
// Streaming path
// ---------------------------------------------------------------------------

describe('createApiEditorExecutor — streaming', () => {
    it('decodes Anthropic tool-use input_json_delta frames into one result', async () => {
        const body = anthropicSse(JSON.stringify(validReviewResult()))
        // Chunk size 7 splits mid-line, mid-frame, mid-UTF-8 word.
        const { calls, fetchImpl } = makeStreamingFetch(body, 7)
        const executor = makeExecutor(fetchImpl, { kind: 'anthropic' })

        const events = await collect(executor(reviewOperation(), new AbortController().signal))

        const terminal = expectProtocol(events)
        expect(events.filter((event) => event.type === 'progress').length).toBeGreaterThan(0)
        if (terminal.type !== 'result' || terminal.result.kind !== 'review') {
            throw new Error('expected review result')
        }
        expect(terminal.result.findings).toHaveLength(1)
        expect(terminal.result.findings[0]?.quote).toBe('Hello world')
        expect(terminal.result.findings[0]?.severity).toBe('suggestion')
        expect(terminal.result.summary).toBe('Solid draft overall')

        expect(calls).toHaveLength(1)
        expect(calls[0]?.url).toBe('https://api.anthropic.com/v1/messages')
        const sentBody = sentJsonBody(calls[0])
        expect(sentBody['stream']).toBe(true)
        expect(sentBody['tool_choice']).toEqual({ type: 'tool', name: 'emit_result' })
    })

    it('decodes OpenAI chat.completions content deltas into one result', async () => {
        const body = openAiSse(JSON.stringify(validReviewResult()))
        const { calls, fetchImpl } = makeStreamingFetch(body, 11)
        const executor = makeExecutor(fetchImpl, { kind: 'openai' })

        const events = await collect(executor(reviewOperation(), new AbortController().signal))

        const terminal = expectProtocol(events)
        expect(events.filter((event) => event.type === 'progress').length).toBeGreaterThan(0)
        if (terminal.type !== 'result' || terminal.result.kind !== 'review') {
            throw new Error('expected review result')
        }
        expect(terminal.result.findings).toHaveLength(1)
        expect(terminal.result.findings[0]?.edits).toEqual([
            { op: 'replace', text: 'Bonjour world' }
        ])

        const sentBody = sentJsonBody(calls[0])
        expect(sentBody['stream']).toBe(true)
        expect(calls[0]?.url).toBe('https://api.openai.com/v1/chat/completions')
    })

    it('treats Anthropic thinking deltas as progress and drops thinking blocks from the result', async () => {
        const resultJson = JSON.stringify(validReviewResult())
        const lines = [
            'event: message_start',
            'data: {"type":"message_start","message":{"id":"msg_1"}}',
            '',
            // Thinking block first — extended thinking streams reasoning
            // before the tool call.
            'event: content_block_start',
            `data: ${JSON.stringify({
                type: 'content_block_start',
                index: 0,
                content_block: { type: 'thinking', thinking: '' }
            })}`,
            '',
            'event: content_block_delta',
            `data: ${JSON.stringify({
                type: 'content_block_delta',
                index: 0,
                delta: { type: 'thinking_delta', thinking: 'Let me reason about this…' }
            })}`,
            '',
            'event: content_block_delta',
            `data: ${JSON.stringify({
                type: 'content_block_delta',
                index: 0,
                delta: { type: 'signature_delta', signature: 'sig_abc' }
            })}`,
            '',
            'event: content_block_stop',
            'data: {"type":"content_block_stop","index":0}',
            '',
            'event: content_block_start',
            `data: ${JSON.stringify({
                type: 'content_block_start',
                index: 1,
                content_block: { type: 'tool_use', id: 'tu_1', name: 'emit_result', input: {} }
            })}`,
            '',
            'event: content_block_delta',
            `data: ${JSON.stringify({
                type: 'content_block_delta',
                index: 1,
                delta: { type: 'input_json_delta', partial_json: resultJson }
            })}`,
            '',
            'event: message_stop',
            'data: {"type":"message_stop"}',
            ''
        ].join('\n')
        const { calls, fetchImpl } = makeStreamingFetch(lines, 9)
        const executor = makeExecutor(fetchImpl, {
            kind: 'anthropic',
            thinking: 'budget',
            thinkingBudgetTokens: 2_048
        })

        const events = await collect(executor(reviewOperation(), new AbortController().signal))

        const terminal = expectProtocol(events)
        // Thinking deltas alone must already surface progress — a model
        // reasoning for minutes must not look like a hang.
        expect(events.filter((event) => event.type === 'progress').length).toBeGreaterThan(1)
        if (terminal.type !== 'result' || terminal.result.kind !== 'review') {
            throw new Error('expected review result')
        }
        expect(terminal.result.findings[0]?.quote).toBe('Hello world')

        const sentBody = sentJsonBody(calls[0])
        expect(sentBody['thinking']).toEqual({ type: 'enabled', budget_tokens: 2_048 })
        expect(sentBody['tool_choice']).toEqual({ type: 'auto' })
    })

    it('treats openai-compatible reasoning deltas as progress without leaking them into the result', async () => {
        const resultJson = JSON.stringify(validReviewResult())
        const lines = [
            // Reasoning phase first — DeepSeek streams `reasoning_content`,
            // OpenRouter `reasoning`; a thinking model enabled via
            // extraBodyJson may emit ONLY these for minutes before any
            // content arrives.
            `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: 'Let me think…' } }] })}`,
            '',
            `data: ${JSON.stringify({ choices: [{ delta: { reasoning: '…about this document.' } }] })}`,
            '',
            `data: ${JSON.stringify({ choices: [{ delta: { content: resultJson } }] })}`,
            '',
            'data: [DONE]',
            ''
        ].join('\n')
        const { fetchImpl } = makeStreamingFetch(lines, 9)
        const executor = makeExecutor(fetchImpl, {
            kind: 'openai-compatible',
            baseUrl: 'https://openrouter.example.test/api/v1'
        })

        const events = await collect(executor(reviewOperation(), new AbortController().signal))

        const terminal = expectProtocol(events)
        // Reasoning deltas alone must already surface progress — the exact
        // hang-lookalike failure mode this increment eliminates.
        expect(events.filter((event) => event.type === 'progress').length).toBeGreaterThan(1)
        if (terminal.type !== 'result' || terminal.result.kind !== 'review') {
            throw new Error('expected review result')
        }
        // The reasoning text is never accumulated into the payload.
        expect(terminal.result.findings[0]?.quote).toBe('Hello world')
        expect(JSON.stringify(terminal.result)).not.toContain('Let me think')
    })

    it('streams the openrouter kind like any other Chat Completions endpoint', async () => {
        const body = openAiSse(JSON.stringify(validReviewResult()))
        const { calls, fetchImpl } = makeStreamingFetch(body, 11)
        const executor = makeExecutor(fetchImpl, { kind: 'openrouter' })

        const events = await collect(executor(reviewOperation(), new AbortController().signal))

        // Streaming, not the buffered fallback: `stream: true` went out and
        // progress was reported while the payload arrived.
        const sentBody = sentJsonBody(calls[0])
        expect(sentBody['stream']).toBe(true)
        expect(calls[0]?.url).toBe('https://openrouter.ai/api/v1/chat/completions')
        expect(events.filter((event) => event.type === 'progress').length).toBeGreaterThan(0)
        const terminal = expectProtocol(events)
        if (terminal.type !== 'result' || terminal.result.kind !== 'review') {
            throw new Error('expected review result')
        }
        expect(terminal.result.findings[0]?.quote).toBe('Hello world')
    })

    it('maps a truncated stream whose payload fails validation to invalid-output', async () => {
        // Stream ends after half of the JSON — no more frames, no [DONE].
        const half = JSON.stringify(validReviewResult()).slice(0, 20)
        const body = [
            `data: ${JSON.stringify({ choices: [{ delta: { content: half } }] })}`,
            ''
        ].join('\n')
        const { fetchImpl } = makeStreamingFetch(body, 13)
        const executor = makeExecutor(fetchImpl, { kind: 'openai' })

        const events = await collect(executor(reviewOperation(), new AbortController().signal))

        const terminal = expectProtocol(events)
        if (terminal.type !== 'error') {
            throw new Error('expected error')
        }
        expect(terminal.error.code).toBe('invalid-output')
    })

    it('maps an Anthropic in-stream error frame (overloaded) to rate-limit', async () => {
        const body = [
            'event: error',
            'data: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
            ''
        ].join('\n')
        const { fetchImpl } = makeStreamingFetch(body, 9)
        const executor = makeExecutor(fetchImpl, { kind: 'anthropic' })

        const events = await collect(executor(reviewOperation(), new AbortController().signal))

        const terminal = expectProtocol(events)
        if (terminal.type !== 'error') {
            throw new Error('expected error')
        }
        expect(terminal.error.code).toBe('rate-limit')
    })
})

// ---------------------------------------------------------------------------
// Cancellation and timeout
// ---------------------------------------------------------------------------

describe('createApiEditorExecutor — cancellation and timeout', () => {
    it('aborting mid-stream terminates with a single cancelled error', async () => {
        const encoder = new TextEncoder()
        const firstChunk = [
            `data: ${JSON.stringify({ choices: [{ delta: { content: '{"kind":"review",' } }] })}`,
            '',
            ''
        ].join('\n')
        const fetchImpl = ((_url: string | URL, init?: RequestInit) => {
            const signal = init?.signal ?? null
            let sent = false
            const stream = new ReadableStream<Uint8Array>({
                pull(controller) {
                    if (!sent) {
                        sent = true
                        controller.enqueue(encoder.encode(firstChunk))
                        return undefined
                    }
                    // Hang until the transport is aborted, like a live socket.
                    return new Promise<void>((_resolve, reject) => {
                        const fail = (): void => {
                            reject(new DOMException('The operation was aborted.', 'AbortError'))
                        }
                        if (signal?.aborted) {
                            fail()
                            return
                        }
                        signal?.addEventListener('abort', fail, { once: true })
                    })
                }
            })
            return Promise.resolve(new Response(stream, { status: 200 }))
        }) as unknown as typeof fetch
        const executor = makeExecutor(fetchImpl, { kind: 'openai' })

        const abort = new AbortController()
        const events: OperationEvent[] = []
        for await (const event of executor(reviewOperation(), abort.signal)) {
            events.push(event)
            if (event.type === 'progress') {
                abort.abort()
            }
        }

        const terminal = expectProtocol(events)
        if (terminal.type !== 'error') {
            throw new Error('expected error')
        }
        expect(terminal.error.code).toBe('cancelled')
    })

    it('a request exceeding timeoutMs terminates with a single timeout error', async () => {
        const fetchImpl = ((_url: string | URL, init?: RequestInit) =>
            new Promise<Response>((_resolve, reject) => {
                init?.signal?.addEventListener(
                    'abort',
                    () => {
                        reject(new DOMException('The operation was aborted.', 'AbortError'))
                    },
                    { once: true }
                )
            })) as unknown as typeof fetch
        const executor = makeExecutor(fetchImpl, { kind: 'ollama', apiKey: '' }, 20)

        const events = await collect(executor(reviewOperation(), new AbortController().signal))

        const terminal = expectProtocol(events)
        if (terminal.type !== 'error') {
            throw new Error('expected error')
        }
        expect(terminal.error.code).toBe('timeout')
        // The message states the elapsed bound in seconds AND names the
        // 'Request timeout' setting — the user's fix must be in the message.
        expect(terminal.error.message).toBe(
            "Provider did not answer within 0.02 s — raise 'Request timeout' in settings if your model needs longer."
        )
    })

    it('a signal already aborted before start terminates with cancelled', async () => {
        const { calls, fetchImpl } = makeBufferedFetch('{}')
        const executor = makeExecutor(fetchImpl, { kind: 'ollama', apiKey: '' })
        const abort = new AbortController()
        abort.abort()

        const events = await collect(executor(reviewOperation(), abort.signal))

        const terminal = expectProtocol(events)
        if (terminal.type !== 'error') {
            throw new Error('expected error')
        }
        expect(terminal.error.code).toBe('cancelled')
        expect(calls).toHaveLength(0)
    })
})
