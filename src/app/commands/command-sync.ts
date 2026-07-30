/**
 * Shared diffing for DYNAMIC command registration (design doc "Interaction
 * surfaces" §3): every dynamic family (per-action commands, per-editor bulk
 * triage commands) derives a desired command set from the settings and syncs
 * it against what is currently registered whenever the settings mutate.
 *
 * The rules are the same for every family, so they live here once:
 * - an id that is no longer desired is removed;
 * - a new id is added;
 * - an id whose palette NAME changed is re-added under the UNCHANGED id
 *   (`addCommand` replaces in place, so user hotkeys survive renames);
 * - an unrelated settings mutation produces an empty diff (no churn).
 */

/** Minimum shape of a desired command: a stable id and a palette name. */
export interface CommandView {
    readonly id: string
    readonly name: string
}

export interface CommandDiff<T extends CommandView> {
    /** Commands to (re)register: new ids, or a known id with a new name. */
    readonly add: readonly T[]
    /** Command ids to remove. */
    readonly remove: readonly string[]
}

/** Diffs the registered command set (id → palette name) against the desired one. */
export function diffCommands<T extends CommandView>(
    registered: ReadonlyMap<string, string>,
    desired: readonly T[]
): CommandDiff<T> {
    const desiredIds = new Set(desired.map((command) => command.id))
    const remove = [...registered.keys()].filter((id) => !desiredIds.has(id))
    const add = desired.filter((command) => registered.get(command.id) !== command.name)
    return { add, remove }
}
