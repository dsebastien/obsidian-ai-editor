import type { OperationEvent } from '../../domain/operations/contract'
import { CONTRACT_VERSION } from '../../domain/operations/contract'
import { generateId } from '../../domain/ids'
import { hashText } from '../../domain/snapshot'
import type { ApiBackend } from '../../domain/settings/settings-schema'
import { createApiEditorExecutor } from './api-editor-backend'

/**
 * "Test connection" for one configured API backend: ONE cheap real request,
 * through the exact path a review takes.
 *
 * Reusing `createApiEditorExecutor` is the whole point. A hand-rolled ping
 * (a models-list GET, a bare chat completion) would answer a question nobody
 * asked: it would go green for an endpoint that authenticates fine and then
 * fails every review because the model cannot produce the structured output
 * the operation contract requires. This sends a real `review` operation over a
 * one-sentence document, so a pass means "reviews will work here", and the
 * one failure mode in between — reachable endpoint, unusable answer — gets its
 * own status instead of being reported as a connection problem.
 */

/**
 * - `ok` — the endpoint answered with a valid operation result.
 * - `unusable` — it answered, but not in a shape the plugin can use (the model
 *   ignored the schema / tool call). Connection and credentials are fine; the
 *   model or the endpoint's structured-output support is not.
 * - `failed` — the request did not complete (credentials, network, timeout,
 *   configuration).
 */
export type BackendHealthStatus = 'ok' | 'unusable' | 'failed'

export interface BackendHealthResult {
    readonly status: BackendHealthStatus
    /** Operation error code behind a non-ok result ('' when ok). */
    readonly code: string
    /** One sentence the settings UI shows verbatim. Never contains the key. */
    readonly message: string
}

/**
 * Deliberately NOT `behavior.requestTimeoutSeconds` (10 minutes by default): a
 * connection test that can hang for ten minutes is not a test. One minute is
 * long enough for Ollama to load a cold model and short enough to stay a
 * check; the timeout message says a real run may still succeed with a higher
 * request timeout, so a slow local model is never mistaken for a broken one.
 */
export const HEALTH_CHECK_TIMEOUT_MS = 60_000

/**
 * The probe document. One short sentence with nothing to criticize: the point
 * is a well-formed answer, and the cheapest well-formed answer is an empty
 * findings list.
 */
const PROBE_TEXT = 'The quick brown fox jumps over the lazy dog.'

const PROBE_SYSTEM_PROMPT =
    'You are performing a connection test. Do not review the text. ' +
    'Return a result with an empty list of findings and no summary.'

export interface CheckBackendHealthInput {
    readonly backend: ApiBackend
    /** Model to test — the backend default, or an override being configured. */
    readonly model: string
    /** Injectable transport (tests); defaults to the renderer's fetch. */
    readonly fetchImpl?: typeof fetch
    readonly timeoutMs?: number
}

/**
 * Maps the executor's single terminal event to a health result.
 *
 * Pure, so every branch is spec-pinnable without a server. The executor
 * guarantees exactly one terminal event and never throws, so a missing
 * terminal event means the iterable ended without one — reported as a failure
 * rather than silently treated as success.
 */
export function classifyHealthEvent(event: OperationEvent | null): BackendHealthResult {
    if (event === null) {
        return {
            status: 'failed',
            code: 'unknown',
            message: 'The backend produced no response.'
        }
    }
    if (event.type === 'result') {
        return { status: 'ok', code: '', message: 'Connection works.' }
    }
    if (event.type !== 'error') {
        return {
            status: 'failed',
            code: 'unknown',
            message: 'The backend produced no response.'
        }
    }
    const { code, message } = event.error
    if (code === 'invalid-output') {
        return {
            status: 'unusable',
            code,
            message:
                'The endpoint answered, but not in a usable shape — the model ignored the ' +
                `requested structure. Try a stronger model. (${message})`
        }
    }
    if (code === 'timeout') {
        return {
            status: 'failed',
            code,
            message:
                `No answer within ${HEALTH_CHECK_TIMEOUT_MS / 1_000} s. A slow local model may ` +
                'still work for real runs — raise ‘Request timeout’ in the Behavior tab and try a review.'
        }
    }
    return { status: 'failed', code, message }
}

/**
 * Runs the probe. Never throws and never reports a key: error messages come
 * from the executor, which builds them from status codes rather than response
 * bodies (Business Rules #12).
 */
export async function checkBackendHealth(
    input: CheckBackendHealthInput
): Promise<BackendHealthResult> {
    const execute = createApiEditorExecutor({
        backendConfig: input.backend,
        model: input.model,
        systemPrompt: PROBE_SYSTEM_PROMPT,
        timeoutMs: input.timeoutMs ?? HEALTH_CHECK_TIMEOUT_MS,
        ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {})
    })
    const controller = new AbortController()
    let terminal: OperationEvent | null = null
    for await (const event of execute(
        {
            contractVersion: CONTRACT_VERSION,
            runId: generateId(),
            snapshotHash: hashText(PROBE_TEXT),
            kind: 'review',
            text: PROBE_TEXT
        },
        controller.signal
    )) {
        if (event.type === 'result' || event.type === 'error') {
            terminal = event
        }
    }
    return classifyHealthEvent(terminal)
}
