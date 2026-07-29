import type { OperationResult } from '../../../domain/operations/contract'
import { buildUserMessage } from './prompt'
import { extractJsonPayload, validateOperationResult } from './result'
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
                // Thinking-family models (qwen3, deepseek-r1) otherwise burn the
                // whole budget on reasoning before emitting the JSON payload.
                think: false
            })
        }
    },

    parseBufferedResponse(raw: unknown): OperationResult {
        if (typeof raw !== 'object' || raw === null) {
            throw new ProviderError('invalid-output', 'Ollama response is not an object')
        }
        const message = (raw as Record<string, unknown>)['message']
        if (typeof message !== 'object' || message === null) {
            throw new ProviderError('invalid-output', 'Ollama response has no message')
        }
        const content = (message as Record<string, unknown>)['content']
        if (typeof content !== 'string' || content.length === 0) {
            throw new ProviderError('invalid-output', 'Ollama response has no text content')
        }
        return validateOperationResult(extractJsonPayload(content))
    },

    capabilities(): ProviderCapabilities {
        // Ollama streams NDJSON, not SSE — buffered until a dedicated decoder lands.
        return { streaming: false, jsonSchema: false, reportsUsage: true }
    }
}
