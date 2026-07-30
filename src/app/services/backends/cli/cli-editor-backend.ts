import type {
    OperationEvent,
    OperationRequest,
    OperationResult
} from '../../../domain/operations/contract'
import type { BackendRef, CliBackend } from '../../../domain/settings/settings-schema'
import { ProviderError } from '../providers'
import { extractJsonPayload, validateOperationResult } from '../providers/result'
import { spawnCliProcess } from './spawn'
import type { CliProcessFailureCode, CliProcessOutcome, SpawnCliProcessInput } from './spawn'
import { getCliToolAdapter } from './tools'
import type { CliToolAdapter } from './tools'

/**
 * CLI backend executor: the glue between one configured CLI backend (tool
 * adapter + resolved model + assembled system prompt) and the
 * `RunController`'s injected `execute` function.
 *
 * The deliberate design constraint is that the orchestrator cannot tell this
 * apart from `createApiEditorExecutor`. Same signature, same
 * exactly-one-terminal-event protocol, same error vocabulary, and — the part
 * that matters most — the SAME result validation: `extractJsonPayload` +
 * `validateOperationResult`, the functions the provider adapters call. A
 * result that arrived over a pipe from a program on the user's machine is not
 * more trustworthy than one that arrived over HTTPS; it is arguably less so,
 * having passed through a general-purpose agent on the way. Nothing here
 * relaxes the contract to accommodate that.
 *
 * Guarantees, matching the API executor's:
 * - Every emitted event echoes `request.runId`.
 * - Exactly one terminal event per invocation. Nothing throws out of the
 *   returned iterable, including a programming error in this module.
 * - Cancellation and the timeout both terminate the run AND the process tree
 *   — the boundary owns that, and both arrive here as typed outcomes.
 * - Error messages are status-only. The tool's own error text is never
 *   forwarded: an agent CLI echoes its configuration when it fails, and its
 *   configuration holds its credentials (Business Rules #12).
 *
 * No `progress` events. The boundary hands over a bounded capture after the
 * process has ended, so there is genuinely nothing incremental to report, and
 * every adapter's `capabilities().streaming` says so. Inventing a heartbeat
 * here would make "the model is working" indistinguishable from "the pipe is
 * open", which is the exact confusion the slow-model work went out of its way
 * to remove.
 */

/**
 * Signature the `RunController` expects. Structurally identical to
 * `ApiEditorExecutor` by design — the orchestrator injects one of these and
 * must not be able to tell which family it got.
 */
export type CliEditorExecutor = (
    request: OperationRequest,
    signal: AbortSignal
) => AsyncIterable<OperationEvent>

/** The security boundary, injectable so specs need no binary installed. */
export type SpawnCliProcessFn = (input: SpawnCliProcessInput) => Promise<CliProcessOutcome>

export interface CreateCliEditorExecutorInput {
    readonly backendConfig: CliBackend
    /**
     * Resolved model id, or `''` to defer to the tool's own default. See
     * `resolveCliModel` for the precedence.
     */
    readonly model: string
    /** Fully assembled system prompt (voice profile + persona + context). */
    readonly systemPrompt: string
    /**
     * Upper bound for the whole operation, in ms. Sourced from the backend's
     * own `timeoutSeconds` via `cliTimeoutMs` — CLI agents are slower than a
     * chat completion by an order of magnitude, so they carry their own
     * budget rather than borrowing the API request timeout.
     */
    readonly timeoutMs: number
    /** Seam for specs; defaults to the real boundary. */
    readonly spawn?: SpawnCliProcessFn
}

type OperationErrorDetail = Extract<OperationEvent, { type: 'error' }>['error']

/**
 * Resolves the model a CLI backend runs on: per-editor override → backend
 * default → the tool's own default (`''`).
 *
 * Unlike `resolveBackendRef`'s API branch, an empty result is NOT a
 * configuration error. An API request body has to name a model, so a missing
 * one is a broken request; a CLI tool already ships a default that tracks its
 * vendor's current recommendation, and overriding that with a stale guess
 * from this plugin would age worse than deferring to it.
 */
export function resolveCliModel(ref: BackendRef | null, backend: CliBackend): string {
    const requested = ref?.model ?? ''
    return requested.length > 0 ? requested : backend.defaultModel
}

/** Converts the backend's user-facing timeout (seconds) to milliseconds. */
export function cliTimeoutMs(backend: CliBackend): number {
    return backend.timeoutSeconds * 1_000
}

/**
 * Maps a boundary failure onto the operation contract's error vocabulary.
 *
 * Everything the boundary reports is either a configuration problem or a
 * lifecycle event, and neither maps to `auth` or `rate-limit`: a process that
 * exits non-zero because the user is logged out looks exactly like one that
 * exits non-zero for any other reason, and guessing would put a wrong,
 * confident diagnosis in front of the user. Those two codes only ever come
 * from an envelope the tool itself filled in.
 */
function codeForFailure(code: CliProcessFailureCode): OperationErrorDetail['code'] {
    switch (code) {
        case 'cancelled':
            return 'cancelled'
        case 'timeout':
            return 'timeout'
        case 'stdout-overflow':
            // The output was real and unusable — the same class of problem as
            // a model that answered with prose.
            return 'invalid-output'
        case 'invalid-executable':
        case 'invalid-argument':
        case 'invalid-environment':
        case 'run-dir-failed':
        case 'spawn-failed':
        case 'nonzero-exit':
        case 'killed':
            return 'unknown'
    }
}

/**
 * Builds the user-visible message for a boundary failure.
 *
 * `outcome.message` is written by the boundary, not by the tool, so it is
 * safe by construction. Two things are added when they apply:
 *
 * - **The stderr summary**, which is status-only ("The tool wrote 412 bytes
 *   to its error stream") and never the content. It is the difference between
 *   "the tool exited with status 1" and "the tool exited with status 1 and
 *   had something to say", which is what tells a user whether to go look.
 * - **A surviving process tree.** `survived` is the one outcome the boundary
 *   could not make safe, so it is stated plainly rather than logged and
 *   forgotten.
 */
function messageForFailure(outcome: Extract<CliProcessOutcome, { ok: false }>): string {
    const parts = [outcome.message]
    if (outcome.code === 'timeout') {
        // Name the setting: a user hitting this (a long note, a thinking
        // model, an agent that went exploring) has to learn the fix from the
        // message, not from the docs. Same rule as the API executor's.
        parts.push("Raise 'Timeout' for this backend in settings if it needs longer.")
    }
    if (outcome.stderr.bytesSeen > 0) {
        parts.push(outcome.stderr.summary)
    }
    if (outcome.kill === 'survived') {
        parts.push('Some of its processes could not be stopped and may still be running.')
    }
    return parts.join(' ')
}

/**
 * Validates the tool's final message against the operation contract.
 *
 * Exactly the API path: tolerate a whole-string markdown fence, then Zod.
 * `ProviderError` is reused rather than re-declared so that a caller
 * inspecting the failure sees one error type across both families.
 */
function toOperationResult(text: string): OperationResult {
    return validateOperationResult(extractJsonPayload(text))
}

/**
 * Builds the `execute` function the `RunController` injects per editor.
 * Reusable across runs (it closes over configuration, not run state) and
 * never throws — every failure surfaces as exactly one `error` event.
 */
export function createCliEditorExecutor(input: CreateCliEditorExecutorInput): CliEditorExecutor {
    const { backendConfig, model, systemPrompt, timeoutMs } = input
    const spawn: SpawnCliProcessFn = input.spawn ?? spawnCliProcess
    const adapter: CliToolAdapter = getCliToolAdapter(backendConfig.kind)

    return async function* execute(
        request: OperationRequest,
        signal: AbortSignal
    ): AsyncGenerator<OperationEvent> {
        const runId = request.runId
        try {
            if (signal.aborted) {
                // Aborted before start: never start a process.
                yield { type: 'error', runId, error: cancelled() }
                return
            }
            const invocation = adapter.buildInvocation({
                operation: request,
                systemPrompt,
                model,
                config: backendConfig
            })
            const outcome = await spawn({
                executablePath: backendConfig.executablePath,
                args: invocation.args,
                stdin: invocation.stdin,
                timeoutMs,
                signal
            })
            if (!outcome.ok) {
                // A user cancellation always reads as cancelled, whatever the
                // boundary raced with on the way out.
                yield {
                    type: 'error',
                    runId,
                    error: signal.aborted
                        ? cancelled()
                        : {
                              code: codeForFailure(outcome.code),
                              message: messageForFailure(outcome)
                          }
                }
                return
            }
            const envelope = adapter.parseEnvelope(outcome.stdout)
            if (!envelope.ok) {
                yield {
                    type: 'error',
                    runId,
                    // The envelope's code vocabulary is a subset of the
                    // contract's, so this assignment is the type-level proof
                    // that a tool failure and a provider failure are told
                    // apart the same way downstream.
                    error: { code: envelope.code, message: envelope.message }
                }
                return
            }
            yield { type: 'result', runId, result: toOperationResult(envelope.text) }
        } catch (cause) {
            yield { type: 'error', runId, error: normalizeCliError(cause, adapter.displayName) }
        }
    }
}

function cancelled(): OperationErrorDetail {
    return { code: 'cancelled', message: 'Run cancelled' }
}

/**
 * Last-resort classification.
 *
 * The expected arrival here is a `ProviderError` from the shared validators —
 * the tool answered, but not with the contract. Everything else is a bug in
 * this module or in the boundary, and it is reported as such rather than
 * being allowed to escape the iterable and strand the run without a terminal
 * event. A raw `Error.message` is not echoed: on this path it can carry
 * whatever the tool produced.
 */
function normalizeCliError(cause: unknown, toolName: string): OperationErrorDetail {
    if (cause instanceof ProviderError) {
        return {
            code: cause.code === 'invalid-output' ? 'invalid-output' : 'unknown',
            message: cause.message
        }
    }
    return {
        code: 'unknown',
        message: `The ${toolName} run failed unexpectedly.`
    }
}
