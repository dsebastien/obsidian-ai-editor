import { anyTagMatches, folderContainsPath, normalizeTagName } from '../../domain/rules/matchers'
import type { BehaviorSettings } from '../../domain/settings/settings-schema'
import type { NoteMetadata } from './vault-reader.intf'

/**
 * Privacy exclusions (Business Rules #7): a note excluded by folder, tag, or
 * frontmatter flag is never sent to any backend — not as the review target,
 * not as linked context, not via an explicit wikilink reference. This
 * predicate is the single decision point; every context source must consult
 * it BEFORE reading note content.
 *
 * Folder and tag matching come from `domain/rules/matchers` — the same
 * primitives the note-type binding rules use, so "this note is in that folder"
 * means exactly one thing across the plugin.
 */

/**
 * Whether `path` is excluded from all backend traffic.
 *
 * - Folder: excluded when the path lives under any excluded folder — full
 *   path-segment prefix match (`Private` excludes `Private/a.md`, never
 *   `Private stuff/a.md`), case-insensitive.
 * - Tag: excluded when any note tag equals an excluded tag or is nested
 *   under it (`private` excludes `private/journal`). `#` and case are
 *   ignored on both sides.
 * - Frontmatter: excluded when `ai_editor` is strictly `false` and the
 *   opt-out flag is respected (default). Truthy or absent values never
 *   exclude.
 *
 * `metadata` may be `null` (missing note / cold cache — Obsidian's metadata
 * cache resolves asynchronously after startup). Tag and frontmatter
 * exclusions cannot be evaluated then, so this FAILS CLOSED: when any
 * excluded tag is configured or the frontmatter opt-out is respected, an
 * unresolved note is treated as excluded. Rule #7 is absolute — a transient
 * false-positive exclusion is acceptable, sending a `#private`-tagged note
 * during the cache-warmup window is not.
 */
export function isExcluded(
    path: string,
    metadata: NoteMetadata | null,
    behavior: BehaviorSettings
): boolean {
    for (const folder of behavior.excludedFolders) {
        // A blank excluded folder is a data-entry accident, not "the whole
        // vault": `folderContainsPath` matches nothing for it.
        if (folderContainsPath(folder, path)) {
            return true
        }
    }

    if (!metadata) {
        const hasTagExclusions = behavior.excludedTags.some(
            (tag) => normalizeTagName(tag).length > 0
        )
        return hasTagExclusions || behavior.respectFrontmatterOptOut
    }

    for (const excluded of behavior.excludedTags) {
        if (anyTagMatches(excluded, metadata.tags)) {
            return true
        }
    }

    if (behavior.respectFrontmatterOptOut && metadata.frontmatter['ai_editor'] === false) {
        return true
    }

    return false
}
