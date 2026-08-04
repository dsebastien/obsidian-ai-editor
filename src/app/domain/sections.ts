/**
 * Markdown section boundaries for the placement verbs (issue #31).
 *
 * A "section" is what a reader means by one: the ATX heading (`#`–`######`)
 * governing the offset, through to the next heading of the same or higher
 * level. Setext headings are not recognized (consistent with how rare they
 * are in vaults), and heading-looking lines inside fenced code blocks
 * (``` or ~~~) are ignored. With no governing heading, the section is the
 * note's preamble: everything before the first heading — or the whole note
 * when there are no headings at all.
 */

interface HeadingLine {
    /** 1–6. */
    readonly level: number
    /** Offset of the line's first character. */
    readonly start: number
    /** Offset just past the line's text (before the newline). */
    readonly end: number
}

const FENCE = /^(?:`{3,}|~{3,})/
const ATX = /^(#{1,6})[ \t]/

/** Every ATX heading line outside fenced code, in document order. */
function headingLines(text: string): HeadingLine[] {
    const headings: HeadingLine[] = []
    let inFence = false
    let offset = 0
    for (const line of text.split('\n')) {
        if (FENCE.test(line)) {
            inFence = !inFence
        } else if (!inFence) {
            const match = ATX.exec(line)
            if (match?.[1] !== undefined) {
                headings.push({
                    level: match[1].length,
                    start: offset,
                    end: offset + line.length
                })
            }
        }
        offset += line.length + 1
    }
    return headings
}

/**
 * Where "Expand section" inserts: the end of the last non-blank line of the
 * section containing `offset` — never past the next heading, and trailing
 * blank lines are stepped back over so the caret sits where the section's
 * prose actually ends (the same place a writer would put the cursor to keep
 * typing). An empty section (heading directly followed by the next heading)
 * answers the end of its own heading line.
 */
export function sectionInsertionPoint(text: string, offset: number): number {
    const clamped = Math.max(0, Math.min(offset, text.length))
    const headings = headingLines(text)
    // The governing heading: the last one starting at or before the offset.
    // An offset ON a heading line governs that heading's own section.
    let governing: HeadingLine | null = null
    for (const heading of headings) {
        if (heading.start <= clamped) {
            governing = heading
        } else {
            break
        }
    }
    // The boundary: the next heading that CLOSES the section — same or
    // higher level after the governing one; with no governing heading (the
    // preamble), any heading closes it.
    let boundary = text.length
    for (const heading of headings) {
        if (governing === null) {
            boundary = heading.start
            break
        }
        if (heading.start > governing.start && heading.level <= governing.level) {
            boundary = heading.start
            break
        }
    }
    // Step back over trailing whitespace so the insertion point ends the
    // section's content rather than floating between blank lines.
    let point = boundary
    while (point > 0 && /\s/.test(text.charAt(point - 1))) {
        point -= 1
    }
    // Never before the governing heading's own line end (empty section), and
    // never before the start of the preamble.
    const floor = governing ? governing.end : 0
    return Math.max(point, Math.min(floor, text.length))
}
