import type { Anchor, TextChange } from '../../domain/anchoring/anchor'
import { mapAnchorThroughChanges, verifyPrecondition } from '../../domain/anchoring/anchor'
import type { MatchStrategy } from '../../domain/anchoring/match'
import type { FindingId, RunId } from '../../domain/ids'
import type { RawFinding } from '../../domain/operations/contract'
import { isThreadFull } from '../../domain/operations/thread'
import type { ThreadMessage, ThreadOutcome, ThreadTurn } from '../../domain/operations/thread'

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
     * Snapshot text at the anchored range at anchor time — the accept
     * precondition. May differ from `raw.quote` for normalized matches.
     */
    readonly anchoredText: string | null
    readonly matchStrategy: MatchStrategy | null
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
}

export type AcceptFailureReason =
    | 'not-found'
    | 'invalid-status'
    | 'unanchored'
    | 'stale'
    | 'no-suggestion'
    | 'precondition-failed'

export type AcceptResult =
    | { readonly ok: true; readonly finding: TrackedFinding }
    | { readonly ok: false; readonly reason: AcceptFailureReason }

/** Why a push-back could not be sent. */
export type ThreadBeginFailure =
    | 'not-found'
    /** The finding is terminal (accepted / rejected / dismissed / superseded). */
    | 'invalid-status'
    /** A turn is already in flight for this finding. */
    | 'in-flight'
    /** `THREAD_MAX_TURNS` completed exchanges reached. */
    | 'cap-reached'
    | 'blank-message'

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

    constructor(onChange?: () => void) {
        this.onChange = onChange
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
            status: 'open',
            supersededBy: null,
            thread: [],
            threadTurn: null,
            conceded: false
        }
        this.findings.set(finding.id, finding)
        this.notify()
        return finding
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
     * Whether a finding's suggestion can currently be previewed/accepted:
     * non-terminal status, anchored, not stale, and a suggestion exists.
     */
    isActionable(id: FindingId): boolean {
        const finding = this.findings.get(id)
        if (!finding) {
            return false
        }
        return (
            !TERMINAL_STATUSES.includes(finding.status) &&
            finding.anchor !== null &&
            finding.anchor.state === 'anchored' &&
            typeof finding.raw.suggestion === 'string' &&
            finding.raw.suggestion.length > 0
        )
    }

    /** `open` → `preview`. Requires an actionable suggestion. */
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
     * `open|preview` → `accepted`, gated by the precondition check: the
     * current document must still contain the exact anchored text at the
     * anchor (Business Rules #3). Never fuzzy-relocates.
     */
    accept(id: FindingId, currentText: string): AcceptResult {
        const finding = this.findings.get(id)
        if (!finding) {
            return { ok: false, reason: 'not-found' }
        }
        if (finding.status !== 'open' && finding.status !== 'preview') {
            return { ok: false, reason: 'invalid-status' }
        }
        if (finding.anchor === null || finding.anchoredText === null) {
            return { ok: false, reason: 'unanchored' }
        }
        if (finding.anchor.state !== 'anchored') {
            return { ok: false, reason: 'stale' }
        }
        if (typeof finding.raw.suggestion !== 'string' || finding.raw.suggestion.length === 0) {
            return { ok: false, reason: 'no-suggestion' }
        }
        if (!verifyPrecondition(currentText, finding.anchor, finding.anchoredText)) {
            return { ok: false, reason: 'precondition-failed' }
        }
        return { ok: true, finding: this.update(finding, { status: 'accepted' }) }
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
     * Maps every anchored finding through a batch of document changes
     * (pre-change coordinates, sorted, non-overlapping — the CM6
     * `iterChanges` shape). A finding whose anchor goes stale while in
     * `preview` falls back to `open`: the diff on screen no longer reflects
     * reality and must not be one keypress away from Accept.
     */
    applyTextChanges(changes: readonly TextChange[]): void {
        if (changes.length === 0) {
            return
        }
        let changed = false
        for (const finding of this.findings.values()) {
            if (finding.anchor === null) {
                continue
            }
            const mapped = mapAnchorThroughChanges(finding.anchor, changes)
            if (
                mapped.from === finding.anchor.from &&
                mapped.to === finding.anchor.to &&
                mapped.state === finding.anchor.state
            ) {
                continue
            }
            const wentStale = finding.anchor.state === 'anchored' && mapped.state === 'stale'
            const status = wentStale && finding.status === 'preview' ? 'open' : finding.status
            this.findings.set(finding.id, { ...finding, anchor: mapped, status })
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
     * - `hold` → the critique and/or suggestion are updated IN PLACE (not
     *   superseded: it is the same observation, refined — `supersede` stays
     *   for the refine-proposal flow that mints a new finding). The anchor and
     *   `anchoredText` are untouched, so `isActionable` re-derives the accept
     *   precondition for the new suggestion for free: a span that went stale
     *   while the turn was in flight keeps the revised suggestion
     *   display-only (Business Rules #3). A finding sitting in `preview` with
     *   a CHANGED suggestion falls back to `open` — the diff on screen is no
     *   longer the proposal.
     *
     * Returns `null` when the turn no longer belongs to the store (the
     * finding was removed by a retry, or its pending turn was already
     * resolved): a late backend event must never resurrect it.
     */
    completeThreadTurn(id: FindingId, outcome: ThreadOutcome): TrackedFinding | null {
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
            return this.update(finding, {
                thread,
                threadTurn: null,
                ...(dismissable ? { status: 'dismissed' as const, conceded: true } : {})
            })
        }
        const suggestion = outcome.revisedSuggestion ?? finding.raw.suggestion
        const suggestionChanged = suggestion !== finding.raw.suggestion
        return this.update(finding, {
            thread,
            threadTurn: null,
            raw: {
                ...finding.raw,
                critique: outcome.revisedCritique ?? finding.raw.critique,
                ...(suggestion === undefined ? {} : { suggestion })
            },
            ...(suggestionChanged && finding.status === 'preview'
                ? { status: 'open' as const }
                : {})
        })
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
        return this.update(finding, { status })
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
