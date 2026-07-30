/**
 * The single seam between context assembly and the vault. Implemented in the
 * ui layer on top of Obsidian's `Vault`/`MetadataCache`; the services layer
 * only ever sees this interface, keeping context assembly Obsidian-free and
 * unit-testable with an in-memory fake.
 */

/** Cached metadata of a note, as needed by the privacy-exclusion rules. */
export interface NoteMetadata {
    /** All tags of the note (frontmatter + inline), with or without `#`. */
    readonly tags: string[]
    /** Frontmatter key/value pairs; values are untrusted user data. */
    readonly frontmatter: Record<string, unknown>
}

export interface VaultReader {
    /**
     * Reads a note's full raw markdown by vault-relative path. Resolves to
     * `null` when the file does not exist or cannot be read — callers must
     * skip gracefully, never throw a run away over one missing note.
     */
    readNote(path: string): Promise<string | null>

    /**
     * Resolves wikilink target text (e.g. `My Note` from `[[My Note]]`) to a
     * vault-relative path, using `fromPath` for Obsidian's relative-link
     * resolution rules. Returns `null` for unresolvable links.
     */
    resolveLink(linkText: string, fromPath: string): string | null

    /**
     * Vault-relative paths of the notes the given note links to (1 hop,
     * outgoing only, already resolved). Unresolvable links are omitted.
     */
    getOutgoingLinks(path: string): string[]

    /**
     * Metadata used by exclusion checks. `null` when the note does not exist
     * or has no cache entry yet — exclusion then falls back to path-only
     * checks.
     */
    getNoteMetadata(path: string): NoteMetadata | null

    /**
     * Note-type identifiers of the note (plan §4b), for binding rules that
     * match on a note type: the OSK registry's canonical names when the
     * Obsidian Starter Kit plugin is installed, plus the `type/<x>` tag
     * convention, which needs no plugin. `[]` when the note has no recognizable
     * type — see `domain/rules/note-type.ts`.
     *
     * Resolving these means a cross-plugin call, so callers ask only when a
     * rule actually matches on note types (`rulesNeedNoteTypes`); everything
     * else passes `[]`.
     */
    getNoteTypeIds(path: string): readonly string[]
}
