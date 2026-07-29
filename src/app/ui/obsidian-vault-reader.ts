import type { App, CachedMetadata, TFile } from 'obsidian'
import type { NoteMetadata, VaultReader } from '../services/context/vault-reader.intf'

/**
 * Obsidian-backed implementation of the `VaultReader` seam (see
 * `services/context/vault-reader.intf.ts`). This is the ONLY place where
 * context assembly touches `Vault`/`MetadataCache`; the services layer stays
 * Obsidian-free and unit-testable.
 *
 * Constraints:
 * - Defensive by contract: no method ever throws. Missing files, cold
 *   metadata caches, and unexpected cache shapes resolve to `null`/`[]` so a
 *   single broken note can never take down a review run.
 * - Markdown only: `readNote` and `getOutgoingLinks` ignore non-`md` files —
 *   binary attachments and canvases are never fed to a backend as text.
 * - All obsidian imports are type-only, so the pure helpers below remain
 *   testable under `bun test` (the `obsidian` package has no runtime).
 */

/**
 * Strips the heading/block fragment from a raw `LinkCache.link` value
 * (`Note#Heading` → `Note`, `Note#^block` → `Note`) and trims. Obsidian's
 * `getFirstLinkpathDest` expects a bare linkpath without subpath. An empty
 * result means a same-note reference (`[[#Heading]]`) — callers skip those.
 */
export function stripSubpath(link: string): string {
    return (link.split('#')[0] ?? '').trim()
}

/**
 * Normalizes one tag value: trims and strips a single leading `#`. Returns
 * `null` for values that normalize to nothing so callers can drop them.
 * Case is preserved — downstream exclusion matching lowercases both sides.
 */
export function normalizeTag(value: string): string | null {
    const trimmed = value.trim()
    const stripped = trimmed.startsWith('#') ? trimmed.slice(1).trim() : trimmed
    return stripped.length === 0 ? null : stripped
}

/**
 * Extracts tags from a frontmatter `tags`/`tag` value, which users write as
 * an array of strings (or numbers — YAML `2024` is a number), a single
 * string, or a comma-separated string. Mirrors Obsidian's own tolerance
 * (`parseFrontMatterTags`). Anything else (objects, booleans, null) yields
 * no tags rather than garbage.
 */
export function frontmatterTagsOf(value: unknown): string[] {
    const entries: unknown[] = Array.isArray(value) ? value : [value]
    const tags: string[] = []
    for (const entry of entries) {
        if (typeof entry === 'number' && Number.isFinite(entry)) {
            const tag = normalizeTag(String(entry))
            if (tag !== null) {
                tags.push(tag)
            }
            continue
        }
        if (typeof entry !== 'string') {
            continue
        }
        for (const part of entry.split(',')) {
            const tag = normalizeTag(part)
            if (tag !== null) {
                tags.push(tag)
            }
        }
    }
    return tags
}

/**
 * Merges inline-body tags (`CachedMetadata.tags`, values like `#topic/sub`)
 * with frontmatter `tags`/`tag` values into one deduplicated, `#`-less list.
 * First-occurrence order is preserved; duplicates collapse exactly (case
 * differences survive — exclusion matching is case-insensitive downstream).
 */
export function collectNoteTags(cache: CachedMetadata): string[] {
    const seen = new Set<string>()
    const tags: string[] = []
    const push = (candidate: string | null): void => {
        if (candidate !== null && !seen.has(candidate)) {
            seen.add(candidate)
            tags.push(candidate)
        }
    }
    for (const inline of cache.tags ?? []) {
        push(normalizeTag(inline.tag))
    }
    const frontmatter = cache.frontmatter
    if (frontmatter) {
        for (const key of ['tags', 'tag']) {
            for (const tag of frontmatterTagsOf(frontmatter[key])) {
                push(tag)
            }
        }
    }
    return tags
}

/** Whether a vault file is a markdown note (the only kind sent to backends). */
function isMarkdown(file: TFile): boolean {
    return file.extension.toLowerCase() === 'md'
}

export class ObsidianVaultReader implements VaultReader {
    constructor(private readonly app: App) {}

    /**
     * Reads a note's raw markdown via `Vault.cachedRead` (no disk hit when
     * the file is already cached). Non-markdown paths, missing files, and
     * read failures all resolve to `null` — never throws.
     */
    async readNote(path: string): Promise<string | null> {
        try {
            const file = this.app.vault.getFileByPath(path)
            if (!file || !isMarkdown(file)) {
                return null
            }
            return await this.app.vault.cachedRead(file)
        } catch {
            return null
        }
    }

    /**
     * Resolves wikilink target text to a vault-relative path using
     * Obsidian's own link-resolution rules (shortest-path, relative,
     * absolute — whatever the vault is configured for). `null` when the
     * link does not resolve.
     */
    resolveLink(linkText: string, fromPath: string): string | null {
        try {
            const linkpath = stripSubpath(linkText)
            if (linkpath.length === 0) {
                return null
            }
            return this.app.metadataCache.getFirstLinkpathDest(linkpath, fromPath)?.path ?? null
        } catch {
            return null
        }
    }

    /**
     * Outgoing links of a note: `links` + `embeds` from the metadata cache,
     * each resolved through `getFirstLinkpathDest`. Markdown targets only,
     * deduplicated, first-occurrence order. Unresolvable links, same-note
     * fragments, and cold caches yield `[]` — never throws.
     */
    getOutgoingLinks(path: string): string[] {
        try {
            const file = this.app.vault.getFileByPath(path)
            if (!file) {
                return []
            }
            const cache = this.app.metadataCache.getFileCache(file)
            if (!cache) {
                return []
            }
            const seen = new Set<string>()
            const paths: string[] = []
            for (const reference of [...(cache.links ?? []), ...(cache.embeds ?? [])]) {
                const linkpath = stripSubpath(reference.link)
                if (linkpath.length === 0) {
                    continue
                }
                const target = this.app.metadataCache.getFirstLinkpathDest(linkpath, path)
                if (!target || !isMarkdown(target) || seen.has(target.path)) {
                    continue
                }
                seen.add(target.path)
                paths.push(target.path)
            }
            return paths
        } catch {
            return []
        }
    }

    /**
     * Metadata for exclusion checks: merged inline + frontmatter tags
     * (without `#`) and the raw frontmatter map. `null` when the file is
     * missing or its cache has not resolved yet — exclusions then FAIL
     * CLOSED per Business Rules #7, so returning `null` here is safe.
     */
    getNoteMetadata(path: string): NoteMetadata | null {
        try {
            const file = this.app.vault.getFileByPath(path)
            if (!file) {
                return null
            }
            const cache = this.app.metadataCache.getFileCache(file)
            if (!cache) {
                return null
            }
            return {
                tags: collectNoteTags(cache),
                frontmatter: cache.frontmatter ? { ...cache.frontmatter } : {}
            }
        } catch {
            return null
        }
    }
}
