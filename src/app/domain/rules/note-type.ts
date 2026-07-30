import { anyTagMatches, folderContainsPath } from './matchers'

/**
 * Note-type identity (plan §4b "Note-type awareness").
 *
 * A note can be recognized as a "note type" two ways, and BOTH are pure
 * functions of facts the plugin already has:
 *
 * 1. **The tag convention** (always available, no dependency): Obsidian
 *    Starter Kit vaults tag notes `type/<something>` (`type/permanent_note`,
 *    `type/task`). Every such tag yields one identifier.
 * 2. **The OSK registry** (optional): when the Obsidian Starter Kit plugin is
 *    installed, its note-type list carries each type's display NAME plus the
 *    mappings it recognizes notes by (tag / folder / filename regex). Matching
 *    a note against those mappings yields the canonical type name as an
 *    identifier.
 *
 * The two produce different strings for the same type — OSK names types
 * `Personal Notes` while tagging them `type/personal` — so a note's identity
 * is a SET of identifiers and a rule matches when it names ANY of them. That
 * keeps a rule written against the canonical name working with the plugin
 * installed, and a rule written against the tag working without it, instead of
 * guessing a singular/plural mapping between the two.
 *
 * Deliberately NOT used: the Starter Kit's own `recognizeNoteType` API. It is
 * asynchronous, and every consumer of this module is a synchronous decision
 * (context menu construction, command gates, rail rendering) that cannot await
 * a cross-plugin call. Its inputs — the type list and the note's tags/path —
 * are available synchronously, so recognition happens here, pure and
 * spec-covered. Nothing in the plugin depends on the Starter Kit being
 * installed: an empty registry simply falls back to the tag convention.
 */

/** Tag prefix the note-type convention uses (`type/permanent_note`). */
export const NOTE_TYPE_TAG_PREFIX = 'type/'

/**
 * Comparison key for a note-type name, tag segment, or rule value: lowercased,
 * with every run of non-alphanumeric characters collapsed to a single hyphen.
 * `Personal Notes`, `personal-notes` and `Personal_Notes` all become
 * `personal-notes`. Returns `''` for values with nothing to compare.
 */
export function normalizeNoteTypeId(raw: string): string {
    return raw
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
}

/**
 * Identifiers derived from the tag convention: one per `type/<x>` tag, in tag
 * order, deduplicated. Tags are expected without `#` (as `NoteMetadata.tags`
 * provides them) but a leading `#` is tolerated.
 */
export function noteTypeIdsFromTags(tags: readonly string[]): string[] {
    const ids: string[] = []
    for (const raw of tags) {
        const tag = raw.trim().replace(/^#/, '').toLowerCase()
        if (!tag.startsWith(NOTE_TYPE_TAG_PREFIX)) {
            continue
        }
        const id = normalizeNoteTypeId(tag.slice(NOTE_TYPE_TAG_PREFIX.length))
        if (id.length > 0 && !ids.includes(id)) {
            ids.push(id)
        }
    }
    return ids
}

// ---------------------------------------------------------------------------
// Optional OSK registry
// ---------------------------------------------------------------------------

/**
 * One recognition mapping of an OSK note type. `type` is intentionally widened
 * to `string`: the Starter Kit's API has no version guarantee and ships kinds
 * this plugin cannot evaluate (`formula`), which are ignored rather than
 * guessed at.
 */
export interface OskNoteTypeMapping {
    readonly type: string
    readonly value: string
    readonly enabled: boolean
}

/** One OSK note type, reduced to what recognition needs. */
export interface OskNoteType {
    readonly name: string
    readonly mappings: readonly OskNoteTypeMapping[]
}

/** File name without its extension (`Notes/My Note.md` → `My Note`). */
function baseName(path: string): string {
    const fileName = path.split('/').pop() ?? path
    const dot = fileName.lastIndexOf('.')
    return dot > 0 ? fileName.slice(0, dot) : fileName
}

/** Whether one enabled mapping recognizes the note. */
function mappingMatches(
    mapping: OskNoteTypeMapping,
    facts: { readonly path: string; readonly tags: readonly string[] }
): boolean {
    if (!mapping.enabled || mapping.value.trim().length === 0) {
        return false
    }
    switch (mapping.type) {
        case 'tag':
            return anyTagMatches(mapping.value, facts.tags)
        case 'folder':
            return folderContainsPath(mapping.value, facts.path)
        case 'regex':
            // User-authored pattern from another plugin's settings: an invalid
            // regex must never take down a menu build.
            try {
                return new RegExp(mapping.value).test(baseName(facts.path))
            } catch {
                return false
            }
        default:
            // `formula` and anything a future Starter Kit adds: not evaluable
            // here, so it never recognizes anything.
            return false
    }
}

/**
 * Identifiers from the OSK registry: the normalized NAME of every type at
 * least one of whose enabled mappings recognizes the note, in registry order.
 * An empty registry (plugin absent or its API unavailable) yields `[]`.
 */
export function noteTypeIdsFromRegistry(
    facts: { readonly path: string; readonly tags: readonly string[] },
    registry: readonly OskNoteType[]
): string[] {
    const ids: string[] = []
    for (const noteType of registry) {
        const id = normalizeNoteTypeId(noteType.name)
        if (id.length === 0 || ids.includes(id)) {
            continue
        }
        if (noteType.mappings.some((mapping) => mappingMatches(mapping, facts))) {
            ids.push(id)
        }
    }
    return ids
}

/**
 * The note's full type identity: registry names first (the authoritative
 * source when the Starter Kit is installed), then the tag-convention
 * identifiers, deduplicated. Both are always included — a rule may legitimately
 * be written against either spelling, and the tag convention keeps working when
 * the registry does not list a type the note is tagged with.
 */
export function resolveNoteTypeIds(
    facts: { readonly path: string; readonly tags: readonly string[] },
    registry: readonly OskNoteType[] = []
): string[] {
    const ids = noteTypeIdsFromRegistry(facts, registry)
    for (const id of noteTypeIdsFromTags(facts.tags)) {
        if (!ids.includes(id)) {
            ids.push(id)
        }
    }
    return ids
}
