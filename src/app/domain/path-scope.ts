/**
 * Vault-path scoping for rename/delete bookkeeping.
 *
 * Obsidian's `rename` and `delete` vault events fire for the entity the user
 * acted on — and for a FOLDER it does not necessarily emit a per-child event.
 * So every map keyed by note path has to answer the same question twice: is
 * this key the path that moved, or is it a note UNDER the folder that moved?
 * The margin-comment repository already answers it that way
 * (`comment-repository.ts`); this module makes the rule one implementation
 * instead of a pattern that each new store re-derives.
 *
 * The prefix is `${path}/` and never a bare `startsWith(path)`: `Notes/A.md`
 * must not be swept away by a delete of `Notes/A`.
 */

/** Whether `candidate` IS `path` or lives under it (folder-prefix aware). */
export function isPathUnder(candidate: string, path: string): boolean {
    return candidate === path || candidate.startsWith(`${path}/`)
}

/**
 * `candidate` relocated from under `oldPath` to under `newPath`, or `null` when
 * it was not under `oldPath` at all.
 */
export function remapPathUnder(candidate: string, oldPath: string, newPath: string): string | null {
    if (candidate === oldPath) {
        return newPath
    }
    const prefix = `${oldPath}/`
    return candidate.startsWith(prefix) ? `${newPath}/${candidate.slice(prefix.length)}` : null
}

/**
 * The shape `deleteKeysUnder` needs — satisfied by both `Map<string, …>` and
 * `Set<string>`, which is what per-file bookkeeping is actually made of.
 */
export interface PathKeyedCollection {
    keys(): IterableIterator<string>
    delete(key: string): boolean
}

/**
 * Deletes every key that is `path` or under it, and returns how many went. The
 * keys are collected before deleting: mutating a collection while iterating it
 * is legal but reads as an accident.
 */
export function deleteKeysUnder(collection: PathKeyedCollection, path: string): number {
    const doomed: string[] = []
    for (const key of collection.keys()) {
        if (isPathUnder(key, path)) {
            doomed.push(key)
        }
    }
    for (const key of doomed) {
        collection.delete(key)
    }
    return doomed.length
}
