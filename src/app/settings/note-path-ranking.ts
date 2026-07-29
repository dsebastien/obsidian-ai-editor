/**
 * Pure ranking for the note-path autocomplete (no Obsidian imports so the
 * scoring is spec-coverable). The suggester glue in `note-path-suggest.ts`
 * feeds it the vault's markdown paths.
 */

/** How strongly a path matches; higher wins. Exported for specs. */
export type MatchTier = 'basename-prefix' | 'basename-substring' | 'path-substring' | 'none'

const TIER_ORDER: Record<Exclude<MatchTier, 'none'>, number> = {
    'basename-prefix': 0,
    'basename-substring': 1,
    'path-substring': 2
}

export function basenameOf(path: string): string {
    const slash = path.lastIndexOf('/')
    const name = slash === -1 ? path : path.slice(slash + 1)
    return name.toLowerCase().endsWith('.md') ? name.slice(0, -3) : name
}

export function matchTier(query: string, path: string): MatchTier {
    const needle = query.trim().toLowerCase()
    if (needle.length === 0) {
        // Empty query: everything matches weakly so the popover can show
        // recent/alphabetical notes as soon as the field is focused.
        return 'path-substring'
    }
    const base = basenameOf(path).toLowerCase()
    if (base.startsWith(needle)) {
        return 'basename-prefix'
    }
    if (base.includes(needle)) {
        return 'basename-substring'
    }
    if (path.toLowerCase().includes(needle)) {
        return 'path-substring'
    }
    return 'none'
}

/**
 * Ranks candidate note paths for a query: basename prefix matches first,
 * then basename substrings, then anywhere-in-path matches; alphabetical by
 * basename within a tier. `exclude` drops already-referenced paths so the
 * popover never offers a duplicate.
 */
export function rankNotePaths(
    query: string,
    paths: readonly string[],
    options: { exclude?: ReadonlySet<string>; limit?: number } = {}
): string[] {
    const limit = options.limit ?? 50
    const exclude = options.exclude
    const scored: { path: string; tier: number; base: string }[] = []
    for (const path of paths) {
        if (exclude?.has(path)) {
            continue
        }
        const tier = matchTier(query, path)
        if (tier === 'none') {
            continue
        }
        scored.push({ path, tier: TIER_ORDER[tier], base: basenameOf(path).toLowerCase() })
    }
    scored.sort((a, b) => a.tier - b.tier || a.base.localeCompare(b.base))
    return scored.slice(0, limit).map((entry) => entry.path)
}
