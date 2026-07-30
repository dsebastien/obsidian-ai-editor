import { normalizeForMatching, projectToSource, type NormalizedText } from './normalize'

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
 *
 * ## Resolving MANY quotes against ONE document
 *
 * Rung 2 normalizes the whole document, which costs O(document). Doing that
 * per quote makes resolving n quotes O(n · document) — and the callers that
 * matter all resolve many quotes against the same text: a review ingests up
 * to 200 findings against one snapshot, and the margin re-anchors up to 500
 * durable comments against the live note ON EVERY REFRESH CYCLE, i.e. while
 * the user types. Measured before this seam existed: 500 orphaned comments on
 * a 200 000-character note took **7.1 s** per cycle (`perf.bench.spec.ts`).
 *
 * So the normalization belongs to the DOCUMENT, not to the call:
 * {@link createQuoteMatcher} binds one text, normalizes it at most once
 * (lazily — a batch where every quote hits the exact rung never pays for it at
 * all), and answers any number of quotes. {@link matchQuote} remains for
 * one-off callers and is exactly a matcher used once, so there is only ever
 * one implementation of the ladder.
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

/**
 * A quote resolver bound to one document text.
 *
 * Stateless from the caller's point of view: `match` is a pure function of
 * (bound text, quote, hints), and the only thing carried between calls is the
 * normalized projection of the bound text, which is derived from it. Build one
 * per batch; never keep one past the text it was built for (the bound text is
 * exposed as {@link QuoteMatcher.text} precisely so callers that hold a
 * matcher do not need to carry the string alongside it and risk the two
 * drifting apart).
 */
export interface QuoteMatcher {
    /** The document this matcher resolves against. */
    readonly text: string
    match(quote: string, hints?: MatchHints): MatchResult
}

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
 * Builds a resolver bound to `snapshotText`. See {@link QuoteMatcher}.
 *
 * The normalized projection is built on FIRST USE, not here: a batch of quotes
 * that all match verbatim never normalizes the document, and a caller that
 * builds a matcher and resolves nothing pays nothing.
 */
export function createQuoteMatcher(snapshotText: string): QuoteMatcher {
    let normalizedDoc: NormalizedText | null = null
    const normalized = (): NormalizedText => {
        normalizedDoc ??= normalizeForMatching(snapshotText)
        return normalizedDoc
    }

    return {
        text: snapshotText,
        match(quote: string, hints: MatchHints = {}): MatchResult {
            if (quote.length === 0) {
                return { status: 'not-found' }
            }

            // The hints are normalized ONCE per call rather than once per
            // candidate: a quote occurring n times would otherwise re-fold the
            // same two hint strings n times.
            const wantedPrefix =
                hints.prefix === undefined || hints.prefix.length === 0
                    ? null
                    : normalizeForMatching(hints.prefix).text
            const wantedSuffix =
                hints.suffix === undefined || hints.suffix.length === 0
                    ? null
                    : normalizeForMatching(hints.suffix).text
            const contextOf = (candidate: QuoteMatch): boolean =>
                contextMatches(snapshotText, candidate.from, candidate.to, {
                    prefix: hints.prefix,
                    suffix: hints.suffix,
                    wantedPrefix,
                    wantedSuffix
                })

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
                    contextOf,
                    hasContextHints(hints),
                    hints.occurrence
                )
                if (chosen) {
                    return { status: 'matched', match: chosen }
                }
                return { status: 'ambiguous', candidates: matches }
            }

            // 2. Normalized matching with source projection.
            const normalizedQuote = normalizeForMatching(quote).text
            if (normalizedQuote.length === 0) {
                return { status: 'not-found' }
            }
            const normalizedDocument = normalized()
            const normalizedOffsets = findAllOccurrences(normalizedDocument.text, normalizedQuote)
            if (normalizedOffsets.length === 0) {
                return { status: 'not-found' }
            }
            const projected: QuoteMatch[] = []
            for (const offset of normalizedOffsets) {
                const range = projectToSource(
                    normalizedDocument,
                    offset,
                    offset + normalizedQuote.length
                )
                if (range) {
                    projected.push({ from: range.from, to: range.to, strategy: 'normalized' })
                }
            }
            if (projected.length === 0) {
                return { status: 'not-found' }
            }
            const chosen = disambiguate(
                projected,
                contextOf,
                hasContextHints(hints),
                hints.occurrence
            )
            if (chosen) {
                return { status: 'matched', match: chosen }
            }
            return { status: 'ambiguous', candidates: projected }
        }
    }
}

/**
 * Resolves a verbatim quote to a range in `snapshotText`.
 *
 * One-shot form of {@link createQuoteMatcher}. Callers resolving several
 * quotes against the same text should build a matcher instead — this one
 * re-derives everything per call by construction.
 */
export function matchQuote(
    snapshotText: string,
    quote: string,
    hints: MatchHints = {}
): MatchResult {
    return createQuoteMatcher(snapshotText).match(quote, hints)
}

/** Hints with their normalized forms already computed (see `match`). */
interface ResolvedHints {
    readonly prefix?: string | undefined
    readonly suffix?: string | undefined
    readonly wantedPrefix: string | null
    readonly wantedSuffix: string | null
}

/**
 * Checks prefix/suffix hints against the source text around a candidate
 * range, using normalized comparison so hint typography doesn't matter.
 */
function contextMatches(
    sourceText: string,
    from: number,
    to: number,
    hints: ResolvedHints
): boolean {
    if (hints.prefix === undefined && hints.suffix === undefined) {
        return false
    }
    if (hints.prefix !== undefined && hints.prefix.length > 0) {
        const windowStart = Math.max(0, from - hints.prefix.length * 3)
        const before = normalizeForMatching(sourceText.slice(windowStart, from)).text
        const wanted = hints.wantedPrefix
        if (wanted === null || wanted.length === 0 || !before.endsWith(wanted)) {
            return false
        }
    }
    if (hints.suffix !== undefined && hints.suffix.length > 0) {
        const windowEnd = Math.min(sourceText.length, to + hints.suffix.length * 3)
        const after = normalizeForMatching(sourceText.slice(to, windowEnd)).text
        const wanted = hints.wantedSuffix
        if (wanted === null || wanted.length === 0 || !after.startsWith(wanted)) {
            return false
        }
    }
    return true
}
