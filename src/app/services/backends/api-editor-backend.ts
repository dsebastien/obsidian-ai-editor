import type {
    OperationEvent,
    OperationRequest,
    OperationResult
} from '../../domain/operations/contract'
import type { ApiBackend, ApiProviderKind } from '../../domain/settings/settings-schema'
import { getProviderAdapter, ProviderError } from './providers'
import type { HttpRequestDescriptor, ProviderAdapter } from './providers'
import { parseSseJson, SseDecoder, type SseEvent } from './transport/sse'

/**
 * API backend executor: the glue between one configured API backend
 * (provider adapter + resolved model + assembled system prompt) and the
 * `RunController`'s injected `execute` function.
 *
 * Guarantees (enforced here, relied upon by the orchestrator):
 * - Every emitted event echoes `request.runId`.
 * - Exactly one terminal event per invocation — a single `result` on
 *   success, a single `error` otherwise. Nothing ever throws out of the
 *   returned iterable.
 * - Cancellation: the caller's `AbortSignal` aborts the transport and the
 *   run terminates with `{ code: 'cancelled' }`.
 * - `timeoutMs` bounds the whole operation (connect + stream); expiry
 *   terminates with `{ code: 'timeout' }`.
 * - Error messages never embed response bodies: provider error bodies can
 *   echo the submitted API key (Business Rules #12). Status-code-only
 *   messages here; the orchestrator's `redactError` seam is defense in
 *   depth, not the primary barrier.
 *
 * Streaming: providers whose adapter reports `capabilities().streaming`
 * AND that frame their stream as SSE (Anthropic Messages, OpenAI-family
 * Chat Completions) are executed with `stream: true`; deltas are decoded
 * into `progress` events while the structured payload accumulates. At
 * stream end the accumulated payload is reassembled into the provider's
 * buffered envelope and parsed through the SAME `parseBufferedResponse`
 * as the non-streaming path — buffered-equivalent correctness first;
 * incremental finding extraction is deliberately out of scope (plan M3).
 */

/** Signature the `RunController` expects for an injected backend. */
export type ApiEditorExecutor = (
    request: OperationRequest,
    signal: AbortSignal
) => AsyncIterable<OperationEvent>

export interface CreateApiEditorExecutorInput {
    readonly backendConfig: ApiBackend
    /** Resolved model id (backend default or per-editor override). */
    readonly model: string
    /** Fully assembled system prompt (voice profile + persona + context). */
    readonly systemPrompt: string
    /** Upper bound for the whole operation, connect + stream, in ms. */
    readonly timeoutMs: number
    /** Injectable transport for tests; defaults to the global `fetch`. */
    readonly fetchImpl?: typeof fetch
}

export type TransportErrorCode =
    | 'auth'
    | 'rate-limit'
    | 'network'
    | 'timeout'
    | 'cancelled'
    | 'unknown'

/**
 * Typed transport-level failure (HTTP status, stream-frame errors). The
 * code vocabulary is a subset of the operation contract's error codes so
 * normalization is a pass-through. Messages must never contain secrets.
 *
 * This is the ONE transport error type of the plugin — the review flow has a
 * single transport (this module). Keep it that way: two same-named error
 * classes make `instanceof` checks silently fail across modules.
 */
export class TransportError extends Error {
    readonly code: TransportErrorCode

    constructor(code: TransportErrorCode, message: string) {
        super(message)
        this.name = 'TransportError'
        this.code = code
    }
}

/**
 * Composition of the user signal with a deadline, tracking WHICH source
 * fired so failures map to 'cancelled' vs 'timeout' correctly.
 */
interface ComposedAbort {
    readonly signal: AbortSignal
    timedOut(): boolean
    /** Releases the fallback timer/listener; no-op on the native path. */
    dispose(): void
}

/**
 * Prefers native `AbortSignal.timeout` + `AbortSignal.any` (verified
 * available in bun and in Obsidian's Electron/Chromium >= 116). The manual
 * `setTimeout` + `AbortController` composition only exists as a fallback
 * for exotic runtimes and is behavior-identical.
 */
function composeAbort(userSignal: AbortSignal, timeoutMs: number): ComposedAbort {
    if (typeof AbortSignal.timeout === 'function' && typeof AbortSignal.any === 'function') {
        const timeoutSignal = AbortSignal.timeout(timeoutMs)
        return {
            signal: AbortSignal.any([userSignal, timeoutSignal]),
            timedOut: () => timeoutSignal.aborted,
            dispose: () => {}
        }
    }
    const controller = new AbortController()
    let timedOut = false
    const timer = setTimeout(() => {
        timedOut = true
        controller.abort()
    }, timeoutMs)
    const onUserAbort = (): void => {
        controller.abort()
    }
    if (userSignal.aborted) {
        controller.abort()
    } else {
        userSignal.addEventListener('abort', onUserAbort, { once: true })
    }
    return {
        signal: controller.signal,
        timedOut: () => timedOut,
        dispose: () => {
            clearTimeout(timer)
            userSignal.removeEventListener('abort', onUserAbort)
        }
    }
}

type OperationErrorDetail = Extract<OperationEvent, { type: 'error' }>['error']

/** Internal callable shape; the global `fetch` satisfies it. */
type FetchFn = (input: string, init?: RequestInit) => Promise<Response>

/**
 * Builds the `execute` function the `RunController` injects per editor.
 * The returned function is reusable across runs (it closes over
 * configuration, not run state) and never throws — every failure surfaces
 * as exactly one `error` event.
 */
export function createApiEditorExecutor(input: CreateApiEditorExecutorInput): ApiEditorExecutor {
    const { backendConfig, model, systemPrompt, timeoutMs } = input
    const fetchFn: FetchFn = input.fetchImpl ?? ((url, init) => globalThis.fetch(url, init))

    return async function* execute(
        request: OperationRequest,
        signal: AbortSignal
    ): AsyncGenerator<OperationEvent> {
        const runId = request.runId
        // Combined abort: caller cancellation OR timeout, distinguished by
        // flags at classification time (the transport only sees one signal).
        const composed = composeAbort(signal, timeoutMs)
        try {
            if (composed.signal.aborted) {
                // Aborted before start: never touch the transport.
                throw new TransportError('cancelled', 'Run aborted')
            }
            const adapter = getProviderAdapter(backendConfig.kind)
            const descriptor = adapter.buildRequest({
                operation: request,
                systemPrompt,
                model,
                config: backendConfig
            })
            const accumulator = createStreamAccumulator(backendConfig.kind, adapter)
            if (adapter.capabilities().streaming && accumulator !== null) {
                yield* executeStream(fetchFn, descriptor, accumulator, runId, composed.signal)
            } else {
                yield* executeBuffered(fetchFn, descriptor, adapter, runId, composed.signal)
            }
        } catch (cause) {
            yield {
                type: 'error',
                runId,
                error: normalizeError(cause, signal.aborted, composed.timedOut(), timeoutMs)
            }
        } finally {
            composed.dispose()
        }
    }
}

// ---------------------------------------------------------------------------
// Buffered path
// ---------------------------------------------------------------------------

async function* executeBuffered(
    fetchFn: FetchFn,
    descriptor: HttpRequestDescriptor,
    adapter: ProviderAdapter,
    runId: string,
    signal: AbortSignal
): AsyncGenerator<OperationEvent> {
    const response = await fetchFn(descriptor.url, {
        method: descriptor.method,
        headers: descriptor.headers,
        body: descriptor.body,
        signal
    })
    assertOkStatus(response)
    const text = await response.text()
    let raw: unknown
    try {
        raw = JSON.parse(text) as unknown
    } catch {
        throw new ProviderError('invalid-output', 'Provider response is not valid JSON')
    }
    yield { type: 'result', runId, result: adapter.parseBufferedResponse(raw) }
}

// ---------------------------------------------------------------------------
// Streaming path
// ---------------------------------------------------------------------------

/**
 * Accumulates one provider's SSE frames into the structured payload.
 * `push` returns true when the payload advanced (worth a progress event);
 * `finalize` reassembles the provider's buffered response envelope so the
 * adapter's `parseBufferedResponse` validates the stream exactly like the
 * buffered path.
 */
interface StreamAccumulator {
    push(event: SseEvent): boolean
    finalize(): OperationResult
}

async function* executeStream(
    fetchFn: FetchFn,
    descriptor: HttpRequestDescriptor,
    accumulator: StreamAccumulator,
    runId: string,
    signal: AbortSignal
): AsyncGenerator<OperationEvent> {
    const response = await fetchFn(descriptor.url, {
        method: descriptor.method,
        headers: descriptor.headers,
        body: enableStreamFlag(descriptor.body),
        signal
    })
    assertOkStatus(response)
    const sse = new SseDecoder()
    const body = response.body
    if (body === null) {
        // Transport without an incremental body: decode the full text once.
        const text = await response.text()
        for (const event of [...sse.push(text), ...sse.end()]) {
            accumulator.push(event)
        }
    } else {
        const reader = body.getReader()
        // Real `fetch` errors the body stream on abort; cancelling the
        // reader as well makes abort deterministic even for transports
        // that ignore the signal (pending reads resolve as done).
        const cancelReader = (): void => {
            reader.cancel().catch(() => undefined)
        }
        signal.addEventListener('abort', cancelReader, { once: true })
        const textDecoder = new TextDecoder()
        try {
            for (;;) {
                const chunk = await reader.read()
                if (chunk.done) {
                    break
                }
                for (const event of sse.push(textDecoder.decode(chunk.value, { stream: true }))) {
                    if (accumulator.push(event)) {
                        yield { type: 'progress', runId }
                    }
                }
            }
            const tail = textDecoder.decode()
            const tailEvents = tail.length > 0 ? sse.push(tail) : []
            for (const event of [...tailEvents, ...sse.end()]) {
                if (accumulator.push(event)) {
                    yield { type: 'progress', runId }
                }
            }
        } finally {
            signal.removeEventListener('abort', cancelReader)
            // Cancel (not just releaseLock) so the underlying connection is
            // released on EVERY exit path — normal end (no-op), thrown
            // stream-frame errors, and early consumer exit alike.
            await reader.cancel().catch(() => {
                // Already errored/closed — nothing left to release.
            })
        }
    }
    if (signal.aborted) {
        // A cancelled reader ends the stream cleanly; a truncated payload
        // must not masquerade as a result. `normalizeError` re-classifies
        // this as cancelled or timeout based on which flag tripped.
        throw new TransportError('cancelled', 'Run aborted')
    }
    yield { type: 'result', runId, result: accumulator.finalize() }
}

/**
 * Turns an adapter-built request body into its streaming variant. Adapters
 * build buffered requests (`stream: false` or absent); both the Anthropic
 * Messages and Chat Completions APIs switch on a top-level `stream` flag.
 */
function enableStreamFlag(body: string): string {
    const parsed = JSON.parse(body) as Record<string, unknown>
    parsed['stream'] = true
    return JSON.stringify(parsed)
}

/**
 * Provider-specific SSE accumulator, or null when the provider's stream
 * framing has no verified decoder here (Azure pending verification, Ollama
 * streams NDJSON) — those run buffered regardless of capabilities.
 */
function createStreamAccumulator(
    kind: ApiProviderKind,
    adapter: ProviderAdapter
): StreamAccumulator | null {
    switch (kind) {
        case 'anthropic':
            return createAnthropicAccumulator(adapter)
        case 'openai':
        case 'openai-compatible':
            return createOpenAiAccumulator(adapter)
        default:
            return null
    }
}

interface AnthropicBlock {
    kind: string
    name: string
    json: string
    text: string
    /** The `input` object from `content_block_start` (empty `{}` when streamed). */
    startInput: unknown
}

/**
 * Anthropic Messages stream: `content_block_start` opens a block per
 * index; `content_block_delta` carries `input_json_delta.partial_json`
 * fragments of the forced tool call (or `text_delta.text` for text
 * blocks); `message_stop` ends the stream. Frames are reassembled into
 * the buffered `{ content: [...] }` envelope.
 */
function createAnthropicAccumulator(adapter: ProviderAdapter): StreamAccumulator {
    const blocks = new Map<number, AnthropicBlock>()
    return {
        push(event: SseEvent): boolean {
            const payload = parseSseJson(event)
            if (typeof payload !== 'object' || payload === null) {
                return false
            }
            const frame = payload as Record<string, unknown>
            switch (frame['type']) {
                case 'error':
                    throw anthropicStreamError(frame['error'])
                case 'content_block_start': {
                    const index = typeof frame['index'] === 'number' ? frame['index'] : blocks.size
                    const start =
                        typeof frame['content_block'] === 'object' &&
                        frame['content_block'] !== null
                            ? (frame['content_block'] as Record<string, unknown>)
                            : {}
                    blocks.set(index, {
                        kind: typeof start['type'] === 'string' ? start['type'] : '',
                        name: typeof start['name'] === 'string' ? start['name'] : '',
                        json: '',
                        text: typeof start['text'] === 'string' ? start['text'] : '',
                        startInput: start['input']
                    })
                    return false
                }
                case 'content_block_delta': {
                    const index = typeof frame['index'] === 'number' ? frame['index'] : -1
                    const block = blocks.get(index)
                    const delta =
                        typeof frame['delta'] === 'object' && frame['delta'] !== null
                            ? (frame['delta'] as Record<string, unknown>)
                            : {}
                    if (!block) {
                        return false
                    }
                    if (
                        delta['type'] === 'input_json_delta' &&
                        typeof delta['partial_json'] === 'string'
                    ) {
                        block.json += delta['partial_json']
                        return delta['partial_json'].length > 0
                    }
                    if (delta['type'] === 'text_delta' && typeof delta['text'] === 'string') {
                        block.text += delta['text']
                        return delta['text'].length > 0
                    }
                    return false
                }
                default:
                    // message_start / message_delta / message_stop / ping —
                    // no payload content to accumulate.
                    return false
            }
        },
        finalize(): OperationResult {
            const content = [...blocks.entries()]
                .sort(([a], [b]) => a - b)
                .map(([, block]) =>
                    block.kind === 'tool_use'
                        ? { type: 'tool_use', name: block.name, input: parseToolInput(block) }
                        : { type: 'text', text: block.text }
                )
            return adapter.parseBufferedResponse({ content })
        }
    }
}

function parseToolInput(block: AnthropicBlock): unknown {
    if (block.json.length === 0) {
        return block.startInput
    }
    try {
        return JSON.parse(block.json) as unknown
    } catch {
        throw new ProviderError('invalid-output', 'Streamed tool input is not valid JSON')
    }
}

/** Maps an Anthropic in-stream `error` frame to a transport error code. */
function anthropicStreamError(error: unknown): TransportError {
    const record =
        typeof error === 'object' && error !== null ? (error as Record<string, unknown>) : {}
    const type = typeof record['type'] === 'string' ? record['type'] : ''
    const message =
        typeof record['message'] === 'string' && record['message'].length > 0
            ? record['message']
            : 'Provider stream reported an error'
    if (type.includes('overloaded') || type.includes('rate_limit')) {
        return new TransportError('rate-limit', message)
    }
    if (type.includes('authentication') || type.includes('permission')) {
        return new TransportError('auth', message)
    }
    return new TransportError('unknown', message)
}

/**
 * OpenAI-family Chat Completions stream: each `data:` frame carries
 * `choices[0].delta.content` (or `.refusal`) fragments; `data: [DONE]`
 * ends the stream. Fragments are reassembled into the buffered
 * `{ choices: [{ message }] }` envelope.
 */
function createOpenAiAccumulator(adapter: ProviderAdapter): StreamAccumulator {
    let content = ''
    let refusal = ''
    return {
        push(event: SseEvent): boolean {
            const payload = parseSseJson(event)
            if (typeof payload !== 'object' || payload === null) {
                return false // malformed frame or [DONE]
            }
            const choices = (payload as Record<string, unknown>)['choices']
            if (!Array.isArray(choices) || choices.length === 0) {
                return false // e.g. trailing usage-only chunk
            }
            const first: unknown = choices[0]
            const delta =
                typeof first === 'object' && first !== null
                    ? (first as Record<string, unknown>)['delta']
                    : undefined
            if (typeof delta !== 'object' || delta === null) {
                return false
            }
            const record = delta as Record<string, unknown>
            let advanced = false
            if (typeof record['content'] === 'string' && record['content'].length > 0) {
                content += record['content']
                advanced = true
            }
            if (typeof record['refusal'] === 'string' && record['refusal'].length > 0) {
                refusal += record['refusal']
                advanced = true
            }
            return advanced
        },
        finalize(): OperationResult {
            const message: Record<string, unknown> = { content }
            if (refusal.length > 0) {
                message['refusal'] = refusal
            }
            return adapter.parseBufferedResponse({ choices: [{ message }] })
        }
    }
}

// ---------------------------------------------------------------------------
// Error normalization
// ---------------------------------------------------------------------------

/**
 * Maps an HTTP failure status to a transport error. The response body is
 * deliberately never read into the message — provider error bodies can
 * echo the submitted API key (Business Rules #12).
 */
function assertOkStatus(response: Response): void {
    if (response.ok) {
        return
    }
    const status = response.status
    if (status === 401 || status === 403) {
        throw new TransportError('auth', `Provider rejected the credentials (HTTP ${status})`)
    }
    if (status === 429) {
        throw new TransportError('rate-limit', 'Provider rate limit reached (HTTP 429)')
    }
    if (status >= 500) {
        throw new TransportError('network', `Provider is unavailable (HTTP ${status})`)
    }
    throw new TransportError('unknown', `Provider request failed (HTTP ${status})`)
}

/**
 * Collapses any failure into the operation contract's error detail.
 * Cancellation and timeout are decided by the flags, not the thrown cause:
 * an abort surfaces as different exceptions depending on where the
 * transport was interrupted (fetch rejection, reader error, truncated
 * payload failing validation), and all of them mean the same thing.
 */
function normalizeError(
    cause: unknown,
    cancelled: boolean,
    timedOut: boolean,
    timeoutMs: number
): OperationErrorDetail {
    if (cancelled) {
        return { code: 'cancelled', message: 'Run cancelled' }
    }
    if (timedOut) {
        return { code: 'timeout', message: `Provider did not answer within ${timeoutMs} ms` }
    }
    if (cause instanceof TransportError) {
        return { code: cause.code, message: cause.message }
    }
    if (cause instanceof ProviderError) {
        return {
            code: cause.code === 'invalid-output' ? 'invalid-output' : 'unknown',
            message: cause.message
        }
    }
    if (cause instanceof TypeError) {
        // fetch rejects with TypeError on DNS/connection/CORS failures and
        // the browser deliberately hides WHICH ("Failed to fetch"). CORS is
        // the common trap here: requests run through the renderer's fetch,
        // and self-hosted endpoints (Ollama, LM Studio) reject browser
        // origins unless configured (e.g. OLLAMA_ORIGINS). Name it, or the
        // user is left staring at an opaque network error.
        return {
            code: 'network',
            message:
                `Network request failed: ${cause.message}. ` +
                'Check the endpoint URL and that the server is reachable; ' +
                'if it is a self-hosted endpoint, it may be blocking ' +
                'browser requests (CORS) — e.g. Ollama needs OLLAMA_ORIGINS=app://obsidian.md'
        }
    }
    return {
        code: 'unknown',
        message: cause instanceof Error ? cause.message : String(cause)
    }
}
