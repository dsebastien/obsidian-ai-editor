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
const REFERENCES_HEADING = /^(#{1,6})[ \t]+References[ \t]*$/im

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

/**
 * Escape regex special characters (issue #30, dedup detection). Used to safely
 * construct regexes from user data without injection risk.
 */
function escapeRegex(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Determines whether a source has already been added to the note (issue #30).
 * Returns the placement type if found, or null if not yet added.
 *
 * Matching rule — always the EXACT `formatReference()` rendering, never loose
 * body text:
 * - Footnote: `^[rendered]` anywhere in the note. This applies to URL-less
 *   sources too (their rendering is the bare flattened title) because the
 *   card's Add menu offers "Add as footnote" for any anchored source, URL or
 *   not — skipping the check would let the same source be footnoted twice.
 * - References section: the rendering as a full bullet line. Exactness keeps
 *   a bare title mention in body prose from counting as added.
 *
 * Edge cases:
 * - Title brackets are flattened per formatReference(), so match against flattened title.
 * - References section is identified by regex for ATX heading "References";
 *   extraction stops at next same-level or higher heading, or EOF.
 * - Footnotes are identified by regex `/\^\[[^\]]*\]/i`.
 */
export function getSourceAddedPlacement(
    text: string,
    source: Pick<Evidence, 'title' | 'url'>
): 'footnote' | 'section' | null {
    const rendered = formatReference(source)
    const escapedRendered = escapeRegex(rendered)

    // Check for existing footnote: match `^[rendered]` (case-insensitive)
    const footnoteRegex = new RegExp(`\\^\\[${escapedRendered}\\]`, 'i')
    if (footnoteRegex.test(text)) {
        return 'footnote'
    }

    // Check for References section bullet
    const refsHeadingMatch = REFERENCES_HEADING.exec(text)
    if (refsHeadingMatch !== null) {
        const headingIndex = refsHeadingMatch.index
        const headingLength = refsHeadingMatch[0].length
        const refsStart = headingIndex + headingLength
        const headingLevel = refsHeadingMatch[1]?.length ?? 6

        // The section runs until the next SAME-LEVEL-OR-HIGHER heading, or EOF;
        // deeper subsections (e.g. `###` under `## References`) stay inside it.
        // The mandatory space after the hashes stops `#{1,level}` from matching
        // the leading hashes of a deeper heading.
        const nextHeadingMatch = text
            .slice(refsStart)
            .match(new RegExp(`\\n#{1,${headingLevel}}[ \\t]+\\S`))
        const refsEnd = nextHeadingMatch
            ? refsStart + nextHeadingMatch.index! + 1 // Start of newline before next heading
            : text.length
        const refsSection = text.slice(refsStart, refsEnd)

        // Match as a bullet line: `- rendered` (case-insensitive)
        const bulletRegex = new RegExp(`^\\s*-\\s+${escapedRendered}\\s*$`, 'im')
        if (bulletRegex.test(refsSection)) {
            return 'section'
        }
    }

    return null
}

/**
 * Simple boolean wrapper around getSourceAddedPlacement (issue #30).
 * Returns true if the source has already been added to the note in any form.
 */
export function isSourceAlreadyAdded(
    text: string,
    source: Pick<Evidence, 'title' | 'url'>
): boolean {
    return getSourceAddedPlacement(text, source) !== null
}
