import type { OperationRequest, OperationResult } from '../../../domain/operations/contract'
import type { ApiBackend } from '../../../domain/settings/settings-schema'

/**
 * Provider adapter contract: pure request builders and response parsers.
 *
 * This layer performs NO network I/O. An adapter turns an operation into an
 * `HttpRequestDescriptor` that a transport executes later, and turns the
 * provider's buffered response body back into a validated `OperationResult`.
 * Keeping adapters pure makes every provider quirk unit-testable without a
 * server and keeps the transport (fetch vs `requestUrl`) swappable.
 */

/** A fully-specified HTTP request, ready for any transport to execute. */
export interface HttpRequestDescriptor {
    readonly url: string
    readonly method: 'GET' | 'POST'
    readonly headers: Record<string, string>
    /** JSON-serialized request payload. */
    readonly body: string
}

/**
 * What a provider profile supports. Buffered structured output is the
 * baseline for every provider; anything here is a progressive enhancement
 * the orchestrator may use when available (see Architecture — Backends).
 */
export interface ProviderCapabilities {
    /** SSE streaming has been verified for this provider profile. */
    readonly streaming: boolean
    /** The provider enforces a JSON schema server-side (tool/response_format). */
    readonly jsonSchema: boolean
    /** Responses include token usage figures. */
    readonly reportsUsage: boolean
}

/** Everything an adapter needs to build one operation request. */
export interface BuildRequestInput {
    readonly operation: OperationRequest
    /** Assembled persona system prompt (voice profile + persona + context). */
    readonly systemPrompt: string
    /** Resolved model id (backend default or per-editor override). */
    readonly model: string
    readonly config: ApiBackend
}

/**
 * One provider profile (Anthropic, OpenAI/-compatible, Azure OpenAI, Ollama).
 *
 * Implementations must be stateless: the same input always yields the same
 * descriptor, and `parseBufferedResponse` depends only on `raw`.
 */
export interface ProviderAdapter {
    /**
     * Builds the HTTP request for an operation. Throws `ProviderError` with
     * code 'invalid-config' when the backend configuration cannot produce a
     * valid request (missing base URL, deployment, key…).
     */
    buildRequest(input: BuildRequestInput): HttpRequestDescriptor
    /**
     * Parses a buffered provider response body (already JSON-decoded by the
     * transport) into a validated `OperationResult`. Throws `ProviderError`
     * with code 'invalid-output' when the payload does not match the
     * operation contract.
     */
    parseBufferedResponse(raw: unknown): OperationResult
    capabilities(): ProviderCapabilities
}

export type ProviderErrorCode = 'invalid-config' | 'invalid-output'

/**
 * Typed failure raised by adapters. Messages must never contain secrets:
 * construction sites route anything derived from configuration through
 * `redactSecret` (Business Rules #12 — keys are redacted from errors).
 */
export class ProviderError extends Error {
    readonly code: ProviderErrorCode

    constructor(code: ProviderErrorCode, message: string) {
        super(message)
        this.name = 'ProviderError'
        this.code = code
    }
}

/**
 * Removes every occurrence of a secret from a message. Defense in depth:
 * adapters never interpolate keys on purpose, but provider payloads or URLs
 * echoed into errors could carry them.
 */
export function redactSecret(message: string, secret: string): string {
    if (secret.length === 0) {
        return message
    }
    return message.split(secret).join('[redacted]')
}
