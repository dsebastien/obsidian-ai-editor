import type { OperationEvent } from '../../domain/operations/contract'
import { CONTRACT_VERSION } from '../../domain/operations/contract'
import { generateId } from '../../domain/ids'
import { hashText } from '../../domain/snapshot'
import { DEFAULT_PLUGIN_SETTINGS } from '../../domain/settings/settings-schema'
import type { BackendInstance } from '../../domain/settings/settings-schema'
import { createBackendExecutor } from './backend-executor'
import { backendHealth } from './backend-health'
import { resolveFetchImpl } from './resolve-fetch'
import type { FetchFn } from './resolve-fetch'

/**
 * "Test connection" for one configured backend, API or CLI: ONE cheap real
 * request, through the exact path a review takes.
 *
 * Going through `createBackendExecutor` is the whole point. A hand-rolled
 * ping — a models-list GET, or for a CLI tool a `--version` call — would
 * answer a question nobody asked: it would go green for an endpoint that
 * authenticates fine, or a binary that exists, and then fail every review
 * because the model cannot produce the structured output the operation
 * contract requires. This sends a real `review` operation over a one-sentence
 * document, so a pass means "reviews will work here", and the one failure mode
 * in between — reachable backend, unusable answer — gets its own status
 * instead of being reported as a connection problem.
 *
 * For a CLI backend that means the probe really does start the tool, in the
 * throwaway working directory, with the allowlisted environment, under the
 * boundary's timeout and process-tree kill. A health check that took a shorter
 * path than the real run would be worse than no health check: it would certify
 * a configuration nobody has actually exercised.
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
 * The CLI probe gets longer, because an agent CLI does more before it answers:
 * it starts a runtime, reads its own configuration, authenticates and only
 * then makes a request. Still bounded, and still clamped down to the backend's
 * own timeout when the user configured a shorter one — a probe that outlives
 * the setting it is testing would certify a configuration that cannot run.
 */
export const CLI_HEALTH_CHECK_TIMEOUT_MS = 120_000

/** The probe's timeout for one backend, in ms. */
export function healthCheckTimeoutMs(backend: BackendInstance): number {
    return backend.family === 'cli'
        ? Math.min(CLI_HEALTH_CHECK_TIMEOUT_MS, backend.timeoutSeconds * 1_000)
        : HEALTH_CHECK_TIMEOUT_MS
}

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
    readonly backend: BackendInstance
    /**
     * Model to test — the backend default, or an override being configured.
     * Empty is legal for CLI backends and means the tool's own default.
     */
    readonly model: string
    /** Injectable transport (tests); defaults to the renderer's fetch. */
    readonly fetchImpl?: FetchFn
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
export function classifyHealthEvent(
    event: OperationEvent | null,
    family: BackendInstance['family'],
    /**
     * The bound that was actually applied, in ms. Passed in rather than read
     * off the constant: a CLI backend's probe is clamped down to its own
     * `Timeout` setting, so quoting the ceiling at a user who configured 60 s
     * would report their setting working as if it were the plugin hanging.
     */
    timeoutMs: number
): BackendHealthResult {
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
                family === 'cli'
                    ? 'The tool ran and answered, but not with the structured result the plugin ' +
                      `needs — an agent that wraps its answer in prose looks like this. Try a stronger model. (${message})`
                    : 'The endpoint answered, but not in a usable shape — the model ignored the ' +
                      `requested structure. Try a stronger model. (${message})`
        }
    }
    if (code === 'timeout') {
        // Name the setting that applies to THIS family: a CLI backend carries
        // its own timeout and the Behavior tab's request timeout does nothing
        // for it, so pointing there would send the user to the wrong control.
        const seconds = Math.round(timeoutMs / 1_000)
        return {
            status: 'failed',
            code,
            message:
                family === 'cli'
                    ? `No answer within ${String(seconds)} s. An agent that ` +
                      'goes exploring can be slower — raise ‘Timeout’ for this backend and try a review.'
                    : `No answer within ${String(seconds)} s. A slow local model may ` +
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
    const timeoutMs = input.timeoutMs ?? healthCheckTimeoutMs(input.backend)
    const { execute } = createBackendExecutor({
        backend: input.backend,
        model: input.model,
        systemPrompt: PROBE_SYSTEM_PROMPT,
        // The probe is about the backend, not about the vault's behavior
        // settings, so the only thing it borrows from them is nothing: it
        // supplies its own bounded timeout and defaults for the rest.
        behavior: DEFAULT_PLUGIN_SETTINGS.behavior,
        timeoutMsOverride: timeoutMs,
        // A check reports what ONE attempt does — the automatic-retry layer
        // (issue #23) would turn "fails two times out of three" into a pass.
        autoRetry: false,
        fetchImpl: resolveFetchImpl(input.fetchImpl)
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
    const result = classifyHealthEvent(terminal, input.backend.family, timeoutMs)
    if (result.status === 'ok') {
        // "Test connection" is the explicit try-again gesture (issue #23):
        // a passing probe closes the backend's circuit breaker.
        backendHealth.recordSuccess(input.backend.id)
    }
    return result
}
