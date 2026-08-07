import type { Anchor, TextChange } from '../../domain/anchoring/anchor'
import { mapAnchorThroughChanges } from '../../domain/anchoring/anchor'
import type { MatchStrategy } from '../../domain/anchoring/match'
import type { FindingId, RunId } from '../../domain/ids'
import type { RawFinding } from '../../domain/operations/contract'
import type { EditChange, EditPlanFailure, TrackedEdit } from '../../domain/operations/edit-apply'
import { editsApplicable, planEditChanges } from '../../domain/operations/edit-apply'
import { isThreadFull } from '../../domain/operations/thread'
import type {
    ThreadBeginFailure,
    ThreadMessage,
    ThreadOutcome,
    ThreadTurn
} from '../../domain/operations/thread'

/**
 * Finding lifecycle state machine (review minor #34).
 *
 * ```
 * open ⇄ preview
 * open|preview → accepted | rejected | dismissed | superseded   (terminal)
 * ```
 *
 * Staleness is orthogonal: it lives on the anchor (`anchor.state`), not on
 * the status. A stale or unanchored finding remains visible (display-only)
 * and can still be rejected/dismissed/superseded, but never previewed or
 * accepted — its suggestion was computed against text that no longer exists
 * (Business Rules #3).
 */
export type FindingStatus =
    | 'open'
    | 'preview'
    | 'accepted'
    | 'rejected'
    | 'dismissed'
    | 'superseded'

/**
 * A finding as tracked by the orchestrator: the raw backend payload plus
 * anchoring outcome and lifecycle status.
 */
export interface TrackedFinding {
    readonly id: FindingId
    /** Per-editor run this finding belongs to. */
    readonly runId: RunId
    readonly editorId: string
    readonly raw: RawFinding
    /** `null` when the quote could not be (unambiguously) located: display-only. */
    readonly anchor: Anchor | null
    /**
     * Snapshot text at the anchored range at anchor time — the precondition
     * base. May differ from `raw.quote` for normalized matches.
     */
    readonly anchoredText: string | null
    readonly matchStrategy: MatchStrategy | null
    /**
     * The finding's proposal, resolved per edit (contract v2): each raw edit
     * with its own anchoring outcome. Edits without an own quote copied the
     * finding's anchor at ingestion; all copies remap independently through
     * document changes. Accepting applies ALL of them or none (design §4).
     */
    readonly edits: readonly TrackedEdit[]
    readonly status: FindingStatus
    /** Set when status is `superseded`: the finding that replaced this one. */
    readonly supersededBy: FindingId | null
    /**
     * Push-back thread: COMPLETED exchanges only, strictly alternating
     * `user, editor, …` (see `domain/operations/thread`). Session-scoped.
     */
    readonly thread: readonly ThreadMessage[]
    /** In-flight or failed push-back turn; `null` when the thread is idle. */
    readonly threadTurn: ThreadTurn | null
    /**
     * True when the editor WITHDREW this finding during a thread (status is
     * then `dismissed`). Distinguishes "the editor conceded" from "the user
     * dismissed it" in Notices and reports.
     */
    readonly conceded: boolean
    /**
     * True while this finding is a PREVIOUS run's, kept on screen while a
     * re-review runs (issue #19): surfaces dim it, and the run handle resolves
     * it against the new round's findings — adopted (same observation
     * repeated), kept (re-run failed, or outside the re-run's scope) or
     * dropped (not repeated). Fully functional meanwhile: the user can still
     * accept, dismiss or push back on it.
     */
    readonly carryover: boolean
}

/** Input for registering a freshly anchored finding (status starts at `open`). */
export interface NewFinding {
    readonly id: FindingId
    readonly runId: RunId
    readonly editorId: string
    readonly raw: RawFinding
    readonly anchor: Anchor | null
    readonly anchoredText: string | null
    readonly matchStrategy: MatchStrategy | null
    readonly edits: readonly TrackedEdit[]
}

/**
 * Input for registering a PREVIOUS run's finding into a new run's store
 * (issue #19): identity, triage status and thread history are preserved; the
 * anchoring fields are the caller's re-anchoring against the new snapshot.
 */
export interface CarryoverFinding extends NewFinding {
    readonly status: FindingStatus
    readonly thread: readonly ThreadMessage[]
    readonly threadTurn: ThreadTurn | null
    readonly conceded: boolean
}

/** The new attempt's data an adopted carryover finding is refreshed with. */
export interface AdoptionPatch {
    readonly runId: RunId
    readonly raw: RawFinding
    readonly anchor: Anchor | null
    readonly anchoredText: string | null
    readonly matchStrategy: MatchStrategy | null
    readonly edits: readonly TrackedEdit[]
}

export type AcceptFailureReason =
    | 'not-found'
    | 'invalid-status'
    /**
     * The proposal no longer applies to the live text — some edit's anchor
     * went stale or its precondition drifted (Business Rules #3). Folded
     * into ONE reason because the UI reaction is the same either way: mark
     * the finding stale-proposal and offer regeneration instead of a dead
     * Accept button.
     */
    | 'stale-proposal'
    | Exclude<EditPlanFailure, 'stale' | 'precondition-failed'>

export type AcceptResult =
    | {
          readonly ok: true
          readonly finding: TrackedFinding
          /**
           * The proposal's changes, verified against the live text and sorted
           * by position — dispatchable as ONE undoable transaction.
           */
          readonly changes: readonly EditChange[]
      }
    | { readonly ok: false; readonly reason: AcceptFailureReason }

export type ThreadBeginResult =
    | { readonly ok: true; readonly finding: TrackedFinding }
    | { readonly ok: false; readonly reason: ThreadBeginFailure }

const TERMINAL_STATUSES: readonly FindingStatus[] = [
    'accepted',
    'rejected',
    'dismissed',
    'superseded'
]

/**
 * The user's decision on a finding, as reported to `onDecided` (issue #4 —
 * the learning-loop signal). `conceded` is the editor withdrawing after
 * push-back — recorded as a decision because the user's arguments caused it,
 * and it is the strongest "the editor was wrong" signal there is. `held` is
 * the mirror: the user pushed back and the editor kept its position — the
 * exchange (and how the editor defended) is signal a push-back-only session
 * must not lose, and unlike the others it is not terminal: the user may
 * still accept or reject afterwards, which reports again.
 */
export type FindingDecision = 'accepted' | 'rejected' | 'dismissed' | 'conceded' | 'held'

/**
 * Fired once per USER triage decision, with the post-transition finding (a
 * conceded or held finding's completed `thread` rides along). This store is
 * the one choke point every triage surface goes through — card, keyboard,
 * bulk, panel — so a constructor callback here observes them all
 * structurally.
 *
 * Deliberately NOT fired for: `addCarryover` with a terminal status (decided
 * in a previous round), `supersede` (mechanical replacement, not a verdict),
 * `removeMany` (retry bookkeeping), or a failed `accept` (nothing happened).
 */
export type FindingDecidedCallback = (finding: TrackedFinding, decision: FindingDecision) => void

/**
 * In-memory store for the findings of one review run, enforcing the status
 * state machine and Business Rules #3 (stale proposals are never applied).
 *
 * All mutations go through the transition methods; invalid transitions are
 * rejected (returning `null` / a failure result) rather than throwing, so UI
 * races (double-click accept, accept-after-edit) degrade gracefully. Every
 * successful mutation invokes `onChange` exactly once.
 */
export class FindingStore {
    private readonly findings = new Map<string, TrackedFinding>()
    private readonly onChange: (() => void) | undefined
    private readonly onDecided: FindingDecidedCallback | undefined

    constructor(onChange?: () => void, onDecided?: FindingDecidedCallback) {
        this.onChange = onChange
        this.onDecided = onDecided
    }

    add(input: NewFinding): TrackedFinding {
        const finding: TrackedFinding = {
            id: input.id,
            runId: input.runId,
            editorId: input.editorId,
            raw: input.raw,
            anchor: input.anchor,
            anchoredText: input.anchoredText,
            matchStrategy: input.matchStrategy,
            edits: input.edits,
            status: 'open',
            supersededBy: null,
            thread: [],
            threadTurn: null,
            conceded: false,
            carryover: false
        }
        this.findings.set(finding.id, finding)
        this.notify()
        return finding
    }

    /**
     * Registers a previous run's finding, flagged `carryover` (issue #19).
     * `preview` degrades to `open` — the diff that was on screen belonged to
     * the replaced run; a pending push-back turn degrades to failed — its
     * completion targets the OLD run's store and can never land here.
     */
    addCarryover(input: CarryoverFinding): TrackedFinding {
        const finding: TrackedFinding = {
            id: input.id,
            runId: input.runId,
            editorId: input.editorId,
            raw: input.raw,
            anchor: input.anchor,
            anchoredText: input.anchoredText,
            matchStrategy: input.matchStrategy,
            edits: input.edits,
            status: input.status === 'preview' ? 'open' : input.status,
            supersededBy: null,
            thread: input.thread,
            threadTurn:
                input.threadTurn?.status === 'pending'
                    ? {
                          status: 'failed',
                          message: input.threadTurn.message,
                          reason: 'The review was refreshed'
                      }
                    : input.threadTurn,
            conceded: input.conceded,
            carryover: true
        }
        this.findings.set(finding.id, finding)
        this.notify()
        return finding
    }

    /**
     * Adopts a carryover finding into the current round (issue #19): the same
     * observation was repeated, so the finding keeps its id, its triage status
     * and its thread history, while the anchoring and proposal are refreshed
     * from the new attempt. Clears the carryover flag.
     */
    adoptCarryover(id: FindingId, patch: AdoptionPatch): TrackedFinding | null {
        const finding = this.findings.get(id)
        if (!finding || !finding.carryover) {
            return null
        }
        return this.update(finding, { ...patch, carryover: false })
    }

    /**
     * Clears the carryover flag without adopting (issue #19): the re-run
     * failed or was cancelled, or the finding sits outside a selection-scoped
     * re-run — the previous round's finding IS the current information again.
     */
    markCurrent(id: FindingId): TrackedFinding | null {
        const finding = this.findings.get(id)
        if (!finding || !finding.carryover) {
            return null
        }
        return this.update(finding, { carryover: false })
    }

    /**
     * Re-flags a finding as carryover (issue #19): a per-editor retry re-runs
     * the round the finding was carried into, so it goes back to pending
     * resolution against the retry's output.
     */
    markCarryover(id: FindingId): TrackedFinding | null {
        const finding = this.findings.get(id)
        if (!finding || finding.carryover) {
            return null
        }
        return this.update(finding, { carryover: true })
    }

    get(id: FindingId): TrackedFinding | null {
        return this.findings.get(id) ?? null
    }

    /** All findings, in insertion (arrival) order. */
    list(): readonly TrackedFinding[] {
        return [...this.findings.values()]
    }

    listByEditor(editorId: string): readonly TrackedFinding[] {
        return this.list().filter((finding) => finding.editorId === editorId)
    }

    /**
     * Whether a finding's proposal can currently be previewed/accepted:
     * non-terminal status, and EVERY edit anchored, not stale and mutually
     * conflict-free (`editsApplicable` — the all-or-nothing rule, design §4).
     *
     * Every clause mirrors an `accept()` refusal, so this predicate never
     * advertises a finding the apply path would reject — the panel's
     * "Accept all (n)" count, `planBulkAccept`/`isBulkAcceptable` and the
     * card's Accept button all read it (equivalence pinned in
     * `bulk-triage.spec.ts`).
     */
    isActionable(id: FindingId): boolean {
        const finding = this.findings.get(id)
        if (!finding) {
            return false
        }
        return !TERMINAL_STATUSES.includes(finding.status) && editsApplicable(finding.edits)
    }

    /** `open` → `preview`. Requires an actionable proposal. */
    preview(id: FindingId): TrackedFinding | null {
        const finding = this.findings.get(id)
        if (!finding || finding.status !== 'open' || !this.isActionable(id)) {
            return null
        }
        return this.update(finding, { status: 'preview' })
    }

    /** `preview` → `open` (user closed the diff without deciding). */
    closePreview(id: FindingId): TrackedFinding | null {
        const finding = this.findings.get(id)
        if (!finding || finding.status !== 'preview') {
            return null
        }
        return this.update(finding, { status: 'open' })
    }

    /**
     * `open|preview` → `accepted`, gated by the full edit plan: EVERY edit of
     * the proposal must still verify against the current document text
     * (Business Rules #3) and the set must be conflict-free — all-or-nothing,
     * one transaction (design §4). Never fuzzy-relocates.
     */
    accept(id: FindingId, currentText: string): AcceptResult {
        const finding = this.findings.get(id)
        if (!finding) {
            return { ok: false, reason: 'not-found' }
        }
        if (finding.status !== 'open' && finding.status !== 'preview') {
            return { ok: false, reason: 'invalid-status' }
        }
        const plan = planEditChanges(finding.edits, currentText)
        if (!plan.ok) {
            if (plan.reason === 'stale' || plan.reason === 'precondition-failed') {
                // Status stays 'open': the finding degrades visibly instead
                // of vanishing (BR #16), and the caller can offer
                // regeneration.
                return { ok: false, reason: 'stale-proposal' }
            }
            return { ok: false, reason: plan.reason }
        }
        const accepted = this.update(finding, { status: 'accepted' })
        this.decided(accepted, 'accepted')
        return {
            ok: true,
            finding: accepted,
            changes: plan.changes
        }
    }

    /** `open|preview` → `rejected`. Allowed for stale/unanchored findings. */
    reject(id: FindingId): TrackedFinding | null {
        return this.close(id, 'rejected')
    }

    /** `open|preview` → `dismissed`. Allowed for stale/unanchored findings. */
    dismiss(id: FindingId): TrackedFinding | null {
        return this.close(id, 'dismissed')
    }

    /**
     * `open|preview` → `superseded`: a newer finding (e.g. from a refined
     * proposal or a thread turn) replaces this one. The successor must
     * already be registered so `supersededBy` never dangles.
     */
    supersede(id: FindingId, byId: FindingId): TrackedFinding | null {
        const finding = this.findings.get(id)
        const successor = this.findings.get(byId)
        if (!finding || !successor || id === byId) {
            return null
        }
        if (finding.status !== 'open' && finding.status !== 'preview') {
            return null
        }
        return this.update(finding, { status: 'superseded', supersededBy: byId })
    }

    /**
     * Removes findings outright — the per-editor retry path (`retryEditor`):
     * a retried attempt REPLACES the failed attempt's findings, so they leave
     * the store entirely (any status, terminal included — an accepted edit
     * stays in the document, only its record goes). Unknown ids are ignored;
     * `onChange` fires once when anything was removed.
     */
    removeMany(ids: readonly FindingId[]): void {
        let removed = false
        for (const id of ids) {
            if (this.findings.delete(id)) {
                removed = true
            }
        }
        if (removed) {
            this.notify()
        }
    }

    /**
     * Maps every anchored finding — AND every anchored edit of its proposal —
     * through a batch of document changes (pre-change coordinates, sorted,
     * non-overlapping — the CM6 `iterChanges` shape). A finding whose
     * proposal stops being applicable while in `preview` falls back to
     * `open`: the diff on screen no longer reflects reality and must not be
     * one keypress away from Accept.
     */
    applyTextChanges(changes: readonly TextChange[]): void {
        if (changes.length === 0) {
            return
        }
        let changed = false
        for (const finding of this.findings.values()) {
            let findingChanged = false
            let anchor = finding.anchor
            if (anchor !== null) {
                const mapped = mapAnchorThroughChanges(anchor, changes)
                if (
                    mapped.from !== anchor.from ||
                    mapped.to !== anchor.to ||
                    mapped.state !== anchor.state
                ) {
                    anchor = mapped
                    findingChanged = true
                }
            }
            let edits = finding.edits
            if (finding.edits.some((edit) => edit.anchor !== null)) {
                const remapped = finding.edits.map((edit) => {
                    if (edit.anchor === null) {
                        return edit
                    }
                    const mapped = mapAnchorThroughChanges(edit.anchor, changes)
                    if (
                        mapped.from === edit.anchor.from &&
                        mapped.to === edit.anchor.to &&
                        mapped.state === edit.anchor.state
                    ) {
                        return edit
                    }
                    return { ...edit, anchor: mapped }
                })
                if (remapped.some((edit, index) => edit !== finding.edits[index])) {
                    edits = remapped
                    findingChanged = true
                }
            }
            if (!findingChanged) {
                continue
            }
            const status =
                finding.status === 'preview' && !editsApplicable(edits) ? 'open' : finding.status
            this.findings.set(finding.id, { ...finding, anchor, edits, status })
            changed = true
        }
        if (changed) {
            this.notify()
        }
    }

    // -- Push-back threads ----------------------------------------------------

    /**
     * Records a user push-back as the finding's in-flight turn. The message is
     * NOT appended to `thread` — it joins it (together with the reply) only
     * when the turn completes, keeping `thread` strictly alternating and
     * replay-safe.
     *
     * Refusals mirror what the UI must not offer: a terminal finding has
     * nothing left to argue about, one turn at a time keeps the history
     * linear, and the cap bounds cost. A previous FAILED turn is simply
     * replaced (that is the retry path).
     */
    beginThreadTurn(id: FindingId, message: string): ThreadBeginResult {
        const trimmed = message.trim()
        if (trimmed.length === 0) {
            return { ok: false, reason: 'blank-message' }
        }
        const finding = this.findings.get(id)
        if (!finding) {
            return { ok: false, reason: 'not-found' }
        }
        if (TERMINAL_STATUSES.includes(finding.status)) {
            return { ok: false, reason: 'invalid-status' }
        }
        if (finding.threadTurn?.status === 'pending') {
            return { ok: false, reason: 'in-flight' }
        }
        if (isThreadFull(finding.thread)) {
            return { ok: false, reason: 'cap-reached' }
        }
        return {
            ok: true,
            finding: this.update(finding, {
                threadTurn: { status: 'pending', message: trimmed }
            })
        }
    }

    /**
     * Lands a completed turn: the pending message and the editor's reply join
     * `thread`, then the outcome is applied.
     *
     * - `concede` → the finding is dismissed and flagged `conceded` (only when
     *   it is still open/preview: the user may have accepted it while the turn
     *   was in flight, and an applied edit is not undone by a late withdrawal).
     * - `hold` → the critique and/or proposal are updated IN PLACE (not
     *   superseded: it is the same observation, refined). A revised proposal
     *   (`outcome.revisedEdits`) REPLACES the finding's edits wholesale; the
     *   caller supplies the anchored form (`revisedTrackedEdits`, resolved
     *   against the live text — the store has no buffer). A `null` there
     *   despite a revision degrades the new proposal to display-only (all
     *   anchors null) rather than guessing (Business Rules #3/#4). A finding
     *   sitting in `preview` with a CHANGED proposal falls back to `open` —
     *   the diff on screen is no longer the proposal.
     *
     * Returns `null` when the turn no longer belongs to the store (the
     * finding was removed by a retry, or its pending turn was already
     * resolved): a late backend event must never resurrect it.
     */
    completeThreadTurn(
        id: FindingId,
        outcome: ThreadOutcome,
        revisedTrackedEdits: readonly TrackedEdit[] | null = null
    ): TrackedFinding | null {
        const finding = this.findings.get(id)
        if (!finding || finding.threadTurn?.status !== 'pending') {
            return null
        }
        const thread: ThreadMessage[] = [
            ...finding.thread,
            { role: 'user', content: finding.threadTurn.message },
            { role: 'editor', content: outcome.reply }
        ]
        if (outcome.kind === 'concede') {
            const dismissable = finding.status === 'open' || finding.status === 'preview'
            const updated = this.update(finding, {
                thread,
                threadTurn: null,
                ...(dismissable ? { status: 'dismissed' as const, conceded: true } : {})
            })
            if (dismissable) {
                // The concession actually dismissed the finding: the user's
                // push-back won the argument (issue #4's strongest signal).
                this.decided(updated, 'conceded')
            }
            return updated
        }
        const revisedRaw = outcome.revisedEdits
        const edits: readonly TrackedEdit[] | null =
            revisedRaw === null
                ? null
                : (revisedTrackedEdits ??
                  // No live text to anchor against: fail closed, display-only.
                  revisedRaw.map((edit) => ({
                      op: edit.op,
                      text: edit.op === 'delete' ? '' : (edit.text ?? ''),
                      anchor: null,
                      anchoredText: null,
                      matchStrategy: null
                  })))
        const held = this.update(finding, {
            thread,
            threadTurn: null,
            raw: {
                ...finding.raw,
                critique: outcome.revisedCritique ?? finding.raw.critique,
                ...(revisedRaw === null ? {} : { edits: [...revisedRaw] })
            },
            ...(edits === null ? {} : { edits }),
            ...(edits !== null && finding.status === 'preview' ? { status: 'open' as const } : {})
        })
        // A landed hold is the learning loop's push-back-lost signal: the
        // user argued, the editor kept its position, and the completed
        // exchange rides along. Without it, a session of pure push-back
        // (no accept/reject/dismiss) leaves the journal empty and the
        // distillation command hidden — the argument would be lost.
        this.decided(held, 'held')
        return held
    }

    /**
     * Marks the in-flight turn failed (backend error, timeout, or run cancel).
     * The message is kept so the card can show what was sent and let the user
     * try again; `thread` stays untouched (no half exchange ever enters it).
     */
    failThreadTurn(id: FindingId, reason: string): TrackedFinding | null {
        const finding = this.findings.get(id)
        if (!finding || finding.threadTurn?.status !== 'pending') {
            return null
        }
        return this.update(finding, {
            threadTurn: { status: 'failed', message: finding.threadTurn.message, reason }
        })
    }

    private close(id: FindingId, status: 'rejected' | 'dismissed'): TrackedFinding | null {
        const finding = this.findings.get(id)
        if (!finding || (finding.status !== 'open' && finding.status !== 'preview')) {
            return null
        }
        const closed = this.update(finding, { status })
        this.decided(closed, status)
        return closed
    }

    /** Exception-isolated: a learning-loop observer must never break triage. */
    private decided(finding: TrackedFinding, decision: FindingDecision): void {
        try {
            this.onDecided?.(finding, decision)
        } catch {
            // Observer only.
        }
    }

    private update(finding: TrackedFinding, patch: Partial<TrackedFinding>): TrackedFinding {
        const next: TrackedFinding = { ...finding, ...patch }
        this.findings.set(next.id, next)
        this.notify()
        return next
    }

    private notify(): void {
        this.onChange?.()
    }
}
