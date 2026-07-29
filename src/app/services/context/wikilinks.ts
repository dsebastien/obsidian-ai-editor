/**
 * Wikilink extraction from prompt text fields.
 *
 * Recognized forms: `[[Target]]`, `[[Target|alias]]`, `[[Target#Heading]]`,
 * `[[Target#^block]]`, and combinations (`[[Target#H|alias]]`). Only the
 * target note name is returned — heading/block fragments and aliases are
 * stripped. Embeds (`![[Target]]`) are treated as references too.
 *
 * Documented simplification: code fences and inline code are NOT skipped —
 * a `[[link]]` inside a fenced block is still extracted. Prompt fields are
 * short user-authored text where fenced wikilinks are overwhelmingly
 * intentional; exclusions and the send-preview still gate what actually
 * ships, so the worst case of the simplification is one extra previewable
 * attachment, not a leak.
 */

const WIKILINK_PATTERN = /\[\[([^[\]]+)\]\]/g

/**
 * Extracts wikilink targets from `text`: target note names only, first cut
 * at `|` (alias) then at `#` (heading/block), trimmed. Duplicates are
 * removed; first-occurrence order is preserved. Same-note references
 * (`[[#Heading]]`) and empty targets are skipped.
 */
export function extractWikilinks(text: string): string[] {
    const seen = new Set<string>()
    const targets: string[] = []
    for (const match of text.matchAll(WIKILINK_PATTERN)) {
        const inner = match[1]
        if (inner === undefined) {
            continue
        }
        const withoutAlias = inner.split('|')[0] ?? ''
        const target = (withoutAlias.split('#')[0] ?? '').trim()
        if (target.length === 0 || seen.has(target)) {
            continue
        }
        seen.add(target)
        targets.push(target)
    }
    return targets
}
