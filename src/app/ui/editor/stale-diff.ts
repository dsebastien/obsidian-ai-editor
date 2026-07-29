/**
 * Pure newly-stale detection for the incremental stale-marking path (M3).
 *
 * `ReviewController.handleEditorUpdate` forwards each edit batch to the run's
 * `FindingStore` (the staleness authority), then needs to know which findings
 * TRANSITIONED to stale as a result — exactly those ids are dispatched as a
 * `markStaleEffect` so the highlight dims while the user types, without
 * waiting for the deferred full decoration rebuild. The detection is a plain
 * before/after set diff over the store's anchor states, kept here so it is
 * spec-coverable without CM6 or Obsidian.
 */

import type { AnchorState } from '../../domain/anchoring/anchor'

/**
 * Structural subset of `TrackedFinding` this module needs — `FindingStore`
 * listings can be passed as-is.
 */
export interface StaleDiffFinding {
    readonly id: string
    readonly anchor: { readonly state: AnchorState } | null
}

/** Ids of the findings whose anchor is currently stale. */
export function staleIds(findings: readonly StaleDiffFinding[]): ReadonlySet<string> {
    const ids = new Set<string>()
    for (const finding of findings) {
        if (finding.anchor?.state === 'stale') {
            ids.add(finding.id)
        }
    }
    return ids
}

/**
 * Ids stale in `after` that were not stale in `staleBefore` — the findings
 * that transitioned during the edit batch, i.e. the `markStaleEffect`
 * payload. Order follows `after` (the store's arrival order).
 */
export function newlyStaleIds(
    staleBefore: ReadonlySet<string>,
    after: readonly StaleDiffFinding[]
): string[] {
    const ids: string[] = []
    for (const finding of after) {
        if (finding.anchor?.state === 'stale' && !staleBefore.has(finding.id)) {
            ids.push(finding.id)
        }
    }
    return ids
}
