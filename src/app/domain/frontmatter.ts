/**
 * Leading-frontmatter removal for the `behavior.stripFrontmatter` privacy
 * control.
 *
 * Vault frontmatter routinely carries exactly the material a user would want
 * kept out of a backend request — client names, contact records, health
 * properties, private aliases, source URLs — while contributing nothing to a
 * prose review. The setting promises it is removed from the text sent; this
 * module is the one implementation of "removed".
 *
 * Deliberately narrow, and deliberately not a YAML parser:
 *
 * - Only a block that OPENS the document is a frontmatter block (Obsidian's
 *   own rule). A `---` anywhere else is a thematic break and is left alone.
 * - The block is removed verbatim, including its closing delimiter and the
 *   newline after it. Nothing else in the text is touched, so the remainder is
 *   byte-identical to the corresponding tail of the input — which is what lets
 *   callers shift offsets by a single number instead of remapping.
 * - A document with no frontmatter is returned unchanged, with
 *   `removedChars: 0`. Callers use that as the "nothing happened" signal
 *   rather than comparing strings.
 */

/** A leading `---` … `---` block, or the absence of one. */
export interface StrippedFrontmatter {
    /** The text with the leading frontmatter block removed. */
    readonly text: string
    /**
     * Characters removed from the FRONT of the input. `0` when there was no
     * frontmatter block; every offset into `text` is then the input offset
     * minus this number.
     */
    readonly removedChars: number
}

/**
 * Matches only at position 0: an opening `---` line, optional YAML body, and a
 * closing `---` line (end of input counts as its terminator, so a file that is
 * nothing but frontmatter is handled). `[ \t]*` tolerates trailing whitespace
 * on either delimiter line; `\r?\n` tolerates CRLF.
 */
const FRONTMATTER_BLOCK = /^---[ \t]*\r?\n(?:[\s\S]*?\r?\n)?---[ \t]*(?:\r?\n|$)/

/** Removes a leading frontmatter block, if the text opens with one. */
export function stripFrontmatterBlock(text: string): StrippedFrontmatter {
    const match = FRONTMATTER_BLOCK.exec(text)
    if (match === null) {
        return { text, removedChars: 0 }
    }
    const removedChars = match[0].length
    return { text: text.slice(removedChars), removedChars }
}
