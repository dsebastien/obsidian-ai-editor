import { operationResultSchema, type OperationResult } from '../../../domain/operations/contract'
import { ProviderError } from './types'

/**
 * Response-side helpers shared by the provider adapters: extract the model's
 * JSON payload from provider-specific envelopes and validate it against the
 * operation contract. Model output is untrusted text until it passes the Zod
 * schemas — a "mostly right" payload is still an 'invalid-output' failure.
 */

/**
 * Parses model-produced text into JSON, tolerating the one deviation models
 * commonly make despite JSON-only instructions: wrapping the object in a
 * markdown code fence. Anything else malformed throws 'invalid-output'.
 */
export function extractJsonPayload(content: string): unknown {
    let text = content.trim()
    const fenceMatch = /^```(?:json)?\s*\n([\s\S]*?)\n```\s*$/.exec(text)
    const fenced = fenceMatch?.[1]
    if (fenced !== undefined) {
        text = fenced.trim()
    }
    try {
        return JSON.parse(text) as unknown
    } catch {
        throw new ProviderError('invalid-output', 'Model response is not valid JSON')
    }
}

/**
 * Validates a candidate result against the operation contract. Error
 * messages carry Zod issue paths (structure only) — never the payload
 * content, which could be arbitrarily large or sensitive.
 */
export function validateOperationResult(candidate: unknown): OperationResult {
    const parsed = operationResultSchema.safeParse(candidate)
    if (!parsed.success) {
        const issues = parsed.error.issues
            .slice(0, 5)
            .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.code}`)
            .join('; ')
        throw new ProviderError(
            'invalid-output',
            `Model response does not match the operation result contract (${issues})`
        )
    }
    return parsed.data
}
