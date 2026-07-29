/**
 * Text normalization with a reversible offset map.
 *
 * LLMs quoting "verbatim" still drift on typography: smart quotes vs straight
 * quotes, non-breaking spaces, collapsed whitespace, Unicode composition.
 * To match such quotes without losing the ability to point back into the real
 * document, normalization produces both the normalized string AND an index
 * map from every normalized character to its source offset.
 */

export interface NormalizedText {
    /** The normalized string. */
    readonly text: string
    /**
     * For each character in `text`, the offset of the source character that
     * produced it. Length === text.length. Monotonically non-decreasing.
     */
    readonly sourceOffsets: readonly number[]
}

/** Characters treated as equivalent to a plain space. */
const SPACE_EQUIVALENTS = /[\u00a0\u2000-\u200b\u202f\u205f\u3000\t]/

/** Typographic character folding applied character-by-character. */
const CHAR_FOLD: Readonly<Record<string, string>> = {
    '‘': "'", // left single quote
    '’': "'", // right single quote
    '‚': "'",
    '‛': "'",
    '“': '"', // left double quote
    '”': '"', // right double quote
    '„': '"',
    '‟': '"',
    '–': '-', // en dash
    '—': '-', // em dash
    '−': '-', // minus sign
    '…': '...' // ellipsis
}

/**
 * Normalizes text for tolerant matching:
 * - folds smart quotes/dashes/ellipsis to ASCII equivalents,
 * - maps exotic spaces to plain spaces,
 * - collapses runs of whitespace (incl. newlines) into a single space,
 * - lowercases (case drift is a common LLM quoting error).
 *
 * Every produced character records the source offset it came from, so any
 * match range in normalized space can be projected back onto the source.
 */
export function normalizeForMatching(source: string): NormalizedText {
    let out = ''
    const offsets: number[] = []
    let pendingSpace = false
    let lastWasOutput = false

    for (let i = 0; i < source.length; i++) {
        const ch = source[i] as string
        const isSpace = ch === ' ' || ch === '\n' || ch === '\r' || SPACE_EQUIVALENTS.test(ch)
        if (isSpace) {
            if (lastWasOutput) {
                pendingSpace = true
            }
            continue
        }
        if (pendingSpace) {
            out += ' '
            // The space maps to the first character of the collapsed run's
            // successor; using the current char's offset keeps monotonicity.
            offsets.push(i)
            pendingSpace = false
        }
        const folded = CHAR_FOLD[ch] ?? ch.toLowerCase()
        for (const foldedChar of folded) {
            out += foldedChar
            offsets.push(i)
        }
        lastWasOutput = true
    }

    return { text: out, sourceOffsets: offsets }
}

/**
 * Projects a range in normalized space back to source offsets.
 * Returns `null` for an empty or out-of-bounds range.
 */
export function projectToSource(
    normalized: NormalizedText,
    from: number,
    to: number
): { from: number; to: number } | null {
    if (from < 0 || to > normalized.sourceOffsets.length || from >= to) {
        return null
    }
    const start = normalized.sourceOffsets[from]
    const lastIncluded = normalized.sourceOffsets[to - 1]
    if (start === undefined || lastIncluded === undefined) {
        return null
    }
    return { from: start, to: lastIncluded + 1 }
}
