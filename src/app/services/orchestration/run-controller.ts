import type { Anchor, TextChange } from '../../domain/anchoring/anchor'
import { createAnchor, mapAnchorThroughChanges } from '../../domain/anchoring/anchor'
import type { MatchStrategy } from '../../domain/anchoring/match'
import { matchQuote } from '../../domain/anchoring/match'
import type { FindingId, RunId } from '../../domain/ids'
import { asFindingId, asRunId, generateId } from '../../domain/ids'
import type {
    AggregatePanelRequest,
    OperationEvent,
    OperationResult,
    PanelResult,
    RawFinding,
    ReviewRequest,
    ThreadTurnRequest,
    Verdict
} from '../../domain/operations/contract'
import { CONTRACT_VERSION } from '../../domain/operations/contract'
import { planPanelAggregation } from '../../domain/panels/panel-aggregation'
import type { PanelAggregationPlan, PanelMemberReview } from '../../domain/panels/panel-aggregation'
import { resolveThreadOutcome } from '../../domain/operations/thread'
import type { ThreadBeginFailure } from '../../domain/operations/thread'
import type { DocumentSnapshot } from '../../domain/snapshot'
import { hashText } from '../../domain/snapshot'
import { FindingStore } from './finding-store'
import type { ReleasePermit } from './semaphore'
import { Semaphore } from './semaphore'

/**
 * Review-run orchestration: consumes backend event streams for one snapshot,
 * enforces the event protocol (run-id matching, exactly-once terminal),
 * anchors findings, and maintains per-editor status — all Obsidian-free and
 * backend-agnostic (backends are injected as `execute` functions).
 *
 * Protocol enforcement (see the operation contract):
 * - Events carrying a foreign runId are discarded.
 * - Events after the terminal event (result/error/cancel) are discarded.
 * - A stream that ends without a terminal event is a protocol violation and
 *   surfaces as an `invalid-output` error, never as silent success.
 */

export type EditorRunStatus = 'pending' | 'running' | 'done' | 'error' | 'cancelled'

export type OperationErrorInfo = Extract<OperationEvent, { type: 'error' }>['error']

/** Outcome of `RunHandle.retryEditor`. */
export type RetryEditorResult =
    | { readonly ok: true }
    | { readonly ok: false; readonly reason: 'unknown-editor' | 'not-retryable' }

/** One editor persona participating in a run, with its backend injected. */
export interface RunEditorSpec {
    readonly editorId: string
    readonly editorName: string
    /**
     * Redacts secrets (API keys…) from an error message before it becomes
     * user-visible run state (Business Rules #12). The backend bridge knows
     * the configured secrets and MUST inject this (e.g. `redactSecret` bound
     * to the backend's API key) — provider 401 bodies can echo the submitted
     * key back. Identity when omitted (secret-free backends only).
     */
    readonly redactError?: (message: string) => string
    readonly execute: (request: ReviewRequest, signal: AbortSignal) => AsyncIterable<OperationEvent>
}

export interface StartRunInput {
    readonly snapshot: DocumentSnapshot
    readonly editors: readonly RunEditorSpec[]
    /**
     * Present when this run IS a panel (plan M6): the editors above are its
     * members, and the run additionally owns the aggregation step that turns
     * their results into one scorecard. Absent for solo runs — nothing else
     * about the run changes, which is the point: a panel member is an ordinary
     * editor stream with the same anchoring, the same finding machinery and the
     * same concurrency gate.
     */
    readonly panel?: RunPanelSpec
}

// ---------------------------------------------------------------------------
// Panel runs (plan M6)
// ---------------------------------------------------------------------------

/** Backend executor for the aggregation step (same event protocol as reviews). */
export type PanelAggregationExecutor = (
    request: AggregatePanelRequest,
    signal: AbortSignal
) => AsyncIterable<OperationEvent>

/** Panel identity + aggregation wiring for a first-class panel run. */
export interface RunPanelSpec {
    readonly panelId: string
    readonly panelName: string
    /** Redacts secrets from aggregation error messages (Business Rules #12). */
    readonly redactError?: (message: string) => string
    /**
     * The aggregation backend. Absent when the panel has no usable one: the
     * members still run as a panel and the scorecard reports `unavailable`,
     * rather than the run pretending there was nothing to aggregate.
     */
    readonly aggregate?: PanelAggregationExecutor
}

/**
 * Lifecycle of the aggregation step. `waiting` covers the whole time members
 * are still running — the scorecard is a post-condition of the panel, so it
 * has no meaningful state before then.
 */
export type PanelAggregationStatus =
    | 'waiting'
    | 'running'
    | 'done'
    | 'error'
    /** The run (or the aggregation alone) was cancelled. */
    | 'cancelled'
    /** No member succeeded — nothing to synthesize (see the partial-failure policy). */
    | 'skipped'
    /** The panel has no usable aggregation backend configured. */
    | 'unavailable'

/** Immutable view of a panel run's aggregation step. */
export interface PanelRunState {
    readonly panelId: string
    readonly panelName: string
    readonly status: PanelAggregationStatus
    /**
     * Member editor names that did not produce a review, in run order. Filled
     * as soon as the members settle — so the partial nature of a panel is
     * visible whether or not the aggregation itself succeeds.
     */
    readonly missingMembers: readonly string[]
    readonly result: PanelResult | null
    /** Redacted failure message when `status` is `error`. */
    readonly error: string | null
}

// ---------------------------------------------------------------------------
// Push-back threads (plan M4)
// ---------------------------------------------------------------------------

/** Backend executor for one thread turn (same event protocol as reviews). */
export type ThreadExecutor = (
    request: ThreadTurnRequest,
    signal: AbortSignal
) => AsyncIterable<OperationEvent>

export interface StartThreadTurnInput {
    readonly findingId: FindingId
    /** The user's push-back; validated and stored by the `FindingStore`. */
    readonly message: string
    /**
     * Text the turn is about — the CURRENT text of the finding's span,
     * resolved by the caller through `currentSpanText` against the live
     * document (never re-derived here: the run handle has no live buffer).
     */
    readonly quote: string
    /** Secret redaction for error messages (Business Rules #12). */
    readonly redactError?: (message: string) => string
    readonly execute: ThreadExecutor
}

/**
 * How a thread turn ended. `discarded` means the store no longer accepted the
 * outcome (the finding was removed by a retry, or its pending turn was already
 * resolved) — nothing was written, so callers must stay silent about it.
 */
export type ThreadTurnResolution =
    | { readonly status: 'conceded'; readonly reply: string }
    | { readonly status: 'held'; readonly reply: string; readonly revised: boolean }
    | { readonly status: 'failed'; readonly reason: string }
    | { readonly status: 'cancelled' }
    | { readonly status: 'discarded' }

export type StartThreadTurnResult =
    | { readonly ok: true; readonly settled: Promise<ThreadTurnResolution> }
    | { readonly ok: false; readonly reason: ThreadBeginFailure }

/** Immutable view of one editor's progress within a run. */
export interface EditorRunState {
    readonly editorId: string
    readonly editorName: string
    readonly runId: RunId
    readonly status: EditorRunStatus
    /** Finding ids in arrival order; resolve via the run's `findings` store. */
    readonly findingIds: readonly FindingId[]
    readonly summary: string | null
    readonly verdict: Verdict | null
    readonly lastProgress: string | null
    readonly error: OperationErrorInfo | null
}

/** Handle over one review run (one snapshot, N editors). */
export interface RunHandle {
    readonly snapshot: DocumentSnapshot
    /** Finding state machine for this run (statuses, accept preconditions). */
    readonly findings: FindingStore
    /**
     * Resolves when every INITIAL editor stream has reached a terminal state
     * (the CLI awaits this to shape its one-shot output). A later
     * `retryEditor` does NOT reset it — a promise cannot un-resolve; live
     * surfaces must poll `isSettled()`, which does flip back to false while
     * a retry is in flight.
     */
    readonly settled: Promise<void>
    /**
     * Resolves when the FIRST aggregation attempt of a panel run reaches a
     * terminal status (`done`, `error`, `cancelled`, `skipped`, `unavailable`);
     * already resolved for a solo run. Same caveat as `settled`: a retry that
     * re-opens the panel does not un-resolve it — live surfaces read
     * `getPanelState()`.
     */
    readonly panelSettled: Promise<void>
    getEditorStates(): readonly EditorRunState[]
    getEditorState(editorId: string): EditorRunState | null
    /**
     * The panel this run is, and where its scorecard stands; `null` for a solo
     * run. Findings are NOT part of it — they keep their per-member editor
     * identity in the finding store, because a panel weighs its members, it
     * does not merge them.
     */
    getPanelState(): PanelRunState | null
    /**
     * Whether every editor currently sits at a terminal status. Derived from
     * live editor state, so an in-flight retry flips it back to false and the
     * status surfaces (rail spinner/Cancel, side panel, `Cancel review` gate,
     * CLI status) all report the run as in progress again.
     */
    isSettled(): boolean
    subscribe(listener: () => void): () => void
    /** Aborts all in-flight editor streams; late events are discarded. */
    cancelRun(): void
    /** Remaps every anchored finding through user edits (stale per BR #3). */
    applyTextChanges(changes: readonly TextChange[]): void
    /**
     * Re-runs ONE editor inside this run after it failed (`error`) or was
     * cancelled (`cancelled`); every other editor's findings are untouched.
     *
     * `freshText` MUST be the CURRENT document text at call time (the UI
     * reads the live buffer synchronously): retried findings anchor against
     * it as their per-editor anchor base, then remap through every edit
     * applied after the retry started — never a guessed position (Business
     * Rules #3/#4).
     *
     * Decision (plan §0 "Slow & thinking models" piece 1): a retry REPLACES
     * the editor's previous findings — they came from a failed or partial
     * attempt, so keeping them would mix two generations of critique over
     * one document. All of the editor's findings (terminal ones included —
     * an accepted edit stays in the document, only its record goes) are
     * removed from the store; decorations and panels drop them on the next
     * refresh via the store notification.
     *
     * The retry acquires the concurrency permit exactly like a first attempt
     * and runs on a FRESH per-retry AbortController — after `cancelRun` the
     * run-level signal is permanently aborted and must not poison the new
     * attempt; a later `cancelRun` aborts active retries too.
     */
    retryEditor(editorId: string, freshText: string): RetryEditorResult
    /**
     * Sends one push-back turn on a finding of this run (plan M4 threads).
     * Lives on the run handle because the run owns the findings the thread
     * hangs off: a replaced or discarded run kills its in-flight turns for
     * free, and `cancelRun` aborts them — while CLOSING THE CARD does not
     * (the reply lands in the store and shows when the card is reopened).
     *
     * The turn does NOT participate in `settled`/`isSettled()`: the review is
     * over, a thread is a side conversation. It DOES take a permit from the
     * plugin-wide concurrency gate like any other backend request, and its
     * error messages go through `redactError` (Business Rules #12).
     *
     * Refusals come from the `FindingStore` (terminal finding, turn already in
     * flight, cap reached, blank message) — the UI must not offer those.
     */
    startThreadTurn(input: StartThreadTurnInput): StartThreadTurnResult
}

/**
 * Per-attempt anchoring base: the text findings of the CURRENT attempt are
 * anchored against, plus every edit batch applied since (each batch in the
 * coordinates of the document it was applied to). Findings arriving after an
 * edit are anchored against `text` and replayed through `batches` so they
 * land in current-document coordinates (Business Rules #3/#4). Initial
 * attempts base on the run snapshot; a retry bases on the fresh text captured
 * at retry time. Dropped (null) once the editor is terminal — no further
 * finding can arrive, so retaining batches would leak one array per
 * keystroke for the lifetime of the run.
 */
interface AnchorBase {
    readonly text: string
    readonly batches: TextChange[][]
}

interface InternalEditorState {
    readonly editorId: string
    readonly editorName: string
    /** Attempt identity: a retry issues a fresh runId, so late events from a
     * previous attempt's still-draining stream fail the runId match and are
     * discarded — the foreign-run check doubles as the attempt guard. */
    runId: RunId
    status: EditorRunStatus
    findingIds: FindingId[]
    summary: string | null
    verdict: Verdict | null
    lastProgress: string | null
    error: OperationErrorInfo | null
    /** True once a terminal event was processed; later events are discarded. */
    terminal: boolean
    /** Content keys of ingested findings, deduping stream vs result payloads. */
    seenFindingKeys: Set<string>
    /**
     * Frees this editor's concurrency permit (null until admitted, nulled
     * once released). Held here — not only in the consume loop's closure —
     * so the permit is released the moment the editor goes TERMINAL, not
     * when its iterator finally ends: after a terminal event (or cancel)
     * the loop keeps draining discarded events, and an executor that
     * ignores its AbortSignal would otherwise hold the permit indefinitely
     * — with `maxConcurrentRequests` = N, N such streams would deadlock
     * every future review plugin-wide. Release is idempotent, and the
     * consume loop's `finally` stays as backstop.
     */
    releasePermit: ReleasePermit | null
    /**
     * Anchoring base of the current attempt; null once terminal (see
     * `AnchorBase`).
     */
    anchorBase: AnchorBase | null
    /**
     * Abort controller of the current RETRY attempt (null for the initial
     * attempt, which runs on the shared run-level abort). Fresh per retry:
     * after `cancelRun` the shared signal is permanently aborted, so a retry
     * composed with it would die instantly. `cancelRun` aborts this too.
     */
    attemptAbort: AbortController | null
}

/** Mutable twin of `PanelRunState` (the public view is a copy). */
interface InternalPanelState {
    readonly panelId: string
    readonly panelName: string
    status: PanelAggregationStatus
    missingMembers: string[]
    result: PanelResult | null
    error: string | null
}

class ReviewRunHandle implements RunHandle {
    readonly snapshot: DocumentSnapshot
    readonly findings: FindingStore
    readonly settled: Promise<void>
    readonly panelSettled: Promise<void>

    private readonly abort = new AbortController()
    private readonly listeners = new Set<() => void>()
    private readonly states = new Map<string, InternalEditorState>()
    /** Editor specs retained so `retryEditor` can re-run an executor. */
    private readonly specs = new Map<string, RunEditorSpec>()
    /**
     * Abort controllers of the in-flight push-back turns, so `cancelRun`
     * reaches them. Deliberately NOT composed with the run-level signal:
     * cancelling a run keeps its findings inspectable, so a LATER push-back on
     * one of them must still be able to run.
     */
    private readonly threadAborts = new Set<AbortController>()
    /** Panel identity + aggregation backend; null for a solo run. */
    private readonly panelSpec: RunPanelSpec | null
    private readonly panel: InternalPanelState | null
    /** Abort of the in-flight aggregation attempt (null when none is running). */
    private panelAbort: AbortController | null = null
    /**
     * Attempt identity of the aggregation, bumped whenever a retry re-opens the
     * panel. A late settle carrying an older epoch belongs to a scorecard the
     * run has already discarded and is dropped — same guard as the per-editor
     * `runId` attempt check.
     */
    private panelEpoch = 0
    private resolvePanelSettled: () => void = () => undefined

    constructor(
        input: StartRunInput,
        private readonly requestGate: Semaphore
    ) {
        this.snapshot = input.snapshot
        this.findings = new FindingStore(() => this.notify())
        this.panelSpec = input.panel ?? null
        this.panel = input.panel
            ? {
                  panelId: input.panel.panelId,
                  panelName: input.panel.panelName,
                  status: 'waiting',
                  missingMembers: [],
                  result: null,
                  error: null
              }
            : null
        this.panelSettled = this.panel
            ? new Promise<void>((resolve) => {
                  this.resolvePanelSettled = resolve
              })
            : Promise.resolve()

        for (const spec of input.editors) {
            if (this.states.has(spec.editorId)) {
                throw new Error(`Duplicate editorId in run: ${spec.editorId}`)
            }
            this.specs.set(spec.editorId, spec)
            this.states.set(spec.editorId, {
                editorId: spec.editorId,
                editorName: spec.editorName,
                runId: asRunId(generateId()),
                status: 'pending',
                findingIds: [],
                summary: null,
                verdict: null,
                lastProgress: null,
                error: null,
                terminal: false,
                seenFindingKeys: new Set(),
                releasePermit: null,
                // Initial attempts all anchor against the run snapshot; the
                // batch lists are per editor because retries reset them
                // independently.
                anchorBase: { text: input.snapshot.text, batches: [] },
                attemptAbort: null
            })
        }

        const loops = input.editors.map((spec) => {
            const state = this.states.get(spec.editorId)
            return state ? this.consume(spec, state, this.abort.signal) : Promise.resolve()
        })
        this.settled = Promise.allSettled(loops).then(() => undefined)
        // Covers the degenerate panel with no member stream at all: nothing
        // will ever call `terminate`, so the scorecard would wait forever.
        this.maybeAggregate()
    }

    getEditorStates(): readonly EditorRunState[] {
        return [...this.states.values()].map((state) => toPublicState(state))
    }

    getEditorState(editorId: string): EditorRunState | null {
        const state = this.states.get(editorId)
        return state ? toPublicState(state) : null
    }

    getPanelState(): PanelRunState | null {
        const panel = this.panel
        return panel
            ? {
                  panelId: panel.panelId,
                  panelName: panel.panelName,
                  status: panel.status,
                  missingMembers: [...panel.missingMembers],
                  result: panel.result,
                  error: panel.error
              }
            : null
    }

    isSettled(): boolean {
        // Derived, not a latched flag: `retryEditor` puts an editor back to
        // 'pending', which must flip the run to in-progress on every surface.
        for (const state of this.states.values()) {
            if (!state.terminal) {
                return false
            }
        }
        return true
    }

    subscribe(listener: () => void): () => void {
        this.listeners.add(listener)
        return () => {
            this.listeners.delete(listener)
        }
    }

    cancelRun(): void {
        // No early return on an already-aborted run signal: after a
        // cancel + retry the shared signal is still aborted while the retry
        // runs on its own controller — cancelling again must reach it.
        if (!this.abort.signal.aborted) {
            this.abort.abort()
        }
        // In-flight push-back turns die with the run (their own controllers —
        // see `threadAborts`). Their findings are marked NOW rather than when
        // the aborted stream winds down (same rationale as the editor permits
        // above): an executor that ignores its signal must not leave a card
        // spinning forever.
        for (const abort of [...this.threadAborts]) {
            abort.abort()
        }
        // Cancelling a panel run cancels its pending aggregation too: the
        // scorecard is a statement about a run the user just stopped. An
        // already-produced scorecard is left alone — it stays inspectable
        // exactly like the findings of the members that did finish.
        const panel = this.panel
        if (panel && (panel.status === 'waiting' || panel.status === 'running')) {
            this.panelEpoch += 1
            this.panelAbort?.abort()
            this.panelAbort = null
            panel.status = 'cancelled'
            this.resolvePanelSettled()
        }
        for (const finding of this.findings.list()) {
            if (finding.threadTurn?.status === 'pending') {
                this.findings.failThreadTurn(finding.id, 'Cancelled')
            }
        }
        let changed = false
        for (const state of this.states.values()) {
            if (!state.terminal) {
                // Abort the retry attempt's own controller (initial attempts
                // ride the shared signal aborted above). Also ejects a
                // permit-queued retry waiter immediately.
                state.attemptAbort?.abort()
                state.terminal = true
                state.status = 'cancelled'
                state.anchorBase = null
                // Reclaim the permit NOW: the aborted stream may keep
                // draining (or, for an abort-ignoring executor, never end),
                // and queued editors of other runs must not wait on it.
                this.releasePermitOf(state)
                changed = true
            }
        }
        if (changed) {
            this.notify()
        }
    }

    applyTextChanges(changes: readonly TextChange[]): void {
        if (changes.length === 0) {
            return
        }
        // The replay history only exists to remap findings that arrive
        // mid-edit (`ingestFinding`), so it is recorded per editor and only
        // while that editor can still produce findings (non-terminal). This
        // both stops the per-keystroke growth the moment an editor settles
        // AND restarts recording from the retry snapshot when `retryEditor`
        // resets an editor's anchor base. One frozen copy is shared across
        // editors — batches are never mutated after recording.
        let copy: TextChange[] | null = null
        for (const state of this.states.values()) {
            if (state.anchorBase !== null) {
                copy ??= [...changes]
                state.anchorBase.batches.push(copy)
            }
        }
        this.findings.applyTextChanges(changes)
    }

    retryEditor(editorId: string, freshText: string): RetryEditorResult {
        const state = this.states.get(editorId)
        const spec = this.specs.get(editorId)
        if (!state || !spec) {
            return { ok: false, reason: 'unknown-editor' }
        }
        // Only terminal-with-failure editors are retryable: 'done' produced a
        // valid result, and a pending/running editor is already working.
        if (!state.terminal || (state.status !== 'error' && state.status !== 'cancelled')) {
            return { ok: false, reason: 'not-retryable' }
        }
        // The retry REPLACES the failed attempt's findings (see the interface
        // doc): remove them from the store — decorations/panels drop them on
        // the next refresh — and reset the dedupe keys so the new attempt may
        // legitimately re-report the same critique.
        this.findings.removeMany(state.findingIds)
        state.findingIds = []
        state.seenFindingKeys.clear()
        // Fresh attempt identity: late events from the previous attempt's
        // still-draining stream carry the old runId and are discarded.
        state.runId = asRunId(generateId())
        state.status = 'pending'
        state.terminal = false
        state.summary = null
        state.verdict = null
        state.lastProgress = null
        state.error = null
        // Retried findings anchor against the CURRENT document text passed by
        // the caller, then remap through edits applied after this point.
        state.anchorBase = { text: freshText, batches: [] }
        // Retrying a member re-opens the panel: the scorecard that named this
        // member missing (or that was cancelled with the run) is about to be
        // wrong, so it is discarded and re-derived when the run settles again.
        const panel = this.panel
        if (panel) {
            this.panelEpoch += 1
            this.panelAbort?.abort()
            this.panelAbort = null
            panel.status = 'waiting'
            panel.missingMembers = []
            panel.result = null
            panel.error = null
        }
        const attempt = new AbortController()
        state.attemptAbort = attempt
        // Not tracked by `settled` (already resolved after the initial
        // settle); `isSettled()` derives from the state and reports the run
        // as in progress until this loop terminates the editor.
        void this.consume(spec, state, attempt.signal)
        this.notify()
        return { ok: true }
    }

    startThreadTurn(input: StartThreadTurnInput): StartThreadTurnResult {
        const finding = this.findings.get(input.findingId)
        const begun = this.findings.beginThreadTurn(input.findingId, input.message)
        if (!begun.ok) {
            return { ok: false, reason: begun.reason }
        }
        // `beginThreadTurn` succeeded, so the finding exists; the pre-read is
        // what gives us the history WITHOUT the message just recorded (which
        // travels as `message`, not as a history turn).
        const history = (finding?.thread ?? []).map((turn) => ({
            role: turn.role,
            content: turn.content
        }))
        const request: ThreadTurnRequest = {
            kind: 'thread-turn',
            contractVersion: CONTRACT_VERSION,
            runId: asRunId(generateId()),
            // The run's snapshot identifies the review this finding came from;
            // `quote` carries the live span text (which may have drifted since).
            // Documented at the contract itself — see `baseRequest.snapshotHash`.
            snapshotHash: this.snapshot.hash,
            findingId: input.findingId,
            quote: input.quote,
            // The CURRENT critique: an earlier turn may already have sharpened
            // it, and the editor must argue from where the thread stands.
            critique: begun.finding.raw.critique,
            history,
            message: begun.finding.threadTurn?.message ?? input.message.trim()
        }
        return { ok: true, settled: this.consumeThreadTurn(input, request) }
    }

    /**
     * Runs one thread turn to completion and writes the outcome into the
     * store. Same event protocol as reviews (runId match, exactly-once
     * terminal, post-terminal discard, stream end without terminal =
     * invalid-output) and the same concurrency permit; findings emitted by a
     * thread turn are off-contract and discarded.
     */
    private async consumeThreadTurn(
        input: StartThreadTurnInput,
        request: ThreadTurnRequest
    ): Promise<ThreadTurnResolution> {
        const abort = new AbortController()
        this.threadAborts.add(abort)
        const signal = abort.signal
        const fail = (reason: string): ThreadTurnResolution => {
            const redacted = input.redactError ? input.redactError(reason) : reason
            return this.findings.failThreadTurn(input.findingId, redacted) === null
                ? { status: 'discarded' }
                : { status: 'failed', reason: redacted }
        }
        const cancelled = (): ThreadTurnResolution => {
            this.findings.failThreadTurn(input.findingId, 'Cancelled')
            return { status: 'cancelled' }
        }
        try {
            let release: ReleasePermit
            try {
                release = await this.requestGate.acquire(signal)
            } catch {
                return cancelled() // ejected from the queue by the abort
            }
            if (signal.aborted) {
                // Cancelled while queued but the permit resolved first: never
                // open a stream on a dead signal (an executor that only
                // listens for the abort EVENT would hang forever).
                release()
                return cancelled()
            }
            try {
                let resolution: ThreadTurnResolution | null = null
                try {
                    for await (const event of input.execute(request, signal)) {
                        if (resolution === null && signal.aborted) {
                            // Cancelled mid-stream: settle now and discard
                            // whatever the winding-down stream still yields.
                            resolution = cancelled()
                        }
                        if (resolution !== null || event.runId !== request.runId) {
                            continue // post-terminal or foreign run: discard
                        }
                        if (event.type === 'progress' || event.type === 'finding') {
                            continue // no progress surface for a turn; findings are off-contract
                        }
                        if (event.type === 'error') {
                            resolution =
                                event.error.code === 'cancelled'
                                    ? cancelled()
                                    : fail(event.error.message)
                            continue
                        }
                        if (event.result.kind !== 'thread-turn') {
                            resolution = fail(
                                `Expected a 'thread-turn' result, got '${event.result.kind}'`
                            )
                            continue
                        }
                        resolution = this.landThreadOutcome(input.findingId, event.result)
                    }
                } catch (cause) {
                    if (resolution === null) {
                        resolution = signal.aborted
                            ? cancelled()
                            : fail(cause instanceof Error ? cause.message : String(cause))
                    }
                }
                return (
                    resolution ??
                    (signal.aborted ? cancelled() : fail('Stream ended without a terminal event'))
                )
            } finally {
                release()
            }
        } finally {
            this.threadAborts.delete(abort)
        }
    }

    private landThreadOutcome(
        findingId: FindingId,
        result: Extract<OperationResult, { kind: 'thread-turn' }>
    ): ThreadTurnResolution {
        const outcome = resolveThreadOutcome(result)
        if (this.findings.completeThreadTurn(findingId, outcome) === null) {
            return { status: 'discarded' }
        }
        if (outcome.kind === 'concede') {
            return { status: 'conceded', reply: outcome.reply }
        }
        return {
            status: 'held',
            reply: outcome.reply,
            revised: outcome.revisedSuggestion !== null || outcome.revisedCritique !== null
        }
    }

    private async consume(
        spec: RunEditorSpec,
        state: InternalEditorState,
        signal: AbortSignal
    ): Promise<void> {
        if (state.terminal) {
            return
        }
        // Attempt identity guard: if a retry resets the state while THIS
        // loop's (post-terminal, still-draining) iterator winds down, the
        // stale loop must never terminate or mutate the newer attempt.
        const attemptRunId = state.runId
        const ownsAttempt = (): boolean => !state.terminal && state.runId === attemptRunId
        // Global concurrency gate (`behavior.maxConcurrentRequests`): the
        // backend stream must not start until a permit is free. The gate is
        // shared across ALL runs (owned by the RunController), so at most N
        // backend requests are in flight plugin-wide. While queued the editor
        // keeps its initial 'pending' status — the rail/panel truthfully show
        // it as not yet started. Cancelling the run aborts `this.abort`,
        // which ejects the queued waiter immediately (no zombie waiter, no
        // permit consumed); `cancelRun` already marked the state cancelled.
        let release: ReleasePermit
        try {
            release = await this.requestGate.acquire(signal)
        } catch {
            if (ownsAttempt()) {
                this.terminate(state, 'cancelled', null)
            }
            return
        }
        if (!ownsAttempt()) {
            release()
            return // cancelled (or superseded by a retry) while queued
        }
        state.releasePermit = release
        try {
            // The backend must review the SAME text findings are anchored
            // against: the attempt's anchor base (run snapshot initially,
            // fresh current text on retry) — otherwise a retried editor's
            // quotes would target text that no longer exists. A selection
            // scope only rides along while the attempt text IS the snapshot
            // text: against changed text the offsets are meaningless, so a
            // retry after edits reviews the whole note (never a guessed
            // range, Business Rules #4).
            const attemptText = state.anchorBase?.text ?? this.snapshot.text
            const request: ReviewRequest = {
                kind: 'review',
                contractVersion: CONTRACT_VERSION,
                runId: attemptRunId,
                snapshotHash:
                    attemptText === this.snapshot.text ? this.snapshot.hash : hashText(attemptText),
                text: attemptText,
                ...(this.snapshot.selection && attemptText === this.snapshot.text
                    ? { selection: { ...this.snapshot.selection } }
                    : {})
            }
            state.status = 'running'
            this.notify()
            try {
                for await (const event of spec.execute(request, signal)) {
                    if (state.terminal) {
                        continue // post-terminal or post-cancel: discard
                    }
                    if (event.runId !== state.runId) {
                        continue // foreign run or stale attempt: discard
                    }
                    this.handleEvent(spec, state, event)
                }
            } catch (cause) {
                if (ownsAttempt()) {
                    if (signal.aborted) {
                        this.terminate(state, 'cancelled', null)
                    } else {
                        this.terminate(state, 'error', {
                            code: 'unknown',
                            message: redactMessage(
                                spec,
                                cause instanceof Error ? cause.message : String(cause)
                            )
                        })
                    }
                }
            }
            if (ownsAttempt()) {
                if (signal.aborted) {
                    this.terminate(state, 'cancelled', null)
                } else {
                    this.terminate(state, 'error', {
                        code: 'invalid-output',
                        message: 'Stream ended without a terminal event'
                    })
                }
            }
        } finally {
            // Backstop only: the permit is normally freed the moment the
            // editor goes terminal (`terminate` / `cancelRun`) so a stream
            // that keeps draining — or never ends — cannot starve other
            // editors. Exactly-once by construction: `release` is idempotent,
            // and this finally covers every exit (done, error, cancel,
            // thrown stream).
            release()
        }
    }

    private handleEvent(
        spec: RunEditorSpec,
        state: InternalEditorState,
        event: OperationEvent
    ): void {
        switch (event.type) {
            case 'progress':
                state.lastProgress = event.message ?? null
                this.notify()
                return
            case 'finding':
                this.ingestFinding(spec, state, event.finding)
                return
            case 'result':
                if (event.result.kind !== 'review') {
                    this.terminate(state, 'error', {
                        code: 'invalid-output',
                        message: `Expected a review result, got '${event.result.kind}'`
                    })
                    return
                }
                for (const raw of event.result.findings) {
                    this.ingestFinding(spec, state, raw)
                }
                state.summary = event.result.summary ?? null
                state.verdict = event.result.verdict ?? null
                this.terminate(state, 'done', null)
                return
            case 'error':
                if (event.error.code === 'cancelled') {
                    this.terminate(state, 'cancelled', null)
                } else {
                    this.terminate(state, 'error', {
                        code: event.error.code,
                        message: redactMessage(spec, event.error.message)
                    })
                }
                return
        }
    }

    /**
     * Anchors a raw finding against the editor's attempt anchor base (run
     * snapshot for initial attempts, fresh retry text for retries) and
     * registers it. Ambiguous or unmatched quotes yield an unanchored
     * (display-only) finding — never a guessed position (Business Rules #4).
     * The fresh anchor (base coordinates) is replayed through every edit
     * applied since the attempt started, so a finding arriving mid-edit is
     * either remapped to current coordinates or marked stale — never left on
     * stale base offsets. Findings arriving both as stream events and inside
     * the terminal result are deduped by content.
     */
    private ingestFinding(spec: RunEditorSpec, state: InternalEditorState, raw: RawFinding): void {
        // The key must include the locating hints: the prompt instructs models to
        // disambiguate repeated text via `occurrence`/`prefix`/`suffix`, so two
        // findings on different occurrences of the same quote are legitimately
        // distinct and must not collapse into one. Only true stream-vs-result
        // duplicates (identical in every field) are deduped.
        const key = JSON.stringify([
            raw.quote,
            raw.critique,
            raw.suggestion ?? '',
            raw.occurrence ?? null,
            raw.prefix ?? '',
            raw.suffix ?? ''
        ])
        if (state.seenFindingKeys.has(key)) {
            return
        }
        state.seenFindingKeys.add(key)

        // Defensive: `ingestFinding` only runs pre-terminal, where the base
        // is always set; a missing base degrades to unanchored (display-only)
        // rather than guessing against possibly-wrong text.
        const base = state.anchorBase
        let anchor: Anchor | null = null
        let anchoredText: string | null = null
        let matchStrategy: MatchStrategy | null = null
        if (base) {
            const match = matchQuote(base.text, raw.quote, {
                prefix: raw.prefix,
                suffix: raw.suffix,
                occurrence: raw.occurrence
            })
            if (match.status === 'matched') {
                anchor = createAnchor(match.match.from, match.match.to)
                anchoredText = base.text.slice(match.match.from, match.match.to)
                matchStrategy = match.match.strategy
                for (const batch of base.batches) {
                    anchor = mapAnchorThroughChanges(anchor, batch)
                }
            }
        }

        const id = asFindingId(generateId())
        state.findingIds.push(id)
        // `add` fires the store's onChange, which notifies subscribers.
        this.findings.add({
            id,
            runId: state.runId,
            editorId: spec.editorId,
            raw,
            anchor,
            anchoredText,
            matchStrategy
        })
    }

    private terminate(
        state: InternalEditorState,
        status: EditorRunStatus,
        error: OperationErrorInfo | null
    ): void {
        state.terminal = true
        state.status = status
        state.error = error
        // No further finding can arrive for this attempt: drop the anchor
        // base so edit batches stop accumulating for this editor (and the
        // retry text, when any, is released).
        state.anchorBase = null
        // Terminal = this editor's backend work is over from the run's point
        // of view; free the permit immediately rather than waiting for the
        // (possibly still-draining, possibly never-ending) stream to close.
        this.releasePermitOf(state)
        // The last member to settle opens the aggregation step (no-op until
        // then, and no-op for a solo run).
        this.maybeAggregate()
        this.notify()
    }

    // -----------------------------------------------------------------------
    // Panel aggregation (plan M6)
    // -----------------------------------------------------------------------

    /**
     * Opens the aggregation step once every member has settled. Synchronous
     * and idempotent: it only acts while the panel sits at `waiting`, so a
     * cancelled panel stays cancelled and a produced scorecard is never
     * recomputed behind the user's back.
     *
     * The partial-failure policy itself lives in `planPanelAggregation` — this
     * only turns its verdict into run state and, when there is something to
     * synthesize, into one backend request.
     */
    private maybeAggregate(): void {
        const panel = this.panel
        if (!panel || panel.status !== 'waiting' || !this.isSettled()) {
            return
        }
        const plan = planPanelAggregation(this.memberReviews())
        panel.missingMembers = [...plan.missingMembers]
        if (plan.kind === 'skip') {
            panel.status = 'skipped'
            this.resolvePanelSettled()
            return
        }
        const aggregate = this.panelSpec?.aggregate
        if (!aggregate) {
            panel.status = 'unavailable'
            this.resolvePanelSettled()
            return
        }
        panel.status = 'running'
        const attempt = new AbortController()
        this.panelAbort = attempt
        void this.consumeAggregation(aggregate, plan, attempt.signal, this.panelEpoch)
    }

    /** Each member's state as the aggregation policy needs to see it. */
    private memberReviews(): PanelMemberReview[] {
        return [...this.states.values()].map((state) => ({
            editorName: state.editorName,
            status: state.status,
            findings: state.findingIds.flatMap((id) => {
                const finding = this.findings.get(id)
                return finding ? [finding.raw] : []
            }),
            summary: state.summary,
            verdict: state.verdict
        }))
    }

    /**
     * Runs one aggregation attempt to completion. Same event protocol as a
     * review (runId match, exactly-once terminal, post-terminal discard, stream
     * end without terminal = a failure, never silent success) and the same
     * plugin-wide concurrency permit: the scorecard is a backend request like
     * any other and must not jump the queue in front of another note's run.
     *
     * Findings emitted by an aggregation are off-contract and discarded — a
     * chairperson weighs its members, it does not add critiques of its own.
     */
    private async consumeAggregation(
        aggregate: PanelAggregationExecutor,
        plan: Extract<PanelAggregationPlan, { kind: 'aggregate' }>,
        signal: AbortSignal,
        epoch: number
    ): Promise<void> {
        const settle = (
            status: PanelAggregationStatus,
            result: PanelResult | null,
            error: string | null
        ): void => {
            const panel = this.panel
            // Superseded by a retry, or cancelled while in flight: the attempt
            // no longer owns the panel and must not write to it.
            if (!panel || epoch !== this.panelEpoch || panel.status !== 'running') {
                return
            }
            panel.status = status
            panel.result = result
            panel.error = error
            this.resolvePanelSettled()
            this.notify()
        }
        const fail = (message: string): void => {
            const redact = this.panelSpec?.redactError
            settle('error', null, redact ? redact(message) : message)
        }
        const request: AggregatePanelRequest = {
            kind: 'aggregate-panel',
            contractVersion: CONTRACT_VERSION,
            runId: asRunId(generateId()),
            snapshotHash: this.snapshot.hash,
            members: plan.members
        }
        try {
            let release: ReleasePermit
            try {
                release = await this.requestGate.acquire(signal)
            } catch {
                settle('cancelled', null, null) // ejected from the queue by the abort
                return
            }
            if (signal.aborted) {
                // Cancelled while queued but the permit resolved first: never
                // open a stream on a dead signal.
                release()
                settle('cancelled', null, null)
                return
            }
            try {
                let terminal = false
                try {
                    for await (const event of aggregate(request, signal)) {
                        if (terminal || event.runId !== request.runId) {
                            continue // post-terminal or foreign run: discard
                        }
                        if (event.type === 'progress' || event.type === 'finding') {
                            continue
                        }
                        terminal = true
                        if (event.type === 'error') {
                            if (event.error.code === 'cancelled') {
                                settle('cancelled', null, null)
                            } else {
                                fail(event.error.message)
                            }
                            continue
                        }
                        if (event.result.kind !== 'aggregate-panel') {
                            fail(`Expected an 'aggregate-panel' result, got '${event.result.kind}'`)
                            continue
                        }
                        settle('done', event.result, null)
                    }
                } catch (cause) {
                    if (!terminal) {
                        terminal = true
                        if (signal.aborted) {
                            settle('cancelled', null, null)
                        } else {
                            fail(cause instanceof Error ? cause.message : String(cause))
                        }
                    }
                }
                if (!terminal) {
                    if (signal.aborted) {
                        settle('cancelled', null, null)
                    } else {
                        fail('Stream ended without a terminal event')
                    }
                }
            } finally {
                release()
            }
        } finally {
            if (epoch === this.panelEpoch) {
                this.panelAbort = null
            }
        }
    }

    /** Frees the editor's concurrency permit, if held. Idempotent. */
    private releasePermitOf(state: InternalEditorState): void {
        const release = state.releasePermit
        state.releasePermit = null
        release?.()
    }

    private notify(): void {
        for (const listener of [...this.listeners]) {
            try {
                listener()
            } catch {
                // A faulty subscriber must never break orchestration.
            }
        }
    }
}

/**
 * Routes an outbound error message through the editor's redaction seam so
 * secret material embedded in transport/provider errors never reaches
 * user-visible state (Business Rules #12).
 */
function redactMessage(spec: RunEditorSpec, message: string): string {
    return spec.redactError ? spec.redactError(message) : message
}

function toPublicState(state: InternalEditorState): EditorRunState {
    return {
        editorId: state.editorId,
        editorName: state.editorName,
        runId: state.runId,
        status: state.status,
        findingIds: [...state.findingIds],
        summary: state.summary,
        verdict: state.verdict,
        lastProgress: state.lastProgress,
        error: state.error
    }
}

/**
 * Manages review runs per file: at most one active run per file path.
 * Starting a new run for a file cancels the previous one (its late events
 * are discarded by the cancelled handle).
 *
 * Also owns the plugin-wide backend concurrency gate: at most
 * `getMaxConcurrentRequests()` backend requests are in flight across ALL
 * runs combined (`behavior.maxConcurrentRequests`). The limit is read at
 * each admission decision, so a settings change applies to subsequent
 * acquisitions — requests already in flight are never killed. Editors
 * waiting for a permit stay 'pending'.
 */
export class RunController {
    private readonly runs = new Map<string, RunHandle>()
    /**
     * The plugin-wide backend concurrency gate. Public so sibling
     * controllers running non-review operations (`TransformController`)
     * share the SAME budget — `behavior.maxConcurrentRequests` bounds
     * reviews and transforms combined, not each family separately.
     */
    readonly requestGate: Semaphore

    /**
     * @param getMaxConcurrentRequests Live view of the settings value; the
     * default (unlimited) keeps headless/test callers unthrottled unless they
     * opt in.
     */
    constructor(getMaxConcurrentRequests: () => number = () => Number.POSITIVE_INFINITY) {
        this.requestGate = new Semaphore(getMaxConcurrentRequests)
    }

    startRun(input: StartRunInput): RunHandle {
        const existing = this.runs.get(input.snapshot.filePath)
        if (existing) {
            existing.cancelRun()
        }
        const run = new ReviewRunHandle(input, this.requestGate)
        this.runs.set(input.snapshot.filePath, run)
        return run
    }

    /** The current (possibly settled) run for a file, if any. */
    getRun(filePath: string): RunHandle | null {
        return this.runs.get(filePath) ?? null
    }

    /**
     * The run tracking the given finding, if any. Finding ids are UUIDs
     * (globally unique across runs), so the first match is the only match.
     * Used by the review card lookup, which only knows a finding id — the
     * card renders inside an editor view but the id → run resolution must
     * not depend on which view was clicked.
     */
    findRunWithFinding(findingId: FindingId): RunHandle | null {
        for (const run of this.runs.values()) {
            if (run.findings.get(findingId)) {
                return run
            }
        }
        return null
    }

    /**
     * Cancels and forgets the run for a file (file closed, deleted or
     * renamed). Each retained run pins the full snapshot text plus its
     * finding store, so runs must be discarded rather than left to
     * accumulate for the lifetime of the plugin.
     */
    discardRun(filePath: string): void {
        const run = this.runs.get(filePath)
        if (!run) {
            return
        }
        run.cancelRun()
        this.runs.delete(filePath)
    }

    /** Cancels every active run and forgets them (e.g. on plugin unload). */
    cancelAll(): void {
        for (const run of this.runs.values()) {
            run.cancelRun()
        }
        this.runs.clear()
    }
}
