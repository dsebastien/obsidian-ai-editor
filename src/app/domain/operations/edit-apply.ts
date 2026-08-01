import type { Anchor } from '../anchoring/anchor'
import { verifyPrecondition } from '../anchoring/anchor'
import type { MatchStrategy } from '../anchoring/match'
import type { EditOp } from './contract'

/**
 * Turning a finding's tracked edits into document changes (contract v2,
 * design doc §4). ONE implementation of the op semantics, the conflict rule
 * and the all-or-nothing plan — shared by the card accept path, the keyboard
 * accept, and the bulk planner, so they can never disagree about what a
 * proposal does.
 *
 * Op semantics, expressed as a CM6-style change over the edit's anchored
 * range `[from, to)`:
 * - `replace`       → `{ from, to, insert: text }`
 * - `delete`        → `{ from, to, insert: '' }`
 * - `insert-before` → `{ from, to: from, insert: text }` (target untouched)
 * - `insert-after`  → `{ from: to, to, insert: text }`   (target untouched)
 *
 * The insert ops are the point of the redesign: adding content no longer
 * requires a replace that swallows the quoted text (#17 symptom 2).
 */

/**
 * One resolved edit of a tracked finding: the validated raw edit's op and
 * text, plus its anchoring outcome. An edit that carried no quote of its own
 * COPIED the finding's anchor at ingestion (design doc §2) — the copies then
 * remap independently through document changes, staying identical while both
 * survive.
 */
export interface TrackedEdit {
    readonly op: EditOp
    /** Content the op applies; `''` for `delete`. */
    readonly text: string
    /** `null` when the edit's target could not be (unambiguously) located. */
    readonly anchor: Anchor | null
    /** Snapshot text at the anchored range at anchor time (precondition). */
    readonly anchoredText: string | null
    readonly matchStrategy: MatchStrategy | null
}

/** One planned document change, in current-document coordinates. */
export interface EditChange {
    readonly from: number
    readonly to: number
    readonly insert: string
}

/** Maps an anchored edit to its change. The anchor must be non-null. */
export function editChange(edit: TrackedEdit, anchor: Anchor): EditChange {
    switch (edit.op) {
        case 'replace':
            return { from: anchor.from, to: anchor.to, insert: edit.text }
        case 'delete':
            return { from: anchor.from, to: anchor.to, insert: '' }
        case 'insert-before':
            return { from: anchor.from, to: anchor.from, insert: edit.text }
        case 'insert-after':
            return { from: anchor.to, to: anchor.to, insert: edit.text }
    }
}

/**
 * Whether a set of changes can be dispatched as ONE transaction: sorted by
 * position they must not overlap. Touching is fine (CM6 accepts adjacent
 * changes), with one deliberate exception — two zero-width insertions at the
 * SAME position conflict, because their relative order in the note would be
 * an accident of array order rather than anything the proposal expressed.
 */
export function changesConflict(changes: readonly EditChange[]): boolean {
    const sorted = [...changes].sort((a, b) => a.from - b.from || a.to - b.to)
    for (let i = 1; i < sorted.length; i++) {
        const prev = sorted[i - 1]
        const next = sorted[i]
        if (!prev || !next) {
            continue
        }
        if (next.from < prev.to) {
            return true
        }
        const bothZeroWidth = prev.from === prev.to && next.from === next.to
        if (bothZeroWidth && prev.from === next.from) {
            return true
        }
    }
    return false
}

export type EditPlanFailure =
    /** The finding proposes nothing — critique-only, display-only. */
    | 'no-proposal'
    /** Some edit's target could not be located at ingestion. */
    | 'unanchored'
    /** Some edit's anchor intersected a later document change. */
    | 'stale'
    /** The live text no longer equals some edit's anchored text (BR #3). */
    | 'precondition-failed'
    /** The edits overlap each other — an incoherent proposal. */
    | 'conflicting-edits'

export type EditPlan =
    | { readonly ok: true; readonly changes: readonly EditChange[] }
    | { readonly ok: false; readonly reason: EditPlanFailure }

/**
 * Plans the full change set of one finding against the CURRENT document text.
 * All-or-nothing (design doc §4): every edit must be anchored, verified
 * against the live text, and mutually conflict-free — otherwise the whole
 * proposal is unapplicable and the failure names the first reason found.
 * Changes are returned sorted by position, dispatchable as one transaction.
 */
export function planEditChanges(edits: readonly TrackedEdit[], currentText: string): EditPlan {
    if (edits.length === 0) {
        return { ok: false, reason: 'no-proposal' }
    }
    const changes: EditChange[] = []
    for (const edit of edits) {
        if (edit.anchor === null || edit.anchoredText === null) {
            return { ok: false, reason: 'unanchored' }
        }
        if (edit.anchor.state !== 'anchored') {
            return { ok: false, reason: 'stale' }
        }
        if (!verifyPrecondition(currentText, edit.anchor, edit.anchoredText)) {
            return { ok: false, reason: 'precondition-failed' }
        }
        changes.push(editChange(edit, edit.anchor))
    }
    if (changesConflict(changes)) {
        return { ok: false, reason: 'conflicting-edits' }
    }
    return {
        ok: true,
        changes: [...changes].sort((a, b) => a.from - b.from || a.to - b.to)
    }
}

/**
 * Shape-level actionability, ignoring the live text: every edit anchored and
 * mutually conflict-free. The cheap prefix of {@link planEditChanges} for the
 * surfaces that advertise Accept without holding the document (rail counts,
 * `FindingStore.isActionable`, `isBulkAcceptable`) — every clause mirrors a
 * plan failure, so no surface ever advertises what the apply path refuses.
 */
export function editsApplicable(edits: readonly TrackedEdit[]): boolean {
    if (edits.length === 0) {
        return false
    }
    const changes: EditChange[] = []
    for (const edit of edits) {
        if (edit.anchor === null || edit.anchoredText === null) {
            return false
        }
        if (edit.anchor.state !== 'anchored') {
            return false
        }
        changes.push(editChange(edit, edit.anchor))
    }
    return !changesConflict(changes)
}
