import { buildUserMessage } from './prompt'
import {
    extractJsonPayload,
    guardTruncation,
    validateOperationResult,
    type ValidatedOperationResult
} from './result'
import {
    ProviderError,
    redactSecret,
    type BuildRequestInput,
    type HttpRequestDescriptor,
    type ProviderAdapter,
    type ProviderCapabilities
} from './types'

/**
 * Ollama adapter (`POST {baseUrl}/api/chat`). Local-first: no auth header,
 * default loopback base URL. `format: 'json'` constrains decoding to valid
 * JSON but cannot enforce a schema — the schema travels in the prompt and
 * Zod validation is the real gate.
 */

const DEFAULT_BASE_URL = 'http://127.0.0.1:11434'

function trimTrailingSlash(url: string): string {
    return url.endsWith('/') ? url.slice(0, -1) : url
}

export const ollamaAdapter: ProviderAdapter = {
    buildRequest(input: BuildRequestInput): HttpRequestDescriptor {
        const { operation, systemPrompt, model, config } = input
        if (model.length === 0) {
            throw new ProviderError(
                'invalid-config',
                redactSecret(
                    `Ollama backend "${config.label}" has no model configured`,
                    config.apiKey
                )
            )
        }
        const baseUrl = trimTrailingSlash(
            config.baseUrl.length > 0 ? config.baseUrl : DEFAULT_BASE_URL
        )
        return {
            url: `${baseUrl}/api/chat`,
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                model,
                messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: buildUserMessage(operation, 'json-object') }
                ],
                format: 'json',
                stream: false,
                // Off by default: thinking-family models (qwen3, deepseek-r1)
                // otherwise burn the whole budget on reasoning before emitting
                // the JSON payload. When on, the answer arrives in
                // `message.content` and the reasoning in `message.thinking` —
                // the parser reads only `content`, so thinking never leaks
                // into the operation result. Any non-'off' mode counts as on
                // ('budget' is an Anthropic-only distinction).
                think: config.thinking !== 'off'
            })
        }
    },

    parseBufferedResponse(raw: unknown): ValidatedOperationResult {
        if (typeof raw !== 'object' || raw === null) {
            throw new ProviderError('invalid-output', 'Ollama response is not an object')
        }
        const message = (raw as Record<string, unknown>)['message']
        if (typeof message !== 'object' || message === null) {
            throw new ProviderError('invalid-output', 'Ollama response has no message')
        }
        // `done_reason: 'length'` = the answer hit the output cap (issue
        // #18): a payload that then fails to parse is 'truncated', not
        // "invalid JSON".
        const truncated = (raw as Record<string, unknown>)['done_reason'] === 'length'
        const content = (message as Record<string, unknown>)['content']
        if (typeof content !== 'string' || content.length === 0) {
            return guardTruncation(truncated, () => {
                throw new ProviderError('invalid-output', 'Ollama response has no text content')
            })
        }
        return guardTruncation(truncated, () =>
            validateOperationResult(extractJsonPayload(content))
        )
    },

    capabilities(): ProviderCapabilities {
        // Ollama streams NDJSON, not SSE — buffered until a dedicated decoder lands.
        return { streaming: false, jsonSchema: false, reportsUsage: true }
    }
}
