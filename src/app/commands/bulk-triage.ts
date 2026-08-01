import type { FindingStatus } from '../services/orchestration/finding-store'
import type { EditChange, TrackedEdit } from '../domain/operations/edit-apply'
import { changesConflict, editsApplicable, planEditChanges } from '../domain/operations/edit-apply'

/**
 * Pure planning logic for bulk triage (plan M4 "Bulk triage": per-editor
 * accept/dismiss-all, accept-all-non-conflicting as ONE undoable
 * transaction). The glue supplies the candidate findings (already narrowed to
 * the editor and to what the severity filter shows) plus the CURRENT document
 * text; these functions decide what can be applied, what must be skipped and
 * why, and how to word the outcome.
 *
 * Contract v2: a finding's proposal is a SET of edits, applied all-or-nothing
 * (design doc §4) — so the planning unit is the finding, and a finding whose
 * edit-set overlaps an earlier planned finding's is skipped WHOLE. Business
 * Rules #2/#3 are enforced here as well as in the store: every edit must
 * still verify against the live text (`planEditChanges`), and overlapping
 * proposals never both apply — the earlier one wins, the later one is
 * reported as skipped so the user knows to re-review that span.
 */

/**
 * Structural subset of `TrackedFinding` the bulk planner needs (a
 * `TrackedFinding` satisfies it as-is).
 */
export interface BulkCandidateFinding {
    readonly id: string
    readonly status: FindingStatus
    readonly edits: readonly TrackedEdit[]
}

/** One planned finding: its full change set, in CURRENT document coordinates. */
export interface BulkAcceptFinding {
    readonly findingId: string
    /** Sorted, mutually conflict-free (guaranteed by `planEditChanges`). */
    readonly changes: readonly EditChange[]
}

export interface BulkAcceptPlan {
    /**
     * The findings to apply, in document order. The concatenation of their
     * `changes` (already sorted, mutually non-overlapping across findings) is
     * dispatchable as ONE CM6 transaction (single undo step) because every
     * offset refers to the same pre-transaction document.
     */
    readonly findings: readonly BulkAcceptFinding[]
    /** Findings dropped because an earlier planned finding covers their span. */
    readonly skippedOverlapping: number
    /**
     * Findings whose proposal no longer matches the live text (edited since
     * the run, or an anchor went stale) — never fuzzy-relocated (BR #3).
     */
    readonly skippedChanged: number
}

/**
 * Whether a finding could be accepted at all, ignoring the document text:
 * non-terminal, with every edit anchored and mutually conflict-free.
 * Deliberately mirrors `FindingStore.isActionable` — the panel's "Accept all
 * (n)" count and this planner must advertise the same set (pinned by spec).
 */
export function isBulkAcceptable(finding: BulkCandidateFinding): boolean {
    if (finding.status !== 'open' && finding.status !== 'preview') {
        return false
    }
    return editsApplicable(finding.edits)
}

/**
 * Plans "accept all non-conflicting" over the candidates: every acceptable
 * finding whose full edit plan verifies against `currentText`, in document
 * order, skipping any finding whose changes overlap an already-planned one.
 *
 * Findings that are not acceptable by shape (terminal, unanchored,
 * conflicting or empty proposal) are ignored silently — they were never
 * offered. Adjacent spans (`from === previous.to`) do NOT conflict: CM6
 * accepts touching changes in one transaction. Two zero-width insertions at
 * the same position DO (their order would be arbitrary — same rule as inside
 * one finding).
 */
export function planBulkAccept(
    candidates: readonly BulkCandidateFinding[],
    currentText: string
): BulkAcceptPlan {
    const planned: { findingId: string; changes: readonly EditChange[] }[] = []
    let skippedChanged = 0
    for (const finding of candidates) {
        if (!isBulkAcceptable(finding)) {
            continue
        }
        const plan = planEditChanges(finding.edits, currentText)
        if (!plan.ok) {
            // `editsApplicable` passed, so the only live-text failure left is
            // the precondition (BR #3) — count it for the Notice.
            skippedChanged += 1
            continue
        }
        planned.push({ findingId: finding.id, changes: plan.changes })
    }
    // Document order, then resolve cross-finding overlaps: earlier wins, and
    // the conflict rule is the SAME one edits within a finding obey
    // (`changesConflict`) — touching is fine, overlap and same-position
    // zero-width insertions are not.
    planned.sort(
        (a, b) =>
            firstFrom(a.changes) - firstFrom(b.changes) ||
            (a.findingId < b.findingId ? -1 : a.findingId > b.findingId ? 1 : 0)
    )
    const findings: BulkAcceptFinding[] = []
    const accepted: EditChange[] = []
    let skippedOverlapping = 0
    for (const candidate of planned) {
        if (changesConflict([...accepted, ...candidate.changes])) {
            skippedOverlapping += 1
            continue
        }
        findings.push(candidate)
        accepted.push(...candidate.changes)
    }
    return { findings, skippedOverlapping, skippedChanged }
}

function firstFrom(changes: readonly EditChange[]): number {
    return changes.reduce((min, change) => Math.min(min, change.from), Number.MAX_SAFE_INTEGER)
}

/** The findings a "dismiss all" applies to: every non-terminal candidate. */
export function dismissableFindingIds(
    candidates: readonly BulkCandidateFinding[]
): readonly string[] {
    return candidates
        .filter((finding) => finding.status === 'open' || finding.status === 'preview')
        .map((finding) => finding.id)
}

/**
 * One-line outcome for the bulk accept Notice. `applied` is what actually
 * reached the document (the store re-verifies each precondition, so it can be
 * smaller than the plan); the plan's skip counts explain the rest.
 */
export function bulkAcceptNotice(applied: number, plan: BulkAcceptPlan): string {
    const skippedChanged = plan.skippedChanged + (plan.findings.length - applied)
    const reasons: string[] = []
    if (plan.skippedOverlapping > 0) {
        reasons.push(`${plan.skippedOverlapping} overlapping`)
    }
    if (skippedChanged > 0) {
        reasons.push(`${skippedChanged} no longer matching the text`)
    }
    const tail = reasons.length > 0 ? ` Skipped ${reasons.join(' and ')}.` : ''
    if (applied === 0) {
        return `Nothing to apply.${tail}`
    }
    return `Applied ${countLabel(applied)}.${tail}`
}

/** One-line outcome for the bulk dismiss Notice. */
export function bulkDismissNotice(dismissed: number): string {
    return dismissed === 0 ? 'Nothing to dismiss.' : `Dismissed ${countLabel(dismissed)}.`
}

function countLabel(count: number): string {
    return count === 1 ? '1 finding' : `${count} findings`
}
