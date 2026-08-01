import { buildUserMessage, resultJsonSchema } from './prompt'
import {
    extractJsonPayload,
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
 * Anthropic Messages API adapter.
 *
 * Structured output is enforced with forced tool use: a single tool whose
 * `input_schema` is the operation's result schema, selected via
 * `tool_choice` — the model cannot answer except by producing a
 * schema-conforming tool input. The CORS opt-in header enables direct
 * renderer `fetch` from Obsidian (no backend proxy).
 *
 * Thinking (config.thinking):
 * - 'on' sends ADAPTIVE thinking (`thinking: { type: 'adaptive' }`) — the
 *   current API mode (Claude 4.6 and newer; manual `budget_tokens` is
 *   deprecated on 4.6 and rejected with HTTP 400 on 4.7+/5.x). Adaptive
 *   thinking supports forced tool use, so `tool_choice` stays forced; the
 *   thinking spend counts against `max_tokens`, so the output budget is
 *   raised to leave room for both reasoning and the result.
 * - 'budget' sends the LEGACY manual block
 *   (`thinking: { type: 'enabled', budget_tokens } `) for Claude
 *   4.5-and-earlier models. Forced tool use is rejected in this mode, so
 *   `tool_choice` relaxes to `auto` — the prompt still demands the tool
 *   call, and the parser's text-block JSON fallback covers a model that
 *   answers in prose. The budget rides on top of the output budget, with
 *   the sum clamped to the 32k output ceiling of those legacy models and
 *   the budget clamped below `max_tokens` (API constraint
 *   `budget_tokens < max_tokens`).
 * Response `thinking`/`redacted_thinking` blocks are skipped by the parser
 * in both modes.
 */

const DEFAULT_BASE_URL = 'https://api.anthropic.com'
const ANTHROPIC_VERSION = '2023-06-01'
const RESULT_TOOL_NAME = 'emit_result'
const MAX_OUTPUT_TOKENS = 8_192
/**
 * Output budget with adaptive thinking on: thinking tokens count against
 * `max_tokens`, so 8192 alone risks a long think truncating the result.
 * Every adaptive-capable model (Claude 4.6+) allows ≥64k output, so 32k is
 * safe headroom for reasoning + result.
 */
const ADAPTIVE_MAX_OUTPUT_TOKENS = 32_000
/**
 * Hard output-token ceiling of the legacy (≤4.5) Claude models — the only
 * ones that still accept manual extended thinking. `max_tokens` above this
 * fails request validation with HTTP 400 before any generation happens.
 */
const LEGACY_MAX_TOKENS_CEILING = 32_000
/** Minimum room kept for the result when the legacy budget is clamped. */
const LEGACY_RESULT_HEADROOM = 1_024

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
        const mode = config.thinking
        // Legacy budget mode: budget rides on top of the output budget, but
        // the sum must stay within the legacy models' 32k output ceiling —
        // and budget_tokens must stay strictly below max_tokens.
        const legacyMaxTokens = Math.min(
            MAX_OUTPUT_TOKENS + config.thinkingBudgetTokens,
            LEGACY_MAX_TOKENS_CEILING
        )
        const legacyBudget = Math.min(
            config.thinkingBudgetTokens,
            legacyMaxTokens - LEGACY_RESULT_HEADROOM
        )
        const body: Record<string, unknown> = {
            model,
            max_tokens:
                mode === 'on'
                    ? ADAPTIVE_MAX_OUTPUT_TOKENS
                    : mode === 'budget'
                      ? legacyMaxTokens
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
            // Forced tool use is rejected only by LEGACY manual thinking
            // (only 'auto'/'none' are allowed there) — relax to auto in that
            // mode and rely on the prompt + the parser's text fallback.
            // Adaptive thinking supports forced tool use, so it keeps the
            // structural output guarantee.
            tool_choice:
                mode === 'budget' ? { type: 'auto' } : { type: 'tool', name: RESULT_TOOL_NAME }
        }
        if (mode === 'on') {
            body['thinking'] = { type: 'adaptive' }
        } else if (mode === 'budget') {
            body['thinking'] = { type: 'enabled', budget_tokens: legacyBudget }
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

    parseBufferedResponse(raw: unknown): ValidatedOperationResult {
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
