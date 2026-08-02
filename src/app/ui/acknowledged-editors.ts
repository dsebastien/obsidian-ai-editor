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
 * Drops acknowledgements whose editor has something NEW to show (in place):
 *
 * - LIVE (open/preview) findings — the "until it comes back" contract;
 * - a terminal FAILURE (`error`/`cancelled`) — an acknowledged section that
 *   kept hiding a failed re-run would suppress the error and its Retry
 *   control behind an "all good" label (adversarial review, 2026-08-02).
 *
 * A RUNNING re-run keeps the acknowledgement: hiding stays stable until
 * something actually arrives (no flicker for a still-clean answer).
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
        if (state.status === 'error' || state.status === 'cancelled') {
            acknowledged.delete(state.editorId)
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
