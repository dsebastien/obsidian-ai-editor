import {
    operationResultSchema,
    rawFindingSchema,
    reviewResultSchema,
    type OperationResult,
    type RawFinding
} from '../../../domain/operations/contract'
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

/** Clamps a too-long prefix to its TAIL and suffix to its HEAD, in place. */
function clampHints(record: Record<string, unknown>): void {
    if (typeof record['prefix'] === 'string' && record['prefix'].length > HINT_MAX) {
        record['prefix'] = record['prefix'].slice(-HINT_MAX)
    }
    if (typeof record['suffix'] === 'string' && record['suffix'].length > HINT_MAX) {
        record['suffix'] = record['suffix'].slice(0, HINT_MAX)
    }
}

/**
 * Clamps advisory fields models routinely overshoot despite instructions,
 * BEFORE contract validation. Only lossless-in-spirit repairs are allowed:
 * prefix/suffix are disambiguation hints (on findings AND on their edits), so
 * truncating a too-long prefix to its TAIL and a suffix to its HEAD (the
 * characters adjacent to the quote) preserves their entire disambiguation
 * value. Anything else stays strict — a wrong quote or missing critique is
 * still 'invalid-output'.
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
        clampHints(f)
        if (Array.isArray(f['edits'])) {
            f['edits'] = f['edits'].map((edit: unknown) => {
                if (typeof edit !== 'object' || edit === null) {
                    return edit
                }
                const e = { ...(edit as Record<string, unknown>) }
                clampHints(e)
                return e
            })
        }
        return f
    })
    return { ...record, findings }
}

/**
 * What the per-finding salvage pass did to a review result (contract v2
 * design doc §5). Carried on the terminal result event so the run layer can
 * report it — degradation is visible, never silent.
 */
export interface SalvageReport {
    /** Findings dropped outright: their observation core failed validation. */
    readonly discardedFindings: number
    /** Findings kept display-only after their proposed edits failed validation. */
    readonly invalidProposals: number
}

export interface ValidatedOperationResult {
    readonly result: OperationResult
    /** `null` when nothing was salvaged (including every non-review kind). */
    readonly salvage: SalvageReport | null
}

function contractError(issues: readonly { path: PropertyKey[]; code: string }[]): ProviderError {
    const summary = issues
        .slice(0, 5)
        .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.code}`)
        .join('; ')
    return new ProviderError(
        'invalid-output',
        `Model response does not match the operation result contract (${summary})`
    )
}

/**
 * Per-finding salvage for review results: the ENVELOPE stays strict, but each
 * finding validates individually — a finding whose `edits` are invalid keeps
 * its critique and degrades to display-only (`invalidProposal` marker); a
 * finding whose observation core is invalid is dropped and counted. This is
 * the fail-closed mechanism of #17: an unsafe proposal degrades to critique,
 * never to a wrong write — and one bad edit from a weak model no longer costs
 * the user the entire review.
 *
 * A finding that ARRIVES with `invalidProposal: true` (models should never
 * set it, but the field is in the parse schema) is read the fail-closed way:
 * its edits are stripped too.
 */
function salvageReviewFindings(record: Record<string, unknown>): {
    findings: RawFinding[]
    salvage: SalvageReport | null
} {
    const rawItems = Array.isArray(record['findings']) ? record['findings'] : []
    const findings: RawFinding[] = []
    let discardedFindings = 0
    let invalidProposals = 0
    for (const item of rawItems) {
        const direct = rawFindingSchema.safeParse(item)
        if (direct.success) {
            const finding = direct.data
            if (finding.invalidProposal && finding.edits.length > 0) {
                findings.push({ ...finding, edits: [] })
                invalidProposals += 1
            } else {
                findings.push(finding)
            }
            continue
        }
        if (typeof item !== 'object' || item === null) {
            discardedFindings += 1
            continue
        }
        const stripped = rawFindingSchema.safeParse({
            ...(item as Record<string, unknown>),
            edits: [],
            invalidProposal: true
        })
        if (stripped.success) {
            findings.push(stripped.data)
            invalidProposals += 1
        } else {
            discardedFindings += 1
        }
    }
    const salvage =
        discardedFindings > 0 || invalidProposals > 0
            ? { discardedFindings, invalidProposals }
            : null
    return { findings, salvage }
}

/**
 * Validates a candidate result against the operation contract. Review results
 * get the per-finding salvage pass (see {@link salvageReviewFindings});
 * every other kind, and every envelope, is strict. Error messages carry Zod
 * issue paths (structure only) — never the payload content, which could be
 * arbitrarily large or sensitive.
 */
export function validateOperationResult(candidate: unknown): ValidatedOperationResult {
    const clamped = clampAdvisoryFields(candidate)
    if (
        typeof clamped === 'object' &&
        clamped !== null &&
        (clamped as Record<string, unknown>)['kind'] === 'review' &&
        // Salvage substitutes the findings ARRAY item by item; a `findings`
        // that is not an array at all is an envelope malformation and must
        // fail strict below — never be silently replaced by an empty list.
        Array.isArray((clamped as Record<string, unknown>)['findings'])
    ) {
        const record = clamped as Record<string, unknown>
        const { findings, salvage } = salvageReviewFindings(record)
        const parsed = reviewResultSchema.safeParse({ ...record, findings })
        if (!parsed.success) {
            throw contractError(parsed.error.issues)
        }
        return { result: parsed.data, salvage }
    }
    const parsed = operationResultSchema.safeParse(clamped)
    if (!parsed.success) {
        throw contractError(parsed.error.issues)
    }
    return { result: parsed.data, salvage: null }
}
