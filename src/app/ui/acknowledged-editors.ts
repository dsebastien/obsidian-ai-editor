import type { EditorRunState } from '../services/orchestration/run-controller'
import type { FindingStore } from '../services/orchestration/finding-store'

/**
 * "All good" acknowledgements (issue #24): with several editors enabled, the
 * panel fills with clean sections and the findings that need attention get
 * pushed down. Ticking a clean editor off hides its section — until that
 * editor has something NEW to say.
 *
 * Rules (pure, spec-pinned here; the controller owns the per-note store and
 * the panel renders off it):
 *
 * - Acknowledgeable = settled (`done`, not mid-continuation) with NO live
 *   (open/preview) findings. Zero findings and all-triaged both qualify —
 *   the user has dealt with everything the editor had. The severity filter
 *   is a view lens and deliberately does NOT make a section acknowledgeable.
 * - An acknowledgement CLEARS the moment the editor has live findings again
 *   (`pruneAcknowledged`) — hiding a later, non-empty result would hide real
 *   feedback. With cross-run carryover (#19) this is exactly "new findings":
 *   a re-run that stays clean keeps the acknowledgement (no flicker back for
 *   the same answer); adopted-but-dismissed findings stay non-live.
 * - Manual, never automatic; per note + per editor; session-only.
 */

/** Whether `state`'s section may be acknowledged (or stay acknowledged). */
export function isSettledClean(state: EditorRunState, findings: FindingStore): boolean {
    if (state.status !== 'done' || state.continuing) {
        return false
    }
    return !state.findingIds.some((id) => {
        const finding = findings.get(id)
        return finding !== null && (finding.status === 'open' || finding.status === 'preview')
    })
}

/**
 * Drops acknowledgements whose editor has live findings again (in place).
 * Deliberately keyed on LIVE findings, not on run status: an acknowledged
 * editor that is re-running stays hidden until something actually arrives.
 */
export function pruneAcknowledged(
    acknowledged: Set<string>,
    states: readonly EditorRunState[],
    findings: FindingStore
): void {
    for (const state of states) {
        if (!acknowledged.has(state.editorId)) {
            continue
        }
        const hasLive = state.findingIds.some((id) => {
            const finding = findings.get(id)
            return finding !== null && (finding.status === 'open' || finding.status === 'preview')
        })
        if (hasLive) {
            acknowledged.delete(state.editorId)
        }
    }
}
