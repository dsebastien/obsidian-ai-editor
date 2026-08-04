import type { Evidence } from './operations/contract'
import { sectionInsertionPoint } from './sections'

/**
 * Reference writing for "Find references" (issue #30): pure text math for
 * the two Add gestures on a source — an inline footnote at the claim, or a
 * bullet under the note's References section. The card only offers these
 * for sources the editor actually consulted (`verified`); formatting and
 * placement live here so they are testable without an editor.
 */

/**
 * One source, as markdown: a link when it has a URL, the bare title
 * otherwise. Square brackets inside the title would break the link syntax
 * (and the inline-footnote syntax around it), so they are flattened.
 */
export function formatReference(evidence: Pick<Evidence, 'title' | 'url'>): string {
    const title = evidence.title.replace(/[[\]]/g, '').trim()
    const url = evidence.url?.trim()
    return url !== undefined && url.length > 0 ? `[${title}](${url})` : title
}

/**
 * The inline footnote for a source: Obsidian's `^[…]` form, so there is no
 * label numbering to manage and nothing to append at the bottom of the note.
 * Leading space included — it is appended directly after the claim's span.
 */
export function referenceFootnote(evidence: Pick<Evidence, 'title' | 'url'>): string {
    return ` ^[${formatReference(evidence)}]`
}

/** A heading line whose text is exactly "References" (any ATX level). */
const REFERENCES_HEADING = /^#{1,6}[ \t]+References[ \t]*$/im

/**
 * Where a reference bullet lands, and the text to insert there:
 * - the note has a References heading → a bullet appended at that section's
 *   content end (`sectionInsertionPoint`, so subsections and trailing blank
 *   lines are handled the same way "Expand section" handles them);
 * - no References heading → the section is created at the very end of the
 *   note's content, `## References` with the first bullet under it.
 */
export function referenceSectionInsertion(
    text: string,
    evidence: Pick<Evidence, 'title' | 'url'>
): { readonly offset: number; readonly insert: string } {
    const bullet = `- ${formatReference(evidence)}`
    const match = REFERENCES_HEADING.exec(text)
    if (match !== null) {
        const offset = sectionInsertionPoint(text, match.index)
        return { offset, insert: `\n${bullet}` }
    }
    let end = text.length
    while (end > 0 && /\s/.test(text.charAt(end - 1))) {
        end -= 1
    }
    const lead = end === 0 ? '' : '\n\n'
    return { offset: end, insert: `${lead}## References\n\n${bullet}` }
}
