import { normalizeForMatching, projectToSource } from './normalize'

/**
 * Quote → position resolution against a document snapshot.
 *
 * Strategy ladder (see Business Rules #4):
 * 1. `exact`      — the quote appears verbatim in the snapshot.
 * 2. `normalized` — the quote appears after typographic normalization
 *                   (smart quotes, whitespace runs, case).
 * 3. No match / ambiguous match → the finding stays unanchored (display-only).
 *
 * Multiple occurrences are only actionable when disambiguated by context
 * hints (prefix/suffix text around the quote) or an explicit occurrence
 * index. An ambiguous match is never guessed: guessing anchors means
 * applying edits to the wrong place.
 */

export type MatchStrategy = 'exact' | 'normalized'

export interface MatchHints {
    /** Text expected to appear immediately before the quote. */
    readonly prefix?: string
    /** Text expected to appear immediately after the quote. */
    readonly suffix?: string
    /** 0-based occurrence index when the backend counted occurrences. */
    readonly occurrence?: number
}

export interface QuoteMatch {
    readonly from: number
    readonly to: number
    readonly strategy: MatchStrategy
}

export type MatchResult =
    | { readonly status: 'matched'; readonly match: QuoteMatch }
    | {
          readonly status: 'ambiguous'
          readonly candidates: readonly QuoteMatch[]
      }
    | { readonly status: 'not-found' }

function findAllOccurrences(haystack: string, needle: string): number[] {
    const result: number[] = []
    if (needle.length === 0) {
        return result
    }
    let index = haystack.indexOf(needle)
    while (index !== -1) {
        result.push(index)
        index = haystack.indexOf(needle, index + 1)
    }
    return result
}

/**
 * Picks the single actionable candidate, or `null` when the quote cannot be
 * disambiguated safely.
 *
 * `occurrence` is the 0-based index among ALL occurrences in the document
 * (the operation contract's definition) — it is never resolved against a
 * hint-filtered subset, which would silently re-index it. When both an
 * occurrence index and prefix/suffix hints are present they must agree: the
 * indexed candidate must also satisfy the hints, otherwise the backend
 * response is internally inconsistent and anchoring would risk applying an
 * edit to the wrong span (Business Rules #4).
 */
function disambiguate<T>(
    candidates: readonly T[],
    matchesHints: (candidate: T) => boolean,
    hasHints: boolean,
    occurrence: number | undefined
): T | null {
    if (candidates.length === 1) {
        return candidates[0] ?? null
    }
    if (occurrence !== undefined) {
        if (occurrence < 0 || occurrence >= candidates.length) {
            return null
        }
        const indexed = candidates[occurrence]
        if (indexed === undefined || (hasHints && !matchesHints(indexed))) {
            return null
        }
        return indexed
    }
    const hinted = candidates.filter(matchesHints)
    if (hinted.length === 1) {
        return hinted[0] ?? null
    }
    return null
}

/** Whether the hints carry any usable prefix/suffix context. */
function hasContextHints(hints: MatchHints): boolean {
    return (
        (hints.prefix !== undefined && hints.prefix.length > 0) ||
        (hints.suffix !== undefined && hints.suffix.length > 0)
    )
}

/**
 * Resolves a verbatim quote to a range in `snapshotText`.
 */
export function matchQuote(
    snapshotText: string,
    quote: string,
    hints: MatchHints = {}
): MatchResult {
    if (quote.length === 0) {
        return { status: 'not-found' }
    }

    // 1. Exact matching.
    const exactOffsets = findAllOccurrences(snapshotText, quote)
    if (exactOffsets.length > 0) {
        const matches: QuoteMatch[] = exactOffsets.map((offset) => ({
            from: offset,
            to: offset + quote.length,
            strategy: 'exact'
        }))
        const chosen = disambiguate(
            matches,
            (candidate) => contextMatches(snapshotText, candidate.from, candidate.to, hints),
            hasContextHints(hints),
            hints.occurrence
        )
        if (chosen) {
            return { status: 'matched', match: chosen }
        }
        return { status: 'ambiguous', candidates: matches }
    }

    // 2. Normalized matching with source projection.
    const normalizedDoc = normalizeForMatching(snapshotText)
    const normalizedQuote = normalizeForMatching(quote).text
    if (normalizedQuote.length === 0) {
        return { status: 'not-found' }
    }
    const normalizedOffsets = findAllOccurrences(normalizedDoc.text, normalizedQuote)
    if (normalizedOffsets.length === 0) {
        return { status: 'not-found' }
    }
    const projected: QuoteMatch[] = []
    for (const offset of normalizedOffsets) {
        const range = projectToSource(normalizedDoc, offset, offset + normalizedQuote.length)
        if (range) {
            projected.push({ from: range.from, to: range.to, strategy: 'normalized' })
        }
    }
    if (projected.length === 0) {
        return { status: 'not-found' }
    }
    const chosen = disambiguate(
        projected,
        (candidate) => contextMatches(snapshotText, candidate.from, candidate.to, hints),
        hasContextHints(hints),
        hints.occurrence
    )
    if (chosen) {
        return { status: 'matched', match: chosen }
    }
    return { status: 'ambiguous', candidates: projected }
}

/**
 * Checks prefix/suffix hints against the source text around a candidate
 * range, using normalized comparison so hint typography doesn't matter.
 */
function contextMatches(sourceText: string, from: number, to: number, hints: MatchHints): boolean {
    if (hints.prefix === undefined && hints.suffix === undefined) {
        return false
    }
    if (hints.prefix !== undefined && hints.prefix.length > 0) {
        const windowStart = Math.max(0, from - hints.prefix.length * 3)
        const before = normalizeForMatching(sourceText.slice(windowStart, from)).text
        const wanted = normalizeForMatching(hints.prefix).text
        if (wanted.length === 0 || !before.endsWith(wanted)) {
            return false
        }
    }
    if (hints.suffix !== undefined && hints.suffix.length > 0) {
        const windowEnd = Math.min(sourceText.length, to + hints.suffix.length * 3)
        const after = normalizeForMatching(sourceText.slice(to, windowEnd)).text
        const wanted = normalizeForMatching(hints.suffix).text
        if (wanted.length === 0 || !after.startsWith(wanted)) {
            return false
        }
    }
    return true
}
