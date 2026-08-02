import {
    operationResultSchema,
    rawFindingSchema,
    reviewResultSchema,
    type OperationResult,
    type RawFinding
} from '../../../domain/operations/contract'
import { log } from '../../../../utils/log'
import { ProviderError } from './types'

/**
 * Response-side helpers shared by the provider adapters: extract the model's
 * JSON payload from provider-specific envelopes and validate it against the
 * operation contract. Model output is untrusted text until it passes the Zod
 * schemas — a "mostly right" payload is still an 'invalid-output' failure.
 */

/**
 * Parses model-produced text into JSON (issue #18). Tolerated deviations, in
 * order:
 *
 * 1. The whole (trimmed) text is JSON — the well-behaved case.
 * 2. The text CONTAINS a balanced JSON object — code fences with any
 *    language tag, prose before or after ("Here are my comments: {…}" /
 *    a trailing "Let me know if…"), or both. Candidates are tried in order
 *    and the first one CARRYING A `kind` FIELD wins (every operation result
 *    has one) — so a small off-contract object in the preamble
 *    (`{"format":"json"}`) cannot shadow the real payload behind it; the
 *    first parsed object is the fallback when none carries `kind`. An
 *    UNCLOSED candidate does not end the search — a balanced object inside
 *    or after it is still recovered. Strict contract validation runs on the
 *    recovery afterwards, so this recovers an object the model clearly
 *    meant to send without accepting sloppy content.
 *
 * Anything else throws 'invalid-output' — after logging a diagnostic
 * (payload length, first/last 100 characters, whether the payload's tail
 * sits inside an unclosed object: the truncation signature) so a live
 * failure can be told apart from a chatty preamble without guessing.
 */
export function extractJsonPayload(content: string): unknown {
    const text = content.trim()
    try {
        return JSON.parse(text) as unknown
    } catch {
        // Fall through to balanced-object recovery.
    }
    const recovery = recoverBalancedObject(text)
    if (recovery.parsed !== undefined) {
        return recovery.parsed
    }
    const head = JSON.stringify(text.slice(0, 100))
    const tail = JSON.stringify(text.slice(-100))
    log(
        `Model response is not valid JSON — length ${text.length}, ` +
            `${recovery.unclosed ? 'contains an UNCLOSED object (truncation signature)' : 'no recoverable object found'}, ` +
            `first 100: ${head}, last 100: ${tail}`,
        'warn'
    )
    if (recovery.unclosed) {
        // The payload stops mid-object: the model ran out of output space
        // (or the stream was cut). Without the provider's finish reason this
        // is a strong signal, not proof — adapters that DO see a
        // length-type finish reason throw 'truncated' before ever calling
        // this parser's failure path.
        throw new ProviderError(
            'truncated',
            'The model stopped mid-answer — the response ends inside an unfinished JSON object. Try a shorter selection or note, or a model with a larger output limit.'
        )
    }
    throw new ProviderError('invalid-output', 'Model response is not valid JSON')
}

/**
 * Bound on recovery candidates. Each candidate scan is O(remaining text), so
 * pathological brace floods (thousands of `{` in prose or code samples) would
 * otherwise go quadratic and freeze the renderer (adversarial review,
 * 2026-08-02); 50 starts over a 100k-char payload is bounded work, and a real
 * payload's object is found within the first few candidates.
 */
const RECOVERY_MAX_CANDIDATES = 50

/**
 * Scans balanced top-level `{…}` candidates (string- and escape-aware), in
 * order. A candidate that parses AND carries a `kind` field wins immediately;
 * the first parsed object without one is kept as fallback. `unclosed: true`
 * means the LAST examined candidate ran off the end of the text — the shape a
 * response truncated mid-object leaves behind; an unclosed OUTER candidate
 * does not stop the search, because a balanced object may sit inside it
 * (`Use {placeholder … {"kind":…}` — adversarial review, 2026-08-02).
 */
function recoverBalancedObject(text: string): { parsed?: unknown; unclosed: boolean } {
    let start = text.indexOf('{')
    let fallback: unknown
    let haveFallback = false
    let lastUnclosed = false
    let attempts = 0
    while (start !== -1 && attempts < RECOVERY_MAX_CANDIDATES) {
        attempts += 1
        let depth = 0
        let inString = false
        let escaped = false
        let end = -1
        for (let i = start; i < text.length; i++) {
            const ch = text[i]
            if (escaped) {
                escaped = false
                continue
            }
            if (ch === '\\') {
                escaped = inString
                continue
            }
            if (ch === '"') {
                inString = !inString
                continue
            }
            if (inString) {
                continue
            }
            if (ch === '{') {
                depth += 1
            } else if (ch === '}') {
                depth -= 1
                if (depth === 0) {
                    end = i
                    break
                }
            }
        }
        if (end === -1) {
            // Opened but never closed before the text ran out. Keep looking:
            // the NEXT candidate starts inside this one and may be balanced.
            lastUnclosed = true
            start = text.indexOf('{', start + 1)
            continue
        }
        lastUnclosed = false
        try {
            const parsed = JSON.parse(text.slice(start, end + 1)) as unknown
            if (looksLikeOperationResult(parsed)) {
                return { parsed, unclosed: false }
            }
            if (!haveFallback) {
                fallback = parsed
                haveFallback = true
            }
        } catch {
            // A brace inside prose ("an example {like this}") — not a payload.
        }
        start = text.indexOf('{', start + 1)
    }
    if (haveFallback) {
        return { parsed: fallback, unclosed: false }
    }
    return { unclosed: lastUnclosed }
}

/**
 * Whether a recovered object is plausibly THE payload: every operation
 * result carries a string `kind` discriminator. A cheap shape probe, not
 * validation — `validateOperationResult` remains the gate.
 */
function looksLikeOperationResult(candidate: unknown): boolean {
    return (
        typeof candidate === 'object' &&
        candidate !== null &&
        !Array.isArray(candidate) &&
        typeof (candidate as Record<string, unknown>)['kind'] === 'string'
    )
}

/** One actionable truncation message, shared by every provider (issue #18). */
export const TRUNCATION_MESSAGE =
    'The model ran out of output space before finishing its answer. Try a shorter selection or note, or a model with a larger output limit.'

/**
 * Runs a parse under the provider's OWN truncation verdict (issue #18): when
 * the provider reported a length-type finish reason AND the payload fails to
 * parse or validate, the failure is 'truncated' — the model was cut off —
 * never a generic "not valid JSON". A payload that parses fine despite the
 * flag is accepted: the cut may have landed exactly at the payload boundary,
 * and a valid result is a valid result.
 */
export function guardTruncation<T>(truncatedByProvider: boolean, parse: () => T): T {
    try {
        return parse()
    } catch (cause) {
        if (
            truncatedByProvider &&
            cause instanceof ProviderError &&
            (cause.code === 'invalid-output' || cause.code === 'truncated')
        ) {
            throw new ProviderError('truncated', TRUNCATION_MESSAGE)
        }
        throw cause
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
