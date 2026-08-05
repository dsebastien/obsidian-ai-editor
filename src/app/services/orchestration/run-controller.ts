import type { Anchor, TextChange } from '../../domain/anchoring/anchor'
import { createAnchor, mapAnchorThroughChanges } from '../../domain/anchoring/anchor'
import type { MatchStrategy } from '../../domain/anchoring/match'
import { createQuoteMatcher, type QuoteMatcher } from '../../domain/anchoring/match'
import type { FindingId, RunId } from '../../domain/ids'
import { asFindingId, asRunId, generateId } from '../../domain/ids'
import type {
    AggregatePanelRequest,
    OperationEvent,
    OperationResult,
    PanelResult,
    RawEdit,
    RawFinding,
    ReportedFinding,
    ReviewRequest,
    ThreadTurnRequest,
    Verdict
} from '../../domain/operations/contract'
import { CONTRACT_VERSION } from '../../domain/operations/contract'
import { anchorsOverlap, observationIdentity } from '../../domain/operations/cross-run'
import type { TrackedEdit } from '../../domain/operations/edit-apply'
import { rawFindingIdentity } from '../../domain/operations/finding-identity'
import { planPanelAggregation } from '../../domain/panels/panel-aggregation'
import { isPathUnder } from '../../domain/path-scope'
import type {
    PanelAggregationBudget,
    PanelAggregationPlan,
    PanelMemberReview
} from '../../domain/panels/panel-aggregation'
import { resolveThreadOutcome } from '../../domain/operations/thread'
import type { ThreadBeginFailure } from '../../domain/operations/thread'
import type { DocumentSnapshot } from '../../domain/snapshot'
import { hashText } from '../../domain/snapshot'
import { FindingStore } from './finding-store'
import type { TrackedFinding } from './finding-store'
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

/**
 * Caps on the "already reported" echo of a continuation request, matching
 * `reportedFindingSchema`. They exist so a long first round cannot crowd the
 * document out of the second one's context window.
 */
const REPORTED_CRITIQUE_MAX = 1_000
const REPORTED_FINDINGS_MAX = 200

export type OperationErrorInfo = Extract<OperationEvent, { type: 'error' }>['error']

/** Outcome of `RunHandle.retryEditor`. */
export type RetryEditorResult =
    | { readonly ok: true }
    | { readonly ok: false; readonly reason: 'unknown-editor' | 'not-retryable' }

/** Outcome of `RunHandle.continueEditor` ("Generate more"). */
export type ContinueEditorResult =
    | { readonly ok: true }
    | { readonly ok: false; readonly reason: 'unknown-editor' | 'not-continuable' }

/** Outcome of `RunHandle.addEditor` (joining a run, 2026-08-04). */
export type AddEditorResult =
    | { readonly ok: true }
    | { readonly ok: false; readonly reason: 'already-in-run' }

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
    /**
     * What the aggregation request may spend (plan M6). Absent leaves the
     * operation contract's caps as the only limit — fine for a test double,
     * never for a real run over a long note.
     */
    readonly budget?: PanelAggregationBudget
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
     * Every member editor name of this run, in run order. The roster the
     * scorecard is checked against: `memberVerdicts` is model-authored text,
     * so a chairperson that invents or misspells a member must not be able to
     * add a row for an editor that never ran (Business Rules #4 applied to the
     * synthesis — only what is verifiably ours is rendered as structure).
     */
    readonly memberNames: readonly string[]
    /**
     * Member editor names that did not produce a review, in run order. Filled
     * as soon as the members settle — so the partial nature of a panel is
     * visible whether or not the aggregation itself succeeds.
     */
    readonly missingMembers: readonly string[]
    readonly result: PanelResult | null
    /**
     * True when `result` was produced by an EARLIER attempt that a
     * continuation ("Generate more") has since re-opened: the scorecard is
     * still accurate about what it weighed, but a member is adding to its
     * findings, so the synthesis is about to be rewritten. Never true for a
     * retry — a retry destroys the member findings the scorecard points at.
     */
    readonly resultStale: boolean
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
    /**
     * Live document accessor, read when the turn LANDS: a held turn's
     * `revisedEdits` (contract v2) anchor against the text as it reads then.
     * `null`/absent (note no longer open) degrades the revised proposal to
     * display-only — never guessed against stale text (BR #3/#4).
     */
    readonly currentText?: () => string | null
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
    /**
     * True while a "Generate more" pass is in flight for this editor. The
     * status is `pending`/`running` meanwhile, exactly like a first attempt —
     * this only tells surfaces that the findings already on screen are being
     * ADDED TO, not replaced.
     */
    readonly continuing: boolean
    /**
     * Why the last continuation pass produced nothing (redacted), or null.
     *
     * A failed continuation deliberately does NOT put the editor into `error`:
     * it stays `done` with the findings of the successful pass intact. Marking
     * it failed would offer Retry, and Retry REPLACES an editor's findings —
     * one click would then destroy work the user was mid-triage on because a
     * second, optional pass timed out.
     */
    readonly continuationError: string | null
    /**
     * What the salvage pass removed from this editor's output across passes
     * (contract v2 design §5): findings discarded for an invalid observation
     * core, and proposals stripped for invalid edits. `null` = nothing.
     */
    readonly salvage: {
        readonly discardedFindings: number
        readonly invalidProposals: number
    } | null
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
     *
     * EDITOR-ONLY on purpose: the aggregation step only opens once this is
     * true (`maybeAggregate`), and the CLI's first-settle semantics are about
     * the member streams. Surfaces asking "is anything still running" must use
     * `isBusy()` — a run whose scorecard is being written is NOT idle.
     */
    isSettled(): boolean
    /**
     * Whether the run still has backend work in flight — every editor plus the
     * panel's aggregation step. This is what the busy surfaces gate on (Cancel
     * command, `editor-ai-daemons cancel`, the rail's Cancel/spinner, the side-panel
     * Review button, the daemon's dispatch probe): during aggregation the
     * editors are all terminal, so `isSettled()` alone would hide Cancel,
     * report `already-settled`, and let a new run cancel-replace a scorecard
     * the user is paying for mid-request.
     */
    isBusy(): boolean
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
     * Decision (Architecture.md § Run lifecycle beyond the first pass): a retry REPLACES
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
     * Asks ONE editor for MORE findings without discarding the ones it already
     * produced ("Generate more", plan M6). The opposite of `retryEditor` in
     * every respect that matters:
     *
     * - findings are KEPT, and the new ones are appended to the same run;
     * - the editor's dedupe keys are kept too, so a literal repeat of an
     *   earlier finding is dropped on arrival rather than shown twice — and
     *   the request additionally carries what was already reported, so the
     *   backend is asked not to repeat itself in the first place;
     * - only a `done` editor is continuable. A failed one needs `retryEditor`
     *   (there is nothing to build on), and a running one is already working.
     *
     * `freshText` MUST be the CURRENT document text at call time: the new
     * findings anchor against it as a fresh per-editor anchor base, exactly
     * like a retry (Business Rules #3/#4). The pass therefore reads the note
     * as it is NOW, which is also what the user is looking at.
     *
     * One call is one round. There is no automatic re-ask: every pass is a
     * backend request the user pays for, so it stays an explicit action.
     */
    continueEditor(editorId: string, freshText: string): ContinueEditorResult
    /**
     * Adds one MORE editor to this run and dispatches it immediately through
     * the same concurrency gate (live-round feedback, 2026-08-04): summoning
     * an editor that is not part of the note's run must QUEUE onto it, never
     * cancel it. The editor enters as a first attempt — 'pending', its
     * findings anchoring against `freshText` (the live buffer at call time,
     * Business Rules #3/#4) — and every run surface picks it up through the
     * derived `isSettled()`, exactly like a retry after settle.
     *
     * Boundaries, stated because they are all deliberate:
     * - an editor already in the run (any status) is refused — that gesture
     *   is retry, Generate more, or nothing;
     * - joining a PANEL run does not touch the roster: the scorecard stays a
     *   statement about the members, the joiner reports as a loose editor
     *   (its findings simply do not enter the member reconciliation);
     * - the original `settled` promise is NOT reset (it cannot un-resolve);
     * - `cancelRun` aborts a joined attempt like any other (per-attempt
     *   controller, same as retries).
     */
    addEditor(spec: RunEditorSpec, freshText: string): AddEditorResult
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
 * Read-only observer of run outcomes (issue #21 — the history archive).
 * Called AFTER the store settled, never consulted for decisions: history is
 * a record of what happened, not a participant. Every callback is wrapped in
 * a try/catch at the call site — an archive must never break a run.
 */
export interface RunObserver {
    /** One editor finished a pass; `findings` are the ones it produced that
     * were not already recorded (continuations report only their additions). */
    editorSettled(input: {
        readonly filePath: string
        readonly editorId: string
        readonly editorName: string
        readonly findings: readonly TrackedFinding[]
    }): void
    /** A push-back turn landed (conceded or held). */
    threadSettled(input: {
        readonly filePath: string
        readonly editorId: string
        readonly editorName: string
        readonly quote: string
        readonly message: string
        readonly reply: string
        readonly outcome: 'held' | 'conceded'
    }): void
    /** A panel scorecard was produced. */
    panelSettled(input: {
        readonly filePath: string
        readonly panelName: string
        readonly result: PanelResult
    }): void
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
    /**
     * Bound to `text`. ONE per attempt, not one per finding: a review ingests
     * up to 200 findings against the same text, and a quote that misses the
     * exact rung costs a full normalization pass over the note (measured:
     * 2.8 s for 200 such quotes on a 200 000-character note, 15 ms once the
     * pass is shared — `perf/perf.bench.spec.ts`).
     */
    readonly matcher: QuoteMatcher
    readonly batches: TextChange[][]
}

/** The text an anchor base resolves quotes against. */
function anchorBaseText(base: AnchorBase | null): string | null {
    return base?.matcher.text ?? null
}

function createAnchorBase(text: string): AnchorBase {
    return { matcher: createQuoteMatcher(text), batches: [] }
}

/** The finding-level anchoring outcome an own-quote-less edit copies. */
interface FindingAnchorOutcome {
    readonly anchor: Anchor | null
    readonly anchoredText: string | null
    readonly matchStrategy: MatchStrategy | null
}

/**
 * Resolves a proposal's raw edits into tracked edits (contract v2 design §2):
 * an edit carrying its own `quote` anchors independently through the matcher
 * ladder (then replays the same edit batches the finding's anchor replayed);
 * an edit without one copies the finding's outcome. No matcher (no anchor
 * base — terminal attempt) degrades to unanchored, never guesses (BR #4).
 * Shared by review ingestion and the thread revision path so the two can
 * never anchor the same shape differently.
 */
function resolveTrackedEdits(
    edits: readonly RawEdit[],
    matcher: QuoteMatcher | null,
    batches: readonly (readonly TextChange[])[],
    finding: FindingAnchorOutcome
): TrackedEdit[] {
    return edits.map((edit) => {
        const text = edit.op === 'delete' ? '' : (edit.text ?? '')
        if (edit.quote === undefined) {
            return {
                op: edit.op,
                text,
                anchor: finding.anchor,
                anchoredText: finding.anchoredText,
                matchStrategy: finding.matchStrategy
            }
        }
        if (matcher === null) {
            return { op: edit.op, text, anchor: null, anchoredText: null, matchStrategy: null }
        }
        const match = matcher.match(edit.quote, {
            prefix: edit.prefix,
            suffix: edit.suffix,
            occurrence: edit.occurrence
        })
        if (match.status !== 'matched') {
            return { op: edit.op, text, anchor: null, anchoredText: null, matchStrategy: null }
        }
        let anchor = createAnchor(match.match.from, match.match.to)
        const anchoredText = matcher.text.slice(match.match.from, match.match.to)
        for (const batch of batches) {
            anchor = mapAnchorThroughChanges(anchor, batch)
        }
        return {
            op: edit.op,
            text,
            anchor,
            anchoredText,
            matchStrategy: match.match.strategy
        }
    })
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
    /** Salvage losses across this editor's passes (null = nothing removed). */
    salvage: { discardedFindings: number; invalidProposals: number } | null
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
    /**
     * True while the CURRENT attempt is a "Generate more" pass. Drives three
     * things: the request carries `alreadyReported`, a missing summary/verdict
     * does not erase the first pass's, and a non-`done` outcome restores the
     * editor to `done` with `continuationError` instead of marking it failed
     * (see `EditorRunState.continuationError` for why).
     */
    continuing: boolean
    continuationError: string | null
}

/** Mutable twin of `PanelRunState` (the public view is a copy). */
interface InternalPanelState {
    readonly panelId: string
    readonly panelName: string
    readonly memberNames: readonly string[]
    status: PanelAggregationStatus
    missingMembers: string[]
    result: PanelResult | null
    resultStale: boolean
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

    // -- Cross-run carryover bookkeeping (issue #19) ------------------------
    /**
     * Per editor: carried findings not yet resolved against the new round.
     * Resolution empties it — by adoption (observation repeated), by drop
     * (round done, not repeated, in scope) or by keep (round failed, or out
     * of a selection-scoped round's scope).
     */
    private readonly pendingCarryover = new Map<string, Set<FindingId>>()
    /**
     * Every finding id that entered this run as carryover — adopted or not.
     * `retryEditor` uses it to tell "carried, must survive a retry re-dimmed"
     * from "this round's own finding, replaced by the retry".
     */
    private readonly carryoverOrigin = new Set<FindingId>()
    /** Cached observation identity per carried finding (strict match key). */
    private readonly carryoverKeys = new Map<FindingId, string>()
    /**
     * Carried findings outside a selection-scoped run's range (or with no
     * anchor while a selection is set): the round makes no statement about
     * them, so an unmatched one is KEPT, never dropped.
     */
    private readonly carryoverOutOfScope = new Set<FindingId>()

    /** Finding ids already reported to the observer (issue #21). */
    private readonly reportedToObserver = new Set<FindingId>()

    constructor(
        input: StartRunInput,
        private readonly requestGate: Semaphore,
        carryover: readonly TrackedFinding[] = [],
        private readonly observer: RunObserver | null = null
    ) {
        this.snapshot = input.snapshot
        this.findings = new FindingStore(() => this.notify())
        this.panelSpec = input.panel ?? null
        this.panel = input.panel
            ? {
                  panelId: input.panel.panelId,
                  panelName: input.panel.panelName,
                  // The roster, captured from the specs the run was started
                  // with: the scorecard is reconciled against it rather than
                  // trusting the names the chairperson writes back.
                  memberNames: input.editors.map((spec) => spec.editorName),
                  status: 'waiting',
                  missingMembers: [],
                  result: null,
                  resultStale: false,
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
                salvage: null,
                terminal: false,
                seenFindingKeys: new Set(),
                releasePermit: null,
                // Initial attempts all anchor against the run snapshot; the
                // batch lists are per editor because retries reset them
                // independently.
                anchorBase: createAnchorBase(input.snapshot.text),
                attemptAbort: null,
                continuing: false,
                continuationError: null
            })
        }

        // -- Cross-run carryover (issue #19) --------------------------------
        // The replaced run's findings enter this run's store BEFORE any
        // stream starts: they stay on screen (dimmed) through the whole wait,
        // keep their triage status and thread history, and each editor
        // resolves them against what it re-reports (`ingestFinding` /
        // `terminate`). Only editors participating in THIS run carry —
        // a deselected editor's findings die with its run, as before.
        if (carryover.length > 0) {
            // One shared matcher, same rationale as `AnchorBase`.
            const matcher = createQuoteMatcher(input.snapshot.text)
            const selection = input.snapshot.selection ?? null
            for (const previous of carryover) {
                const state = this.states.get(previous.editorId)
                if (!state || previous.status === 'superseded') {
                    continue
                }
                // Re-anchor from the raw observation against THIS snapshot —
                // the same ladder fresh findings use, so a quote the note no
                // longer contains degrades to display-only rather than
                // trusting positions from a text this run never saw (BR #3/#4).
                let anchor: Anchor | null = null
                let anchoredText: string | null = null
                let matchStrategy: MatchStrategy | null = null
                const match = matcher.match(previous.raw.quote, {
                    prefix: previous.raw.prefix,
                    suffix: previous.raw.suffix,
                    occurrence: previous.raw.occurrence
                })
                if (match.status === 'matched') {
                    anchor = createAnchor(match.match.from, match.match.to)
                    anchoredText = matcher.text.slice(match.match.from, match.match.to)
                    matchStrategy = match.match.strategy
                }
                const edits = resolveTrackedEdits(previous.raw.edits, matcher, [], {
                    anchor,
                    anchoredText,
                    matchStrategy
                })
                this.findings.addCarryover({
                    id: previous.id,
                    runId: state.runId,
                    editorId: previous.editorId,
                    raw: previous.raw,
                    anchor,
                    anchoredText,
                    matchStrategy,
                    edits,
                    status: previous.status,
                    thread: previous.thread,
                    threadTurn: previous.threadTurn,
                    conceded: previous.conceded
                })
                state.findingIds.push(previous.id)
                this.carryoverOrigin.add(previous.id)
                this.carryoverKeys.set(previous.id, observationIdentity(previous.raw))
                let pending = this.pendingCarryover.get(previous.editorId)
                if (!pending) {
                    pending = new Set()
                    this.pendingCarryover.set(previous.editorId, pending)
                }
                pending.add(previous.id)
                if (selection !== null && (anchor === null || !anchorsOverlap(anchor, selection))) {
                    this.carryoverOutOfScope.add(previous.id)
                }
            }
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
                  memberNames: [...panel.memberNames],
                  status: panel.status,
                  missingMembers: [...panel.missingMembers],
                  result: panel.result,
                  resultStale: panel.resultStale,
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

    isBusy(): boolean {
        if (!this.isSettled()) {
            return true
        }
        // The aggregation is a backend request like any other: while it is
        // pending or in flight the run is still working, and every cancel /
        // busy gate has to see that (see `isBusy` on the interface).
        const panel = this.panel
        return panel !== null && (panel.status === 'waiting' || panel.status === 'running')
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
                if (state.continuing) {
                    // Same rule as `terminate`: a cancelled EXTRA pass leaves
                    // the completed one alone (its findings are still on
                    // screen), so the editor goes back to `done` rather than
                    // becoming a retryable — and destroyable — `cancelled`.
                    state.continuing = false
                    state.status = 'done'
                    state.continuationError = 'Cancelled'
                } else {
                    state.status = 'cancelled'
                }
                // A cancelled round keeps the previous round's findings on
                // screen, un-dimmed (issue #19) — same rule as `terminate`.
                this.resolveCarryoverAtTerminal(state, 'failed')
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
        // legitimately re-report the same critique. EXCEPT the previous
        // round's carried findings (issue #19): those are not the failed
        // attempt's work, so they go back to pending carryover — re-dimmed,
        // triage intact — and resolve against the retry's output instead.
        const carried = state.findingIds.filter((id) => this.carryoverOrigin.has(id))
        this.findings.removeMany(state.findingIds.filter((id) => !this.carryoverOrigin.has(id)))
        const pending = this.pendingCarryover.get(editorId) ?? new Set<FindingId>()
        this.pendingCarryover.set(editorId, pending)
        pending.clear()
        state.findingIds = []
        for (const id of carried) {
            const finding = this.findings.get(id)
            if (!finding) {
                continue
            }
            this.findings.markCarryover(id)
            // The strict key follows the finding's CURRENT observation: an
            // adoption during the failed attempt refreshed `raw`, and the
            // retry must match against what is actually on screen.
            this.carryoverKeys.set(id, observationIdentity(finding.raw))
            pending.add(id)
            state.findingIds.push(id)
        }
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
        state.anchorBase = createAnchorBase(freshText)
        state.continuing = false
        state.continuationError = null
        // A retry DESTROYS this editor's findings, so the scorecard's top
        // fixes point at spans that no longer exist: it goes with them.
        this.reopenPanel({ keepResult: false })
        const attempt = new AbortController()
        state.attemptAbort = attempt
        // Not tracked by `settled` (already resolved after the initial
        // settle); `isSettled()` derives from the state and reports the run
        // as in progress until this loop terminates the editor.
        void this.consume(spec, state, attempt.signal)
        this.notify()
        return { ok: true }
    }

    continueEditor(editorId: string, freshText: string): ContinueEditorResult {
        const state = this.states.get(editorId)
        const spec = this.specs.get(editorId)
        if (!state || !spec) {
            return { ok: false, reason: 'unknown-editor' }
        }
        // Only a completed pass can be continued: a failed or cancelled editor
        // has nothing to build on (that is `retryEditor`), and a pending or
        // running one is already producing findings.
        if (!state.terminal || state.status !== 'done') {
            return { ok: false, reason: 'not-continuable' }
        }
        // Everything the retry resets is deliberately KEPT here: `findingIds`
        // (the previous round stays), `seenFindingKeys` (a literal repeat is
        // dropped on arrival), `summary` and `verdict` (a continuation that
        // reports neither must not erase the first pass's).
        state.runId = asRunId(generateId())
        state.status = 'pending'
        state.terminal = false
        state.lastProgress = null
        state.error = null
        state.continuing = true
        state.continuationError = null
        // New findings anchor against the text as it reads NOW — which is also
        // the text the continuation pass is about to be sent.
        state.anchorBase = createAnchorBase(freshText)
        // A continuation KEEPS every existing finding, so the scorecard stays
        // accurate about what it weighed — it is merely about to be rewritten.
        // Discarding it here would throw away a synthesis the user paid for
        // and, if the extra round is then cancelled, leave the run with no
        // scorecard at all while every finding it described is still on screen.
        this.reopenPanel({ keepResult: true })
        const attempt = new AbortController()
        state.attemptAbort = attempt
        void this.consume(spec, state, attempt.signal)
        this.notify()
        return { ok: true }
    }

    addEditor(spec: RunEditorSpec, freshText: string): AddEditorResult {
        if (this.states.has(spec.editorId)) {
            return { ok: false, reason: 'already-in-run' }
        }
        this.specs.set(spec.editorId, spec)
        const state: InternalEditorState = {
            editorId: spec.editorId,
            editorName: spec.editorName,
            runId: asRunId(generateId()),
            status: 'pending',
            findingIds: [],
            summary: null,
            verdict: null,
            lastProgress: null,
            error: null,
            salvage: null,
            terminal: false,
            seenFindingKeys: new Set(),
            releasePermit: null,
            // A late joiner anchors against the live buffer it was summoned
            // on, exactly like a retry — never the run's original snapshot,
            // which may be many edits old (Business Rules #3/#4).
            anchorBase: createAnchorBase(freshText),
            attemptAbort: null,
            continuing: false,
            continuationError: null
        }
        this.states.set(spec.editorId, state)
        // Per-attempt controller (the retry pattern): the run-level signal
        // may already be aborted by an earlier cancel, and `cancelRun` aborts
        // this attempt through `state.attemptAbort` like any other.
        const attempt = new AbortController()
        state.attemptAbort = attempt
        // Not tracked by `settled` (may already be resolved); `isSettled()`
        // derives from the states and reports the run as in progress until
        // this stream terminates the editor.
        void this.consume(spec, state, attempt.signal)
        this.notify()
        return { ok: true }
    }

    /**
     * A member going back to work re-opens the aggregation step: it named which
     * members it weighed and what they found, and that is about to change. The
     * pending/in-flight attempt is dropped (epoch-guarded, so a late settle
     * from it cannot write) and re-derived when the run settles again. No-op
     * for a solo run.
     *
     * `keepResult` is the retry/continuation asymmetry: a retry removes the
     * member's findings, so the scorecard that points at them is invalid and
     * goes; a continuation only ADDS, so the existing scorecard survives —
     * marked `resultStale` — until a newer one replaces it.
     */
    private reopenPanel(options: { readonly keepResult: boolean }): void {
        const panel = this.panel
        if (!panel) {
            return
        }
        this.panelEpoch += 1
        this.panelAbort?.abort()
        this.panelAbort = null
        panel.status = 'waiting'
        panel.error = null
        if (options.keepResult && panel.result !== null) {
            // `missingMembers` is kept with it: those members failed and are
            // not the ones continuing, so the retained scorecard keeps saying
            // which of its rows were never weighed.
            panel.resultStale = true
            return
        }
        panel.missingMembers = []
        panel.result = null
        panel.resultStale = false
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
                        resolution = this.landThreadOutcome(
                            input.findingId,
                            event.result,
                            input.currentText
                        )
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
        result: Extract<OperationResult, { kind: 'thread-turn' }>,
        currentText: (() => string | null) | undefined
    ): ThreadTurnResolution {
        const outcome = resolveThreadOutcome(result)
        // A revised proposal anchors against the LIVE text at landing time;
        // no live text → the store degrades it to display-only (BR #3/#4).
        let revisedTrackedEdits: readonly TrackedEdit[] | null = null
        if (outcome.kind === 'hold' && outcome.revisedEdits !== null) {
            const text = currentText?.() ?? null
            const finding = this.findings.get(findingId)
            if (text !== null && finding !== null) {
                revisedTrackedEdits = resolveTrackedEdits(
                    outcome.revisedEdits,
                    createQuoteMatcher(text),
                    [],
                    {
                        anchor: finding.anchor,
                        anchoredText: finding.anchoredText,
                        matchStrategy: finding.matchStrategy
                    }
                )
            }
        }
        const turnMessage = this.findings.get(findingId)?.threadTurn?.message ?? ''
        if (this.findings.completeThreadTurn(findingId, outcome, revisedTrackedEdits) === null) {
            return { status: 'discarded' }
        }
        // History (issue #21): the landed exchange is archived — an editor's
        // reply is often exactly the sentence the user wants to find again.
        const landed = this.findings.get(findingId)
        if (this.observer !== null && landed !== null) {
            try {
                this.observer.threadSettled({
                    filePath: this.snapshot.filePath,
                    editorId: landed.editorId,
                    editorName: this.states.get(landed.editorId)?.editorName ?? landed.editorId,
                    quote: landed.raw.quote,
                    message: turnMessage,
                    reply: outcome.reply,
                    outcome: outcome.kind === 'concede' ? 'conceded' : 'held'
                })
            } catch {
                // Archive only.
            }
        }
        if (outcome.kind === 'concede') {
            return { status: 'conceded', reply: outcome.reply }
        }
        return {
            status: 'held',
            reply: outcome.reply,
            revised: outcome.revisedEdits !== null || outcome.revisedCritique !== null
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
            const attemptText = anchorBaseText(state.anchorBase) ?? this.snapshot.text
            const request: ReviewRequest = {
                kind: 'review',
                contractVersion: CONTRACT_VERSION,
                runId: attemptRunId,
                snapshotHash:
                    attemptText === this.snapshot.text ? this.snapshot.hash : hashText(attemptText),
                text: attemptText,
                ...(this.snapshot.selection && attemptText === this.snapshot.text
                    ? { selection: { ...this.snapshot.selection } }
                    : {}),
                // "Generate more": the previous round travels with the request
                // so the editor is asked not to repeat it. Absent — not empty —
                // on a first pass, so a backend can tell the two apart.
                ...(state.continuing ? { alreadyReported: this.reportedBy(state) } : {})
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

    /**
     * What this editor has already told the user, for a continuation request.
     * Read from the STORE rather than from the raw stream, so a finding the
     * user has since dismissed or accepted is still listed: the editor covered
     * that ground, and re-reporting it would be a duplicate either way.
     * Critiques are clipped to the contract's continuation cap.
     */
    private reportedBy(state: InternalEditorState): ReportedFinding[] {
        const reported: ReportedFinding[] = []
        for (const id of state.findingIds) {
            const finding = this.findings.get(id)
            if (finding) {
                reported.push({
                    quote: finding.raw.quote,
                    critique: finding.raw.critique.slice(0, REPORTED_CRITIQUE_MAX)
                })
            }
        }
        return reported.slice(0, REPORTED_FINDINGS_MAX)
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
                // A continuation that reports no summary/verdict leaves the
                // first pass's standing: it was an ADDITIONAL pass, so silence
                // about the note as a whole means "nothing to add", never
                // "withdraw what I said".
                if (!state.continuing || event.result.summary !== undefined) {
                    state.summary = event.result.summary ?? null
                }
                if (!state.continuing || event.result.verdict !== undefined) {
                    state.verdict = event.result.verdict ?? null
                }
                // Salvage report (contract v2 design §5): degradation must be
                // visible. Accumulated, not overwritten — a continuation's
                // losses add to the first pass's.
                if (event.salvage) {
                    state.salvage = {
                        discardedFindings:
                            (state.salvage?.discardedFindings ?? 0) +
                            event.salvage.discardedFindings,
                        invalidProposals:
                            (state.salvage?.invalidProposals ?? 0) + event.salvage.invalidProposals
                    }
                }
                this.terminate(state, 'done', null)
                return
            case 'error':
                if (event.error.code === 'cancelled') {
                    this.terminate(state, 'cancelled', null)
                } else {
                    this.terminate(state, 'error', {
                        code: event.error.code,
                        message: redactMessage(spec, event.error.message),
                        // Captured tool output rides along untouched (issue
                        // #39): redaction guards the MESSAGE because it is
                        // shown unprompted; the diagnostics content is only
                        // ever shown behind the contract field's explicit
                        // gesture, caveat attached.
                        ...(event.error.diagnostics !== undefined
                            ? { diagnostics: event.error.diagnostics }
                            : {})
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
        // Shared identity rule (`rawFindingIdentity`): the key includes the
        // locating hints, so two findings on different occurrences of the same
        // quote stay distinct and only true stream-vs-result duplicates are
        // deduped.
        const key = rawFindingIdentity(raw)
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
            const match = base.matcher.match(raw.quote, {
                prefix: raw.prefix,
                suffix: raw.suffix,
                occurrence: raw.occurrence
            })
            if (match.status === 'matched') {
                anchor = createAnchor(match.match.from, match.match.to)
                anchoredText = base.matcher.text.slice(match.match.from, match.match.to)
                matchStrategy = match.match.strategy
                for (const batch of base.batches) {
                    anchor = mapAnchorThroughChanges(anchor, batch)
                }
            }
        }

        // Per-edit anchoring (contract v2): edits with their own quote anchor
        // independently through the same ladder and the same batch replay;
        // edits without one COPY the finding's anchoring outcome (the copies
        // then remap independently). Unanchorable edits stay null — the
        // all-or-nothing rule keeps the whole proposal display-only.
        const edits = resolveTrackedEdits(raw.edits, base?.matcher ?? null, base?.batches ?? [], {
            anchor,
            anchoredText,
            matchStrategy
        })

        // Cross-run reconciliation (issue #19): a finding repeating a carried
        // observation refreshes THAT finding — same id, same triage status,
        // same thread — instead of entering the store as a new one.
        if (this.reconcileCarryover(state, raw, { anchor, anchoredText, matchStrategy, edits })) {
            return
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
            matchStrategy,
            edits
        })
    }

    /**
     * Resolves an incoming finding against the editor's pending carryover
     * (issue #19). Strict pass first: same observation identity (quote +
     * hints + critique — never proposal content, contract v2 design §9) →
     * the carried finding is adopted (id, status and thread kept; anchoring
     * and proposal refreshed), or, when it was ACCEPTED, the repeat is simply
     * dropped — the edit is already in the document, re-reporting it is
     * stale. Loose pass second, for dismissal-carry only: a dismissed or
     * rejected finding on an overlapping span of the same editor stays
     * judged even when the model reworded its critique — a dismissed
     * objection must not resurrect via rephrasing. Returns true when the
     * incoming finding was consumed either way.
     */
    private reconcileCarryover(
        state: InternalEditorState,
        raw: RawFinding,
        patch: {
            readonly anchor: Anchor | null
            readonly anchoredText: string | null
            readonly matchStrategy: MatchStrategy | null
            readonly edits: readonly TrackedEdit[]
        }
    ): boolean {
        const pending = this.pendingCarryover.get(state.editorId)
        if (!pending || pending.size === 0) {
            return false
        }
        const key = observationIdentity(raw)
        for (const id of pending) {
            if (this.carryoverKeys.get(id) !== key) {
                continue
            }
            pending.delete(id)
            const previous = this.findings.get(id)
            if (!previous) {
                continue // defensive: vanished record cannot be adopted
            }
            if (previous.status === 'accepted') {
                return true
            }
            this.findings.adoptCarryover(id, { runId: state.runId, raw, ...patch })
            return true
        }
        if (patch.anchor !== null) {
            for (const id of pending) {
                const previous = this.findings.get(id)
                if (
                    !previous ||
                    (previous.status !== 'dismissed' && previous.status !== 'rejected') ||
                    previous.anchor === null ||
                    !anchorsOverlap(previous.anchor, patch.anchor)
                ) {
                    continue
                }
                pending.delete(id)
                this.findings.adoptCarryover(id, { runId: state.runId, raw, ...patch })
                return true
            }
        }
        return false
    }

    /**
     * Settles an editor's remaining pending carryover when its attempt
     * reaches a terminal state (issue #19).
     *
     * - `done`: an in-scope carried finding the round did NOT repeat is
     *   removed — the editor looked at that text again and no longer raises
     *   the objection. Out-of-scope ones (selection runs) are kept and
     *   un-dimmed: the round made no statement about them.
     * - `failed` (error or cancel): everything is kept and un-dimmed — the
     *   previous round's findings ARE the current information again. This is
     *   the other half of the #19 fix: a failed or cancelled re-review no
     *   longer wipes what the user was working through.
     */
    private resolveCarryoverAtTerminal(
        state: InternalEditorState,
        outcome: 'done' | 'failed'
    ): void {
        const pending = this.pendingCarryover.get(state.editorId)
        if (!pending || pending.size === 0) {
            return
        }
        if (outcome === 'failed') {
            for (const id of pending) {
                this.findings.markCurrent(id)
            }
            pending.clear()
            return
        }
        const dropped: FindingId[] = []
        for (const id of pending) {
            if (this.carryoverOutOfScope.has(id)) {
                this.findings.markCurrent(id)
            } else {
                dropped.push(id)
            }
        }
        pending.clear()
        if (dropped.length > 0) {
            this.findings.removeMany(dropped)
            const droppedSet = new Set(dropped)
            state.findingIds = state.findingIds.filter((id) => !droppedSet.has(id))
        }
    }

    private terminate(
        state: InternalEditorState,
        status: EditorRunStatus,
        error: OperationErrorInfo | null
    ): void {
        state.terminal = true
        if (state.continuing) {
            // A continuation only ever starts from `done`, and the findings of
            // that successful pass are still here. So it restores `done` and
            // records the failure separately rather than marking the editor
            // failed — which would offer Retry, and Retry replaces an editor's
            // findings (see `EditorRunState.continuationError`).
            state.continuing = false
            state.status = 'done'
            state.error = null
            state.continuationError = status === 'done' ? null : (error?.message ?? 'Cancelled')
        } else {
            state.status = status
            state.error = error
        }
        // Carryover resolution rides the SAME terminal edge (issue #19): a
        // completed round drops what it no longer reports; a failed or
        // cancelled one keeps the previous round's findings on screen.
        this.resolveCarryoverAtTerminal(state, status === 'done' ? 'done' : 'failed')
        // History (issue #21): a completed pass archives what it produced —
        // only the not-yet-reported findings, so a continuation adds its
        // additions rather than repeating the first pass. After carryover
        // resolution on purpose: dropped stale carryover is not this pass's
        // output. Observer failures never break a run.
        if (state.status === 'done' && this.observer !== null) {
            const fresh = state.findingIds
                .filter((id) => !this.reportedToObserver.has(id))
                .map((id) => this.findings.get(id))
                .filter((finding): finding is TrackedFinding => finding !== null)
            for (const finding of fresh) {
                this.reportedToObserver.add(finding.id)
            }
            if (fresh.length > 0) {
                try {
                    this.observer.editorSettled({
                        filePath: this.snapshot.filePath,
                        editorId: state.editorId,
                        editorName: state.editorName,
                        findings: fresh
                    })
                } catch {
                    // History is an archive, never a participant.
                }
            }
        }
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
        const plan = planPanelAggregation(this.memberReviews(), this.panelSpec?.budget)
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
            if (result !== null) {
                panel.result = result
                panel.resultStale = false
                // History (issue #21): a produced scorecard is archived.
                if (this.observer !== null) {
                    try {
                        this.observer.panelSettled({
                            filePath: this.snapshot.filePath,
                            panelName: panel.panelName,
                            result
                        })
                    } catch {
                        // Archive only.
                    }
                }
            }
            // A failed or cancelled attempt leaves whatever scorecard was
            // already there (only a continuation can have retained one) —
            // the same rule `cancelRun` states: an already-produced scorecard
            // stays inspectable.
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
        error: state.error,
        continuing: state.continuing,
        continuationError: state.continuationError,
        salvage: state.salvage
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
    constructor(
        getMaxConcurrentRequests: () => number = () => Number.POSITIVE_INFINITY,
        /** History archive observer (issue #21); null = nothing records. */
        private readonly observer: RunObserver | null = null
    ) {
        this.requestGate = new Semaphore(getMaxConcurrentRequests)
    }

    startRun(input: StartRunInput): RunHandle {
        const existing = this.runs.get(input.snapshot.filePath)
        let carryover: readonly TrackedFinding[] = []
        if (existing) {
            existing.cancelRun()
            // Cross-run carryover (issue #19): the replaced run's findings —
            // with their triage statuses and threads — seed the new run
            // instead of vanishing. Captured AFTER the cancel so in-flight
            // thread turns are already settled as failed. `superseded`
            // records are history, not observations, and stay behind.
            carryover = existing.findings.list().filter((f) => f.status !== 'superseded')
        }
        const run = new ReviewRunHandle(input, this.requestGate, carryover, this.observer)
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

    /**
     * `discardRun` for a path AND everything under it — the shape a FOLDER
     * rename or delete arrives in. Obsidian does not necessarily emit a
     * per-child vault event for a folder, so a controller that only handled the
     * exact path would leave every note under it holding a live run: an
     * uncancelled request keeping a concurrency permit, and a retained snapshot
     * for the plugin's lifetime. Worse, a note later created at a reused path
     * would inherit the stale run and get another note's findings painted over
     * its text.
     */
    discardUnder(path: string): void {
        for (const filePath of [...this.runs.keys()]) {
            if (isPathUnder(filePath, path)) {
                this.discardRun(filePath)
            }
        }
    }

    /** Cancels every active run and forgets them (e.g. on plugin unload). */
    cancelAll(): void {
        for (const run of this.runs.values()) {
            run.cancelRun()
        }
        this.runs.clear()
    }
}
