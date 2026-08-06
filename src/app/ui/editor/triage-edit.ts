/**
 * Marks plugin-originated TRIAGE-tier DOCUMENT edits (two-tier carve-out,
 * 2026-08-06): accepting a finding's proposal — single or bulk — and adding
 * references dispatch real document changes, so they reach the canonical
 * view's update listener like any keystroke. Without the marker the daemon
 * treated them as EDITS and restarted the armed idle window — accepting the
 * last finding at the end of a quiet window postponed the automatic refresh
 * by the full delay, exactly what `recordTriageActivity` being a no-op was
 * supposed to prevent (adversarial review 2026-08-06).
 *
 * The annotation rides the dispatch itself, so the classification survives
 * CM6's transaction plumbing without a controller-side flag around every call
 * path (the finding card dispatches from outside the controller entirely).
 * Known limit, single mirror of the selection-suppression pattern's scope: a
 * mirror of this transaction into ANOTHER pane of the same file does not
 * carry the annotation, so with the canonical view in a different pane than
 * the card the edit degrades to keystroke semantics — a postponed window, the
 * pre-fix behavior, never a lost change.
 *
 * Undo/redo of a triage edit is deliberately NOT marked: the user performs it
 * at the keyboard like any edit, and it should restart the window.
 */

import { Annotation } from '@codemirror/state'
import type { Transaction } from '@codemirror/state'

/** Stamped (`.of(true)`) on every plugin-originated triage dispatch. */
export const triageEditAnnotation = Annotation.define<boolean>()

/**
 * Whether an update's document changes came ONLY from triage dispatches: every
 * doc-changing transaction carries the marker. One unmarked doc change makes
 * the whole update an edit — a keystroke bundled with a triage change must
 * keep keystroke semantics (restart the window), never be smuggled past it.
 * Callers ensure at least one transaction changed the doc (`update.docChanged`).
 */
export function isTriageOnlyEdit(transactions: readonly Transaction[]): boolean {
    return transactions.every(
        (transaction) =>
            !transaction.docChanged || transaction.annotation(triageEditAnnotation) === true
    )
}
