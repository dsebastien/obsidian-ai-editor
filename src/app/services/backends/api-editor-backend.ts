import { guardTruncation } from './providers/result'
import type { ValidatedOperationResult } from './providers/result'
import type { OperationEvent, OperationRequest } from '../../domain/operations/contract'
import type { ApiBackend, ApiProviderKind } from '../../domain/settings/settings-schema'
import { getProviderAdapter, ProviderError } from './providers'
import type { HttpRequestDescriptor, ProviderAdapter } from './providers'
import { parseSseJson, SseDecoder, type SseEvent } from './transport/sse'
import { resolveFetchImpl, type FetchFn } from './resolve-fetch'
import { setTimer, clearTimer } from '../../../utils/timers'

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
    /**
     * Upper bound for the whole operation, connect + stream, in ms.
     * Sourced from `behavior.requestTimeoutSeconds` (the 'Request timeout'
     * setting) via `reviewTimeoutMs`; the timeout error message names that
     * setting, so keep the wiring intact.
     */
    readonly timeoutMs: number
    /** Injectable transport for tests; defaults to the global `fetch`. */
    readonly fetchImpl?: FetchFn
}

export type TransportErrorCode =
    | 'auth'
    | 'rate-limit'
    /** Credits/billing exhausted (issue #23) — never retried. */
    | 'quota'
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
    /** Provider-requested wait (Retry-After) for rate-limit failures. */
    readonly retryAfterMs: number | null

    constructor(code: TransportErrorCode, message: string, retryAfterMs: number | null = null) {
        super(message)
        this.name = 'TransportError'
        this.code = code
        this.retryAfterMs = retryAfterMs
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
    const timer = setTimer(() => {
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
            clearTimer(timer)
            userSignal.removeEventListener('abort', onUserAbort)
        }
    }
}

type OperationErrorDetail = Extract<OperationEvent, { type: 'error' }>['error']

/**
 * Builds the `execute` function the `RunController` injects per editor.
 * The returned function is reusable across runs (it closes over
 * configuration, not run state) and never throws — every failure surfaces
 * as exactly one `error` event.
 */
export function createApiEditorExecutor(input: CreateApiEditorExecutorInput): ApiEditorExecutor {
    const { backendConfig, model, systemPrompt, timeoutMs } = input
    const fetchFn: FetchFn = resolveFetchImpl(input.fetchImpl)

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
    await assertOkStatus(response)
    const text = await response.text()
    let raw: unknown
    try {
        raw = JSON.parse(text) as unknown
    } catch {
        throw new ProviderError('invalid-output', 'Provider response is not valid JSON')
    }
    const validated = adapter.parseBufferedResponse(raw)
    yield {
        type: 'result',
        runId,
        result: validated.result,
        ...(validated.salvage ? { salvage: validated.salvage } : {})
    }
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
    finalize(): ValidatedOperationResult
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
    await assertOkStatus(response)
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
    const validated = accumulator.finalize()
    yield {
        type: 'result',
        runId,
        result: validated.result,
        ...(validated.salvage ? { salvage: validated.salvage } : {})
    }
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
        case 'openrouter':
        case 'openai-compatible':
            // OpenRouter speaks Chat Completions SSE like the other two — it
            // rides the same adapter, so it must ride the same decoder.
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
 * blocks, or `thinking_delta.thinking` under extended thinking — progress
 * only, never payload); `message_stop` ends the stream. Frames are
 * reassembled into the buffered `{ content: [...] }` envelope with
 * thinking blocks dropped.
 */
function createAnthropicAccumulator(adapter: ProviderAdapter): StreamAccumulator {
    const blocks = new Map<number, AnthropicBlock>()
    let stopReason = ''
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
                    if (
                        delta['type'] === 'thinking_delta' &&
                        typeof delta['thinking'] === 'string'
                    ) {
                        // Reasoning content is never accumulated into the
                        // payload (thinking blocks are dropped at finalize),
                        // but it IS progress: without this, a model thinking
                        // for minutes looks exactly like a hang.
                        return delta['thinking'].length > 0
                    }
                    return false
                }
                case 'message_delta': {
                    // Carries the final `stop_reason` — 'max_tokens' is the
                    // truncation verdict (issue #18), preserved into the
                    // reassembled envelope for the adapter's check.
                    const delta =
                        typeof frame['delta'] === 'object' && frame['delta'] !== null
                            ? (frame['delta'] as Record<string, unknown>)
                            : {}
                    if (typeof delta['stop_reason'] === 'string') {
                        stopReason = delta['stop_reason']
                    }
                    return false
                }
                default:
                    // message_start / message_stop / ping — no payload
                    // content to accumulate.
                    return false
            }
        },
        finalize(): ValidatedOperationResult {
            // The guard covers `parseToolInput` too: a stream cut mid
            // tool-JSON throws before the reassembled envelope (and the
            // adapter's own stop_reason check) exists (issue #18).
            return guardTruncation(stopReason === 'max_tokens', () => {
                const content = [...blocks.entries()]
                    .sort(([a], [b]) => a - b)
                    // Thinking blocks (extended thinking) carry no payload —
                    // drop them so the reassembled envelope holds only result
                    // content.
                    .filter(
                        ([, block]) =>
                            block.kind !== 'thinking' && block.kind !== 'redacted_thinking'
                    )
                    .map(([, block]) =>
                        block.kind === 'tool_use'
                            ? { type: 'tool_use', name: block.name, input: parseToolInput(block) }
                            : { type: 'text', text: block.text }
                    )
                return adapter.parseBufferedResponse({
                    content,
                    ...(stopReason.length > 0 ? { stop_reason: stopReason } : {})
                })
            })
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
 * `{ choices: [{ message }] }` envelope. Reasoning models behind
 * compatible endpoints stream their reasoning as `delta.reasoning_content`
 * (DeepSeek convention) or `delta.reasoning` (OpenRouter) — never part of
 * the payload, but counted as progress so a model reasoning for minutes
 * does not look like a hang.
 */
function createOpenAiAccumulator(adapter: ProviderAdapter): StreamAccumulator {
    let content = ''
    let refusal = ''
    let finishReason = ''
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
            // The last content frame carries the choice's finish_reason —
            // 'length' is the truncation verdict (issue #18), preserved into
            // the reassembled envelope for `chatCompletionTruncated`.
            const reason =
                typeof first === 'object' && first !== null
                    ? (first as Record<string, unknown>)['finish_reason']
                    : undefined
            if (typeof reason === 'string' && reason.length > 0) {
                finishReason = reason
            }
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
            // Reasoning deltas (DeepSeek `reasoning_content`, OpenRouter
            // `reasoning`) are progress but never payload — mirrors the
            // Anthropic accumulator's thinking_delta handling.
            if (
                typeof record['reasoning_content'] === 'string' &&
                record['reasoning_content'].length > 0
            ) {
                advanced = true
            }
            if (typeof record['reasoning'] === 'string' && record['reasoning'].length > 0) {
                advanced = true
            }
            return advanced
        },
        finalize(): ValidatedOperationResult {
            const message: Record<string, unknown> = { content }
            if (refusal.length > 0) {
                message['refusal'] = refusal
            }
            const choice: Record<string, unknown> = { message }
            if (finishReason.length > 0) {
                choice['finish_reason'] = finishReason
            }
            return adapter.parseBufferedResponse({ choices: [choice] })
        }
    }
}

// ---------------------------------------------------------------------------
// Error normalization
// ---------------------------------------------------------------------------

/**
 * Maps an HTTP failure status to a transport error. The response body may be
 * READ for classification (quota vs rate limit hides in provider-specific
 * error codes — issue #23) but is never echoed into a message: provider
 * error bodies can carry the submitted API key (Business Rules #12
 * constrains what is echoed, not how well the failure is understood).
 */
async function assertOkStatus(response: Response): Promise<void> {
    if (response.ok) {
        return
    }
    const status = response.status
    if (status === 401 || status === 403) {
        throw new TransportError(
            'auth',
            `Provider rejected the credentials (HTTP ${status}) — check the API key in the Backends settings tab.`
        )
    }
    if (status === 402) {
        throw new TransportError('quota', QUOTA_MESSAGE)
    }
    if (status === 429) {
        if (await bodySaysQuotaExhausted(response)) {
            throw new TransportError('quota', QUOTA_MESSAGE)
        }
        throw new TransportError(
            'rate-limit',
            'Provider rate limit reached (HTTP 429)',
            retryAfterMsOf(response)
        )
    }
    if (status >= 500) {
        throw new TransportError('network', `Provider is unavailable (HTTP ${status})`)
    }
    // The remaining 4xx are configuration mismatches, and the two the
    // providers actually send deserve a sentence that names the settings to
    // check (issue #39: a bare "HTTP 400" sent a user hunting for a firewall
    // problem that did not exist). Still status-only — the body is never
    // echoed, for the same reason as above.
    if (status === 400 || status === 422) {
        // Anthropic answers an EMPTY API-credit balance with a 400, not a
        // 402/429 (issue #39) — for a user whose Claude app works but whose
        // API account was never funded, "request invalid" would send them
        // chasing settings that are fine.
        if (await bodySaysQuotaExhausted(response)) {
            throw new TransportError('quota', QUOTA_MESSAGE)
        }
        throw new TransportError(
            'unknown',
            `The provider rejected the request as invalid (HTTP ${status}) — usually a ` +
                'thinking mode or output budget this model does not support, or a malformed ' +
                "model name. Try 'Thinking: off' and re-check the model in the Backends settings tab."
        )
    }
    if (status === 404) {
        throw new TransportError(
            'unknown',
            'The provider does not recognize the endpoint or model (HTTP 404) — check the ' +
                'model name and base URL in the Backends settings tab.'
        )
    }
    throw new TransportError('unknown', `Provider request failed (HTTP ${status})`)
}

const QUOTA_MESSAGE =
    'The provider reports your credit or quota is exhausted — retrying will not help until the account is topped up.'

/**
 * Largest error body classification will parse. `.text()` has already
 * buffered the body either way; the cap only bounds the PARSE — slicing a
 * larger body would corrupt its JSON and silently reclassify a genuine
 * quota failure as a rate limit (adversarial review, 2026-08-02), so an
 * oversized body is skipped whole and classified conservatively.
 */
const ERROR_BODY_SNIFF_MAX = 262_144

/**
 * Whether an error body says "out of credit" rather than what its status
 * suggests (issue #23; extended for #39): OpenAI-family uses
 * `error.code`/`error.type` `insufficient_quota` on 429; other providers use
 * billing/credit wordings in the same fields. One narrow exception to the
 * structured-fields-only rule: Anthropic reports an EMPTY API-credit balance
 * as a plain `invalid_request_error` over HTTP 400 — "Your credit balance is
 * too low…" in the message is the only place that failure is named, and it
 * is the single most common failure for a user whose Claude app works but
 * whose API account was never funded. The message is read for
 * CLASSIFICATION only; nothing read here reaches a user-visible string.
 */
async function bodySaysQuotaExhausted(response: Response): Promise<boolean> {
    let text: string
    try {
        text = await response.text()
    } catch {
        return false
    }
    if (text.length > ERROR_BODY_SNIFF_MAX) {
        return false
    }
    let parsed: unknown
    try {
        parsed = JSON.parse(text) as unknown
    } catch {
        return false
    }
    const error =
        typeof parsed === 'object' && parsed !== null
            ? (parsed as Record<string, unknown>)['error']
            : undefined
    if (typeof error !== 'object' || error === null) {
        return false
    }
    const record = error as Record<string, unknown>
    const token = [record['code'], record['type']]
        .filter((value): value is string => typeof value === 'string')
        .join(' ')
        .toLowerCase()
    const message = typeof record['message'] === 'string' ? record['message'].toLowerCase() : ''
    return (
        token.includes('insufficient_quota') ||
        token.includes('billing') ||
        token.includes('credit') ||
        message.includes('credit balance')
    )
}

/** Parses Retry-After (delta-seconds or HTTP date) into ms; null when absent/absurd. */
function retryAfterMsOf(response: Response): number | null {
    const header = response.headers.get('retry-after')
    if (header === null || header.length === 0) {
        return null
    }
    const seconds = Number(header)
    if (Number.isFinite(seconds) && seconds >= 0) {
        return Math.round(seconds * 1_000)
    }
    const date = Date.parse(header)
    if (Number.isNaN(date)) {
        return null
    }
    const delta = date - Date.now()
    return delta > 0 ? delta : 0
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
        // Name the setting: a user hitting this (slow local model, long
        // note) must learn the fix from the message itself, not from docs.
        return {
            code: 'timeout',
            message: `Provider did not answer within ${timeoutMs / 1_000} s — raise 'Request timeout' in settings if your model needs longer.`
        }
    }
    if (cause instanceof TransportError) {
        return {
            code: cause.code,
            message: cause.message,
            ...(cause.retryAfterMs !== null ? { retryAfterMs: cause.retryAfterMs } : {})
        }
    }
    if (cause instanceof ProviderError) {
        return {
            code:
                cause.code === 'invalid-output' || cause.code === 'truncated'
                    ? cause.code
                    : 'unknown',
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
