import type { OperationResult } from '../../../domain/operations/contract'
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
 * Anthropic Messages API adapter.
 *
 * Structured output is enforced with forced tool use: a single tool whose
 * `input_schema` is the operation's result schema, selected via
 * `tool_choice` — the model cannot answer except by producing a
 * schema-conforming tool input. The CORS opt-in header enables direct
 * renderer `fetch` from Obsidian (no backend proxy).
 *
 * Extended thinking (config.thinking === 'on'): the request carries
 * `thinking: { type: 'enabled', budget_tokens }` and, because the API
 * rejects forced tool use while thinking is enabled, `tool_choice` relaxes
 * to `auto` — the prompt still demands the tool call, and the parser's
 * text-block JSON fallback covers a model that answers in prose. The
 * thinking budget is added ON TOP of the output budget so the API
 * constraint `budget_tokens < max_tokens` holds by construction. Response
 * `thinking`/`redacted_thinking` blocks are skipped by the parser.
 */

const DEFAULT_BASE_URL = 'https://api.anthropic.com'
const ANTHROPIC_VERSION = '2023-06-01'
const RESULT_TOOL_NAME = 'emit_result'
const MAX_OUTPUT_TOKENS = 8_192

function trimTrailingSlash(url: string): string {
    return url.endsWith('/') ? url.slice(0, -1) : url
}

export const anthropicAdapter: ProviderAdapter = {
    buildRequest(input: BuildRequestInput): HttpRequestDescriptor {
        const { operation, systemPrompt, model, config } = input
        if (config.apiKey.length === 0) {
            throw new ProviderError(
                'invalid-config',
                redactSecret(`Anthropic backend "${config.label}" has no API key`, config.apiKey)
            )
        }
        if (model.length === 0) {
            throw new ProviderError(
                'invalid-config',
                redactSecret(
                    `Anthropic backend "${config.label}" has no model configured`,
                    config.apiKey
                )
            )
        }
        const baseUrl = trimTrailingSlash(
            config.baseUrl.length > 0 ? config.baseUrl : DEFAULT_BASE_URL
        )
        const thinkingOn = config.thinking === 'on'
        const body: Record<string, unknown> = {
            model,
            // With thinking on, the budget counts against max_tokens — adding
            // it on top keeps the full output budget for the actual result.
            max_tokens: thinkingOn
                ? MAX_OUTPUT_TOKENS + config.thinkingBudgetTokens
                : MAX_OUTPUT_TOKENS,
            system: systemPrompt,
            messages: [{ role: 'user', content: buildUserMessage(operation, 'tool-input') }],
            tools: [
                {
                    name: RESULT_TOOL_NAME,
                    description: 'Report the structured result of the requested operation.',
                    input_schema: resultJsonSchema(operation.kind)
                }
            ],
            // Forced tool use is rejected while extended thinking is enabled
            // (only 'auto'/'none' are allowed) — relax to auto and rely on
            // the prompt + the parser's text fallback.
            tool_choice: thinkingOn ? { type: 'auto' } : { type: 'tool', name: RESULT_TOOL_NAME }
        }
        if (thinkingOn) {
            body['thinking'] = { type: 'enabled', budget_tokens: config.thinkingBudgetTokens }
        }
        return {
            url: `${baseUrl}/v1/messages`,
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                'x-api-key': config.apiKey,
                'anthropic-version': ANTHROPIC_VERSION,
                // Anthropic requires this opt-in for browser-origin requests.
                'anthropic-dangerous-direct-browser-access': 'true'
            },
            body: JSON.stringify(body)
        }
    },

    parseBufferedResponse(raw: unknown): OperationResult {
        if (typeof raw !== 'object' || raw === null) {
            throw new ProviderError('invalid-output', 'Anthropic response is not an object')
        }
        const content = (raw as Record<string, unknown>)['content']
        if (!Array.isArray(content)) {
            throw new ProviderError('invalid-output', 'Anthropic response has no content blocks')
        }
        for (const block of content) {
            if (typeof block !== 'object' || block === null) {
                continue
            }
            const candidate = block as Record<string, unknown>
            // Non-matching block types — including `thinking` and
            // `redacted_thinking` emitted under extended thinking — are
            // skipped: reasoning is never part of the operation result.
            if (candidate['type'] === 'tool_use' && candidate['name'] === RESULT_TOOL_NAME) {
                return validateOperationResult(candidate['input'])
            }
        }
        // Defensive fallback: some models emit the JSON as text despite the
        // forced tool choice — accept it if (and only if) it validates.
        const textParts = content
            .filter(
                (block): block is { type: string; text: string } =>
                    typeof block === 'object' &&
                    block !== null &&
                    (block as Record<string, unknown>)['type'] === 'text' &&
                    typeof (block as Record<string, unknown>)['text'] === 'string'
            )
            .map((block) => block.text)
        if (textParts.length === 0) {
            throw new ProviderError(
                'invalid-output',
                'Anthropic response contains no result tool call'
            )
        }
        return validateOperationResult(extractJsonPayload(textParts.join('\n')))
    },

    capabilities(): ProviderCapabilities {
        return { streaming: true, jsonSchema: true, reportsUsage: true }
    }
}
