import { verifyPrecondition } from '../domain/anchoring/anchor'
import type { AnchorState } from '../domain/anchoring/anchor'
import type { FindingStatus } from '../services/orchestration/finding-store'

/**
 * Pure planning logic for bulk triage (plan M4 "Bulk triage": per-editor
 * accept/dismiss-all, accept-all-non-conflicting as ONE undoable
 * transaction). The glue supplies the candidate findings (already narrowed to
 * the editor and to what the severity filter shows) plus the CURRENT document
 * text; these functions decide what can be applied, what must be skipped and
 * why, and how to word the outcome.
 *
 * Business Rules #2/#3 are enforced here as well as in the store: a
 * suggestion is only planned when the live document still contains exactly
 * the anchored text (`verifyPrecondition`), and overlapping suggestions never
 * both apply — the earlier anchor wins, the later one is reported as skipped
 * so the user knows to re-review that span.
 */

/**
 * Structural subset of `TrackedFinding` the bulk planner needs (a
 * `TrackedFinding` satisfies it as-is).
 */
export interface BulkCandidateFinding {
    readonly id: string
    readonly status: FindingStatus
    readonly anchor: {
        readonly from: number
        readonly to: number
        readonly state: AnchorState
    } | null
    /** Snapshot text at the anchor — the accept precondition. */
    readonly anchoredText: string | null
    readonly raw: { readonly suggestion?: string | undefined }
}

/** One planned replacement, in CURRENT document coordinates. */
export interface BulkAcceptEdit {
    readonly findingId: string
    readonly from: number
    readonly to: number
    readonly insert: string
}

export interface BulkAcceptPlan {
    /**
     * The edits to dispatch, sorted by position and mutually
     * non-overlapping — dispatchable as ONE CM6 transaction (single undo
     * step) because every offset refers to the same pre-transaction document.
     */
    readonly edits: readonly BulkAcceptEdit[]
    /** Findings dropped because an earlier planned edit covers their span. */
    readonly skippedOverlapping: number
    /**
     * Findings whose suggestion no longer matches the live text (edited since
     * the run, or the anchor went stale) — never fuzzy-relocated (BR #3).
     */
    readonly skippedChanged: number
}

/**
 * Whether a finding could be accepted at all, ignoring the document text:
 * non-terminal, anchored, not stale, and carrying a suggestion. Deliberately
 * mirrors `FindingStore.isActionable` — the panel's "Accept all (n)" count
 * and this planner must advertise the same set (pinned by spec).
 */
export function isBulkAcceptable(finding: BulkCandidateFinding): boolean {
    if (finding.status !== 'open' && finding.status !== 'preview') {
        return false
    }
    if (finding.anchor === null || finding.anchor.state !== 'anchored') {
        return false
    }
    if (finding.anchoredText === null) {
        return false
    }
    const suggestion = finding.raw.suggestion
    return typeof suggestion === 'string' && suggestion.length > 0
}

/**
 * Plans "accept all non-conflicting" over the candidates: every acceptable
 * finding whose precondition holds against `currentText`, in document order,
 * skipping any whose span overlaps an already-planned edit.
 *
 * Findings that are not acceptable by shape (terminal, unanchored, no
 * suggestion) are ignored silently — they were never offered. Adjacent spans
 * (`from === previous.to`) do NOT conflict: CM6 accepts touching changes in
 * one transaction.
 */
export function planBulkAccept(
    candidates: readonly BulkCandidateFinding[],
    currentText: string
): BulkAcceptPlan {
    const acceptable = candidates.filter(isBulkAcceptable).sort(byPosition)
    const edits: BulkAcceptEdit[] = []
    let skippedOverlapping = 0
    let skippedChanged = 0
    let lastTo = -1
    for (const finding of acceptable) {
        // Both are non-null for acceptable findings; narrowed for the compiler.
        const anchor = finding.anchor
        const anchoredText = finding.anchoredText
        const insert = finding.raw.suggestion
        if (anchor === null || anchoredText === null || insert === undefined) {
            continue
        }
        if (!verifyPrecondition(currentText, anchor, anchoredText)) {
            skippedChanged += 1
            continue
        }
        if (anchor.from < lastTo) {
            skippedOverlapping += 1
            continue
        }
        edits.push({ findingId: finding.id, from: anchor.from, to: anchor.to, insert })
        lastTo = anchor.to
    }
    return { edits, skippedOverlapping, skippedChanged }
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
    const skippedChanged = plan.skippedChanged + (plan.edits.length - applied)
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

function byPosition(a: BulkCandidateFinding, b: BulkCandidateFinding): number {
    const aAnchor = a.anchor
    const bAnchor = b.anchor
    if (!aAnchor || !bAnchor) {
        return 0
    }
    return (
        aAnchor.from - bAnchor.from ||
        aAnchor.to - bAnchor.to ||
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
    )
}
