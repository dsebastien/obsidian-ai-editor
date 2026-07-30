/**
 * Turning a LIVE span into the locating hints a durable comment persists.
 *
 * The inverse of `matchQuote`: findings arrive from a backend already carrying
 * `quote` + `prefix`/`suffix`/`occurrence`, but a margin comment is created by
 * the user pointing at text in their editor, so the hints have to be derived
 * from the document. Getting this wrong is invisible today and fatal later —
 * the comment re-anchors months from now, against a note that moved, and hints
 * that did not disambiguate at creation time never will.
 *
 * The guarantee, spec-pinned as a round trip: hints produced here re-anchor
 * through `matchQuote` to exactly the span they were taken from, in the same
 * text.
 */

/** Context kept on each side. Long enough to disambiguate, short enough to store. */
const CONTEXT_CHARS = 40

export interface SpanHints {
    /** Verbatim span text. */
    readonly quote: string
    /** Text immediately before it (up to `CONTEXT_CHARS`). */
    readonly prefix: string
    /** Text immediately after it (up to `CONTEXT_CHARS`). */
    readonly suffix: string
    /**
     * 0-based index of this occurrence among the EXACT occurrences of `quote`
     * in the text. Always recorded, even when the quote is unique: the note
     * keeps being edited, and a quote that is unique today may not be when the
     * comment is re-anchored.
     */
    readonly occurrence: number
}

/**
 * Describes `text.slice(from, to)`. Returns `null` for a degenerate or
 * out-of-bounds range — a comment on nothing is not a comment, and inventing a
 * span would put a durable question on text the user never selected.
 */
export function spanHints(text: string, from: number, to: number): SpanHints | null {
    if (!Number.isInteger(from) || !Number.isInteger(to)) {
        return null
    }
    if (from < 0 || to > text.length || from >= to) {
        return null
    }
    const quote = text.slice(from, to)
    return {
        quote,
        prefix: text.slice(Math.max(0, from - CONTEXT_CHARS), from),
        suffix: text.slice(to, Math.min(text.length, to + CONTEXT_CHARS)),
        occurrence: countOccurrencesBefore(text, quote, from)
    }
}

/**
 * How many exact occurrences of `quote` start strictly before `from`.
 *
 * Overlapping occurrences are counted the way `matchQuote` enumerates them
 * (advance by one character, not by the quote's length), so the index this
 * produces and the index that consumes it always mean the same thing for a
 * self-overlapping quote like `aa` in `aaaa`.
 */
function countOccurrencesBefore(text: string, quote: string, from: number): number {
    let count = 0
    let index = text.indexOf(quote)
    while (index !== -1 && index < from) {
        count += 1
        index = text.indexOf(quote, index + 1)
    }
    return count
}
