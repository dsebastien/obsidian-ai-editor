/**
 * Shared path/tag matching primitives for the two rule families that decide
 * what the plugin may touch: privacy exclusions
 * (`services/context/exclusions.ts`, Business Rules #7) and note-type binding
 * rules (`rule-engine.ts`, plan §4b).
 *
 * ONE definition of "this note lives in that folder" and "this note carries
 * that tag", because the two families must never disagree about what a folder
 * or a tag means — a user who excludes `Private` and disables the plugin for
 * `Private` has to get the same set of notes both times.
 *
 * Matching is case-insensitive on both sides: vaults commonly live on
 * case-insensitive filesystems (Windows, macOS default) where `private` and
 * `Private` are the same folder, and Obsidian's own tag matching ignores case.
 */

/** Strips leading/trailing slashes and lowercases (`/Private/` → `private`). */
export function normalizeFolderPath(folder: string): string {
    return folder
        .trim()
        .replace(/^\/+|\/+$/g, '')
        .toLowerCase()
}

/**
 * Whether `path` lives under `folder` — full path-SEGMENT prefix match, so
 * `Private` contains `Private/a.md` but never `Private stuff/a.md`. The folder
 * path itself counts as contained (a folder note).
 *
 * A folder that normalizes to nothing (`''`, `/`) matches NOTHING here: the
 * two callers disagree about what the vault root should mean (an exclusion
 * with a blank folder is a data-entry accident, a binding rule on `/` is a
 * deliberate vault-wide rule), so each decides for itself.
 */
export function folderContainsPath(folder: string, path: string): boolean {
    const normalized = normalizeFolderPath(folder)
    if (normalized.length === 0) {
        return false
    }
    const lowered = path.toLowerCase()
    return lowered === normalized || lowered.startsWith(`${normalized}/`)
}

/** Strips a leading `#` and lowercases (`#Private` → `private`). */
export function normalizeTagName(tag: string): string {
    const trimmed = tag.trim()
    return (trimmed.startsWith('#') ? trimmed.slice(1) : trimmed).toLowerCase()
}

/**
 * Whether `tag` equals `pattern` or nests under it (`private` matches
 * `private/journal`). A pattern that normalizes to nothing matches nothing.
 */
export function tagMatchesOrNests(pattern: string, tag: string): boolean {
    const normalizedPattern = normalizeTagName(pattern)
    if (normalizedPattern.length === 0) {
        return false
    }
    const normalizedTag = normalizeTagName(tag)
    return normalizedTag === normalizedPattern || normalizedTag.startsWith(`${normalizedPattern}/`)
}

/** Whether any of `tags` equals `pattern` or nests under it. */
export function anyTagMatches(pattern: string, tags: readonly string[]): boolean {
    return tags.some((tag) => tagMatchesOrNests(pattern, tag))
}
