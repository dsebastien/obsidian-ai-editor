import type { OperationEvent, OperationRequest } from '../../domain/operations/contract'
import type { BackendInstance, BehaviorSettings } from '../../domain/settings/settings-schema'
import { createApiEditorExecutor } from './api-editor-backend'
import { cliTimeoutMs, createCliEditorExecutor } from './cli'
import { redactSecret } from './providers'

/**
 * The one place a resolved backend becomes something the orchestrator can
 * run — for BOTH families.
 *
 * This module exists so that "CLI backends work everywhere API backends work"
 * is a structural fact rather than a claim. Every dispatch path in the plugin
 * (reviews, panel aggregation, transforms, threads, health checks) asks for an
 * executor here and gets one back; none of them branches on `family`, so a
 * surface cannot accidentally support one family and not the other, and a
 * future family cannot be half-wired. The three things that legitimately
 * differ between families are decided here, once:
 *
 * - **Which executor.** `createApiEditorExecutor` and `createCliEditorExecutor`
 *   have deliberately identical signatures and the same exactly-one-terminal-
 *   event protocol, so the caller genuinely cannot tell them apart.
 * - **The timeout.** An API request is bounded by the behavior-level request
 *   timeout; a CLI agent is an order of magnitude slower than a chat
 *   completion and carries its own per-backend budget instead of borrowing it.
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

/** Builds the executor + redaction pair for one resolved backend. */
export function createBackendExecutor(input: CreateBackendExecutorInput): ResolvedBackendExecutor {
    const { backend, model, systemPrompt, behavior } = input
    const timeoutMs = input.timeoutMsOverride ?? backendTimeoutMs(backend, behavior)
    if (backend.family === 'cli') {
        return {
            // A CLI backend holds no credential of ours: the tool authenticates
            // itself out of the user's own login. There is nothing to redact,
            // and pretending otherwise would suggest a protection that is not
            // there.
            redactError: (message: string): string => message,
            execute: createCliEditorExecutor({
                backendConfig: backend,
                model,
                systemPrompt,
                timeoutMs
            })
        }
    }
    return {
        redactError: (message: string): string => redactSecret(message, backend.apiKey),
        execute: createApiEditorExecutor({
            backendConfig: backend,
            model,
            systemPrompt,
            timeoutMs,
            fetchImpl: input.fetchImpl
        })
    }
}
