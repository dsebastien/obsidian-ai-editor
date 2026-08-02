import type { OperationEvent, OperationRequest } from '../../domain/operations/contract'
import { stripFrontmatterBlock } from '../../domain/frontmatter'
import { hasLaunchConsent } from '../../domain/settings/cli-consent'
import type {
    BackendInstance,
    BehaviorSettings,
    CliBackend
} from '../../domain/settings/settings-schema'
import { createApiEditorExecutor } from './api-editor-backend'
import { backendHealth, type BackendHealthRegistry } from './backend-health'
import { cliTimeoutMs, createCliEditorExecutor, getCliToolAdapter } from './cli'
import { redactSecret } from './providers'
import { decideRetry } from './retry-policy'

/**
 * The one place a resolved backend becomes something the orchestrator can
 * run — for BOTH families.
 *
 * This module exists so that "CLI backends work everywhere API backends work"
 * is a structural fact rather than a claim. Every dispatch path in the plugin
 * (reviews, panel aggregation, transforms, threads, health checks) asks for an
 * executor here and gets one back; none of them branches on `family`, so a
 * surface cannot accidentally support one family and not the other, and a
 * future family cannot be half-wired. Being the one seam every request crosses
 * is also why the payload privacy policy lives here (`applyFrontmatterPolicy`):
 * a guarantee about what leaves the vault must not depend on each dispatch
 * path remembering it.
 *
 * The four things that legitimately differ between families are decided here,
 * once:
 *
 * - **Which executor.** `createApiEditorExecutor` and `createCliEditorExecutor`
 *   have deliberately identical signatures and the same exactly-one-terminal-
 *   event protocol, so the caller genuinely cannot tell them apart.
 * - **The timeout.** An API request is bounded by the behavior-level request
 *   timeout; a CLI agent is an order of magnitude slower than a chat
 *   completion and carries its own per-backend budget instead of borrowing it.
 * - **Consent.** A CLI backend that the user has not allowed to launch THIS
 *   executable never becomes runnable here. `resolveBackendRef` refuses one
 *   too, but that is the review path; putting the same refusal at the seam
 *   where a backend turns into a process means a second caller — the health
 *   probe, the setup wizard, whatever comes next — cannot start a user's
 *   binary by forgetting to ask. Consent is the premise of this whole
 *   subsystem, so it is enforced where the process is created, not where it is
 *   requested.
 * - **Redaction.** An API backend's error messages are scrubbed of its key
 *   (Business Rules #12). A CLI backend has no key to scrub — its credential
 *   lives in the tool's own login, which the plugin never reads — so its
 *   redaction is identity, and the executor's status-only messages are what
 *   keep the tool's output out of user-visible strings.
 */

/** The signature both families' executors satisfy. */
export type BackendExecutor = (
    request: OperationRequest,
    signal: AbortSignal
) => AsyncIterable<OperationEvent>

/** Everything a run needs from a resolved backend. */
export interface ResolvedBackendExecutor {
    readonly execute: BackendExecutor
    /**
     * Applied to every user-visible error string coming out of the run.
     * Defense in depth on top of the executors' status-only messages.
     */
    readonly redactError: (message: string) => string
}

export interface CreateBackendExecutorInput {
    readonly backend: BackendInstance
    /** Resolved model. Empty is legal for CLI (defer to the tool's default). */
    readonly model: string
    /** Fully assembled system prompt (voice profile + persona + context). */
    readonly systemPrompt: string
    readonly behavior: BehaviorSettings
    /** Transport for API backends; ignored by CLI backends. */
    readonly fetchImpl: typeof fetch
    /**
     * Replaces the family's normal timeout. The one legitimate caller is the
     * health probe, which must stay a check rather than inheriting a ten-minute
     * request budget; everything that runs a real operation leaves this unset
     * so the user's configured timeout is what applies.
     */
    readonly timeoutMsOverride?: number
    /**
     * Disables the automatic-retry layer (issue #23). The one legitimate
     * caller is again the health probe: a check must report what ONE attempt
     * does, not what three attempts eventually manage.
     */
    readonly autoRetry?: boolean
    /** Injectable health registry + timing for specs. */
    readonly retryDeps?: Partial<AutoRetryDeps>
}

/**
 * Converts the behavior-level request timeout (seconds, user-facing) to the
 * milliseconds the transport consumes. One editor's whole API operation
 * (connect + full stream) is bounded by this — the setting exists precisely
 * because slow local models (Ollama on a laptop) stream for many minutes.
 */
export function reviewTimeoutMs(behavior: BehaviorSettings): number {
    return behavior.requestTimeoutSeconds * 1_000
}

/**
 * How long this backend gets, in ms.
 *
 * CLI backends carry their own budget rather than sharing the API one: an
 * agent that plans, reads and re-reads before answering is slower than a chat
 * completion by an order of magnitude, and forcing the two to share a number
 * would mean either cutting agents off mid-run or letting a hung HTTP request
 * sit for the length an agent needs.
 */
export function backendTimeoutMs(backend: BackendInstance, behavior: BehaviorSettings): number {
    return backend.family === 'cli' ? cliTimeoutMs(backend) : reviewTimeoutMs(behavior)
}

/**
 * How a resolved backend is named in the UI.
 *
 * A CLI backend legitimately resolves to no model — the tool picks its own —
 * and rendering that as an empty pair of brackets would read as a bug. Saying
 * so is both shorter and more accurate.
 */
export function resolvedBackendLabel(backend: BackendInstance, model: string): string {
    return model.length > 0 ? `${backend.label} (${model})` : `${backend.label} (tool default)`
}

/**
 * Applies `behavior.stripFrontmatter` to the request payload.
 *
 * The seam is here, at the last point before a request becomes bytes on a wire
 * or on a pipe, because EVERY dispatch path in the plugin — review, panel
 * aggregation, transform, insert-at, thread, background comment, CLI, daemon,
 * health check — asks `createBackendExecutor` for its executor. Stripping at
 * each construction site would make the guarantee a habit; stripping here makes
 * it structural, and a future request kind that carries document text gets it
 * by adding one case below rather than by remembering.
 *
 * Three request kinds carry the document: `review`, `transform-selection` and
 * `insert-at`. All three also carry OFFSETS into that text, so removing a
 * prefix means shifting them by the same number — the strip only ever removes a
 * leading block, so a single subtraction is exact.
 *
 * When an offset points INSIDE the frontmatter, the request is left untouched
 * instead of being clamped: the user selected the frontmatter (or asked to
 * insert above it), so the frontmatter IS the target, and sending a clamped
 * empty span would silently transform the wrong thing. Nothing is sent that the
 * user did not point at.
 *
 * Findings are unaffected: anchoring matches quotes against the run's own
 * snapshot text (full, unstripped), so a quote from the body still resolves to
 * its real position in the document.
 */
export function applyFrontmatterPolicy(
    request: OperationRequest,
    behavior: BehaviorSettings
): OperationRequest {
    if (!behavior.stripFrontmatter) {
        return request
    }
    switch (request.kind) {
        case 'review':
        case 'transform-selection':
        case 'insert-at':
            break
        default:
            return request // carries no document text
    }
    const { text, removedChars } = stripFrontmatterBlock(request.text)
    if (removedChars === 0) {
        return request
    }
    if (request.kind === 'insert-at') {
        return request.position < removedChars
            ? request
            : { ...request, text, position: request.position - removedChars }
    }
    const selection = request.selection
    if (selection === undefined) {
        return { ...request, text }
    }
    if (selection.from < removedChars) {
        return request
    }
    return {
        ...request,
        text,
        selection: { from: selection.from - removedChars, to: selection.to - removedChars }
    }
}

/** Wraps an executor so every request passes the frontmatter policy. */
function withRequestPolicy(execute: BackendExecutor, behavior: BehaviorSettings): BackendExecutor {
    return (request, signal) => execute(applyFrontmatterPolicy(request, behavior), signal)
}

// ---------------------------------------------------------------------------
// Automatic retry (issue #23)
// ---------------------------------------------------------------------------

/** What `withAutoRetry` needs beyond the executor (injectable for specs). */
export interface AutoRetryDeps {
    readonly backendId: string
    readonly health: BackendHealthRegistry
    /** Resolves after `ms`, or immediately when the signal aborts. */
    readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>
    readonly random: () => number
}

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
        if (signal.aborted) {
            resolve()
            return
        }
        const onAbort = (): void => {
            clearTimeout(timer)
            resolve()
        }
        const timer = setTimeout(() => {
            signal.removeEventListener('abort', onAbort)
            resolve()
        }, ms)
        signal.addEventListener('abort', onAbort, { once: true })
    })
}

/**
 * Wraps an executor with the automatic-retry policy (issue #23): a failed
 * attempt whose error `decideRetry` deems transient is silently re-run —
 * bounded counts, backoff/Retry-After waits, abortable throughout — and only
 * the FINAL outcome reaches the orchestrator, so the run layer's
 * exactly-one-terminal-event protocol is preserved. Applied to BOTH families
 * at the one seam every request crosses.
 *
 * Feeds the circuit breaker: any success resets the backend's failure
 * streak; a final failure records it. While the backend reads unhealthy the
 * retry budget is NOT spent — the first failure surfaces immediately, and
 * the user's manual summon (which still always runs) is what probes recovery.
 *
 * `cancelled` never retries, never counts as a failure, and a cancellation
 * arriving during a retry wait ends the run as cancelled.
 */
function withAutoRetry(execute: BackendExecutor, deps: AutoRetryDeps): BackendExecutor {
    return async function* retried(request, signal) {
        for (let attempt = 1; ; attempt += 1) {
            let failure: Extract<OperationEvent, { type: 'error' }> | null = null
            for await (const event of execute(request, signal)) {
                if (failure !== null) {
                    continue // post-terminal noise: discard, never re-emit
                }
                if (event.type === 'error') {
                    failure = event
                    continue
                }
                yield event
            }
            if (failure === null) {
                deps.health.recordSuccess(deps.backendId)
                return
            }
            const code = failure.error.code
            if (code === 'cancelled' || signal.aborted) {
                yield failure // the user meant it — not a backend failure
                return
            }
            const decision = deps.health.isUnhealthy(deps.backendId)
                ? { retry: false, delayMs: 0 }
                : decideRetry(code, attempt, failure.error.retryAfterMs ?? null, deps.random)
            if (!decision.retry) {
                deps.health.recordFailure(deps.backendId, code)
                yield attempt === 1
                    ? failure
                    : {
                          ...failure,
                          error: {
                              ...failure.error,
                              message: `${failure.error.message} (after ${attempt} attempts)`
                          }
                      }
                return
            }
            if (decision.delayMs > 0) {
                await deps.sleep(decision.delayMs, signal)
            }
            if (signal.aborted) {
                yield {
                    type: 'error',
                    runId: request.runId,
                    error: { code: 'cancelled', message: 'Run cancelled' }
                }
                return
            }
        }
    }
}

/** Builds the executor + redaction pair for one resolved backend. */
export function createBackendExecutor(input: CreateBackendExecutorInput): ResolvedBackendExecutor {
    const { backend, model, systemPrompt, behavior } = input
    const timeoutMs = input.timeoutMsOverride ?? backendTimeoutMs(backend, behavior)
    const retryDeps: AutoRetryDeps = {
        backendId: input.retryDeps?.backendId ?? backend.id,
        health: input.retryDeps?.health ?? backendHealth,
        sleep: input.retryDeps?.sleep ?? abortableSleep,
        random: input.retryDeps?.random ?? Math.random
    }
    const finish = (execute: BackendExecutor): BackendExecutor =>
        input.autoRetry === false
            ? withRequestPolicy(execute, behavior)
            : withAutoRetry(withRequestPolicy(execute, behavior), retryDeps)
    if (backend.family === 'cli') {
        if (!hasLaunchConsent(backend)) {
            return {
                redactError: (message: string): string => message,
                // Never wrapped in retry: a consent refusal is not a backend
                // failure and must not feed the circuit breaker.
                execute: refuseUnconsentedCli(backend)
            }
        }
        return {
            // A CLI backend holds no credential of ours: the tool authenticates
            // itself out of the user's own login. There is nothing to redact,
            // and pretending otherwise would suggest a protection that is not
            // there.
            redactError: (message: string): string => message,
            execute: finish(
                createCliEditorExecutor({
                    backendConfig: backend,
                    model,
                    systemPrompt,
                    timeoutMs
                })
            )
        }
    }
    return {
        redactError: (message: string): string => redactSecret(message, backend.apiKey),
        execute: finish(
            createApiEditorExecutor({
                backendConfig: backend,
                model,
                systemPrompt,
                timeoutMs,
                fetchImpl: input.fetchImpl
            })
        )
    }
}

/**
 * The executor an unconsented CLI backend gets: one error event, no process.
 *
 * Shaped exactly like a real executor (same signature, exactly one terminal
 * event) so every caller — reviews, panels, transforms, the health probe —
 * reports it through the path it already has, instead of each one needing to
 * know about consent.
 */
function refuseUnconsentedCli(backend: CliBackend): BackendExecutor {
    const tool = getCliToolAdapter(backend.kind).displayName
    return async function* refuse(request: OperationRequest): AsyncGenerator<OperationEvent> {
        yield {
            type: 'error',
            runId: request.runId,
            error: {
                code: 'unknown',
                message:
                    `“${backend.label}” has not been allowed to run yet. Open the Backends tab ` +
                    `and allow it, so you can see which file ${tool} would start.`
            }
        }
    }
}
