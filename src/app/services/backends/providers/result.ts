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

/** Contract bound for prefix/suffix hints (mirrors rawFindingSchema). */
const HINT_MAX = 200

/**
 * Clamps advisory fields models routinely overshoot despite instructions,
 * BEFORE contract validation. Only lossless-in-spirit repairs are allowed:
 * prefix/suffix are disambiguation hints, so truncating a too-long prefix to
 * its TAIL and a suffix to its HEAD (the characters adjacent to the quote)
 * preserves their entire disambiguation value. Anything else stays strict —
 * a wrong quote or missing critique is still 'invalid-output'.
 */
function clampAdvisoryFields(candidate: unknown): unknown {
    if (typeof candidate !== 'object' || candidate === null) {
        return candidate
    }
    const record = candidate as Record<string, unknown>
    if (!Array.isArray(record['findings'])) {
        return candidate
    }
    const findings = record['findings'].map((finding: unknown) => {
        if (typeof finding !== 'object' || finding === null) {
            return finding
        }
        const f = { ...(finding as Record<string, unknown>) }
        if (typeof f['prefix'] === 'string' && f['prefix'].length > HINT_MAX) {
            f['prefix'] = f['prefix'].slice(-HINT_MAX)
        }
        if (typeof f['suffix'] === 'string' && f['suffix'].length > HINT_MAX) {
            f['suffix'] = f['suffix'].slice(0, HINT_MAX)
        }
        return f
    })
    return { ...record, findings }
}

/**
 * Validates a candidate result against the operation contract. Error
 * messages carry Zod issue paths (structure only) — never the payload
 * content, which could be arbitrarily large or sensitive.
 */
export function validateOperationResult(candidate: unknown): OperationResult {
    const parsed = operationResultSchema.safeParse(clampAdvisoryFields(candidate))
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
