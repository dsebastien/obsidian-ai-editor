import type { OperationResult } from '../../../domain/operations/contract'
import type { ApiBackend } from '../../../domain/settings/settings-schema'
import { buildUserMessage, resultJsonSchema } from './prompt'
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
 * OpenAI Chat Completions adapter. Also serves two sibling kinds over the
 * same wire format:
 * - 'openrouter': dedicated profile — base URL preset to
 *   `https://openrouter.ai/api/v1`, attribution headers sent (OpenRouter's
 *   recommended `HTTP-Referer`/`X-Title`), and `reasoningEffort` forwarded
 *   as its unified `reasoning: { effort }` parameter.
 * - 'openai-compatible': generic (Groq, LM Studio…) via the instance's
 *   `baseUrl` override — the base URL replaces the default wholesale, so
 *   compatible bases that include their own path prefix work unchanged.
 *
 * Structured output: native OpenAI gets `response_format: json_schema`
 * (server-enforced); OpenRouter and compatible servers get the
 * broadly-supported `json_object` mode — the schema still rides in the
 * prompt and Zod validation remains the enforcement boundary either way.
 */

const DEFAULT_BASE_URL = 'https://api.openai.com/v1'
const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1'

function trimTrailingSlash(url: string): string {
    return url.endsWith('/') ? url.slice(0, -1) : url
}

/**
 * Extracts `choices[0].message.content` from a Chat Completions envelope.
 * Shared with the Azure OpenAI adapter, whose responses use the same shape.
 */
export function chatCompletionContent(raw: unknown, providerName: string): string {
    if (typeof raw !== 'object' || raw === null) {
        throw new ProviderError('invalid-output', `${providerName} response is not an object`)
    }
    const choices = (raw as Record<string, unknown>)['choices']
    if (!Array.isArray(choices) || choices.length === 0) {
        throw new ProviderError('invalid-output', `${providerName} response has no choices`)
    }
    const first: unknown = choices[0]
    const message: unknown =
        typeof first === 'object' && first !== null
            ? (first as Record<string, unknown>)['message']
            : undefined
    if (typeof message !== 'object' || message === null) {
        throw new ProviderError('invalid-output', `${providerName} response has no message`)
    }
    const record = message as Record<string, unknown>
    const refusal = record['refusal']
    if (typeof refusal === 'string' && refusal.length > 0) {
        throw new ProviderError('invalid-output', `${providerName} model refused the request`)
    }
    const content = record['content']
    if (typeof content !== 'string' || content.length === 0) {
        throw new ProviderError('invalid-output', `${providerName} response has no text content`)
    }
    return content
}

/**
 * Parses the advanced `extraBodyJson` setting into a plain object. The
 * backend modal validates at save time; this re-validation covers hand-
 * edited data.json. Throws `invalid-config` (key-redacted) on anything
 * that is not a JSON object.
 */
function parseExtraBody(config: ApiBackend): Record<string, unknown> {
    let parsed: unknown
    try {
        parsed = JSON.parse(config.extraBodyJson) as unknown
    } catch {
        throw new ProviderError(
            'invalid-config',
            redactSecret(
                `Backend "${config.label}" has invalid JSON in 'Extra request body'`,
                config.apiKey
            )
        )
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        throw new ProviderError(
            'invalid-config',
            redactSecret(
                `Backend "${config.label}": 'Extra request body' must be a JSON object`,
                config.apiKey
            )
        )
    }
    return parsed as Record<string, unknown>
}

export const openAiAdapter: ProviderAdapter = {
    buildRequest(input: BuildRequestInput): HttpRequestDescriptor {
        const { operation, systemPrompt, model, config } = input
        if (
            (config.kind === 'openai' || config.kind === 'openrouter') &&
            config.apiKey.length === 0
        ) {
            const providerName = config.kind === 'openai' ? 'OpenAI' : 'OpenRouter'
            throw new ProviderError(
                'invalid-config',
                redactSecret(
                    `${providerName} backend "${config.label}" has no API key`,
                    config.apiKey
                )
            )
        }
        if (config.kind === 'openai-compatible' && config.baseUrl.length === 0) {
            throw new ProviderError(
                'invalid-config',
                redactSecret(
                    `OpenAI-compatible backend "${config.label}" has no base URL`,
                    config.apiKey
                )
            )
        }
        if (model.length === 0) {
            throw new ProviderError(
                'invalid-config',
                redactSecret(`Backend "${config.label}" has no model configured`, config.apiKey)
            )
        }
        const defaultBaseUrl = config.kind === 'openrouter' ? OPENROUTER_BASE_URL : DEFAULT_BASE_URL
        const baseUrl = trimTrailingSlash(
            config.baseUrl.length > 0 ? config.baseUrl : defaultBaseUrl
        )
        const headers: Record<string, string> = { 'content-type': 'application/json' }
        if (config.apiKey.length > 0) {
            // Local compatible servers (LM Studio, llama.cpp) run keyless.
            headers['authorization'] = `Bearer ${config.apiKey}`
        }
        if (config.kind === 'openrouter') {
            // OpenRouter's recommended attribution headers (per-app
            // analytics). Static values only — nothing user-derived.
            headers['http-referer'] = 'https://github.com/dsebastien/obsidian-ai-editor'
            headers['x-title'] = 'Editor AI Daemons (Obsidian)'
        }
        const responseFormat =
            config.kind === 'openai'
                ? {
                      type: 'json_schema',
                      json_schema: {
                          name: 'operation_result',
                          schema: resultJsonSchema(operation.kind)
                      }
                  }
                : { type: 'json_object' }
        let body: Record<string, unknown> = {
            model,
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: buildUserMessage(operation, 'json-object') }
            ],
            response_format: responseFormat,
            stream: false
        }
        // Native OpenAI only: reasoning_effort passthrough. 'default' sends
        // nothing so non-reasoning models never see an unknown parameter.
        if (config.kind === 'openai' && config.reasoningEffort !== 'default') {
            body['reasoning_effort'] = config.reasoningEffort
        }
        // OpenRouter: unified reasoning parameter (applies across routed
        // models; ignored by models without reasoning support).
        if (config.kind === 'openrouter' && config.reasoningEffort !== 'default') {
            body['reasoning'] = { effort: config.reasoningEffort }
        }
        // OpenRouter + compatible endpoints: thinking/provider-routing flags
        // vary per host, so the advanced raw-JSON escape hatch merges into
        // the body (extras win on key collisions — that is the point of an
        // override).
        if (
            (config.kind === 'openrouter' || config.kind === 'openai-compatible') &&
            config.extraBodyJson.trim().length > 0
        ) {
            body = { ...body, ...parseExtraBody(config) }
        }
        return {
            url: `${baseUrl}/chat/completions`,
            method: 'POST',
            headers,
            body: JSON.stringify(body)
        }
    },

    parseBufferedResponse(raw: unknown): OperationResult {
        return validateOperationResult(extractJsonPayload(chatCompletionContent(raw, 'OpenAI')))
    },

    capabilities(): ProviderCapabilities {
        return { streaming: true, jsonSchema: true, reportsUsage: true }
    }
}
