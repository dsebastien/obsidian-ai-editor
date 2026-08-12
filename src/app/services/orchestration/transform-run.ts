import type { RunId } from '../../domain/ids'
import { asRunId } from '../../domain/ids'
import type {
    InsertAtRequest,
    OperationEvent,
    TransformSelectionRequest
} from '../../domain/operations/contract'
import type { DocumentSnapshot } from '../../domain/snapshot'
import { isPathUnder, remapPathUnder } from '../../domain/path-scope'
import type { OperationErrorInfo } from './run-controller'
import type { ReleasePermit } from './semaphore'
import { Semaphore } from './semaphore'

/**
 * Transform-run orchestration: one editor, one operation, one result.
 *
 * The transform counterpart of `RunController`/`ReviewRunHandle`, kept
 * deliberately lean: a transform run has no findings, no anchoring, no
 * retry — it is a single backend operation whose single result is either
 * applied (behind the precondition below) or discarded. What IS shared with
 * reviews:
 * - the event protocol (runId matching, exactly-once terminal, post-terminal
 *   discard, stream-end-without-terminal = invalid-output),
 * - the plugin-wide concurrency gate (the SAME `Semaphore` instance the
 *   `RunController` owns is injected, so reviews and transforms together
 *   never exceed `behavior.maxConcurrentRequests`),
 * - the redaction seam for error messages (Business Rules #12),
 * - cancellation semantics (abort ejects a queued waiter, late events from
 *   a cancelled stream are discarded).
 *
 * Apply precondition (Business Rules #3/#4): the outcome may be applied
 * ONLY while the text it was computed against is unchanged — the selected
 * span for `transform-selection` (edits strictly after the span are fine),
 * the whole document for `insert-at` (a bare position cannot be revalidated
 * against changed text without guessing). On mismatch the UI surfaces
 * "text changed" instead of applying; stale results are never
 * fuzzy-relocated.
 */

export type TransformOperationRequest = TransformSelectionRequest | InsertAtRequest

/** Backend executor signature for transform operations (same event shape as reviews). */
export type TransformExecutor = (
    request: TransformOperationRequest,
    signal: AbortSignal
) => AsyncIterable<OperationEvent>

/**
 * What the result must be applied to, captured at dispatch time.
 * `replace-span`: the selected range in run-snapshot coordinates plus the
 * exact span text (the precondition compares against it verbatim).
 * `insert-at`: the insertion offset; validity requires the whole document
 * unchanged (compared against the run snapshot's text).
 */
export type TransformTarget =
    | {
          readonly kind: 'replace-span'
          readonly from: number
          readonly to: number
          /** Exact text of the selected span at dispatch (precondition base). */
          readonly spanText: string
          /** Content hash of `spanText` (cheap external comparisons). */
          readonly spanHash: string
      }
    | {
          readonly kind: 'insert-at'
          readonly position: number
          /** Content hash of the full dispatch text (cheap external comparisons). */
          readonly docHash: string
      }

export type TransformRunStatus = 'pending' | 'running' | 'done' | 'error' | 'cancelled'

/** The single validated result of a transform run. */
export interface TransformOutcome {
    /** Replacement text (`replace-span`) or insertion text (`insert-at`). */
    readonly text: string
    readonly rationale: string | null
}

/** Immutable view of a transform run's progress. */
export interface TransformRunState {
    readonly status: TransformRunStatus
    readonly outcome: TransformOutcome | null
    readonly error: OperationErrorInfo | null
    readonly lastProgress: string | null
}

/**
 * Outcome of `TransformRunHandle.checkPrecondition`: whether the result may
 * be applied to the given current document text (Business Rules #3).
 */
export type ApplyPrecondition =
    | { readonly ok: true; readonly outcome: TransformOutcome }
    | { readonly ok: false; readonly reason: 'not-done' | 'text-changed' }

export interface StartTransformInput {
    /** Snapshot the request text was captured from (target coordinates base). */
    readonly snapshot: DocumentSnapshot
    /** Fully built operation request; `request.runId` is the run's identity. */
    readonly request: TransformOperationRequest
    readonly target: TransformTarget
    readonly editorId: string
    readonly editorName: string
    /** Sentence-case verb label ("Rephrase") shown by the preview UI. */
    readonly actionLabel?: string
    /** Secret redaction for error messages (Business Rules #12). */
    readonly redactError?: (message: string) => string
    readonly execute: TransformExecutor
}

/** Handle over one transform/generate run (one editor, one result). */
export interface TransformRunHandle {
    readonly runId: RunId
    readonly kind: 'transform-selection' | 'insert-at'
    readonly snapshot: DocumentSnapshot
    readonly target: TransformTarget
    readonly editorId: string
    readonly editorName: string
    /** Verb label for UI surfaces; null when the caller provided none. */
    readonly actionLabel: string | null
    /** Resolves once the run reaches a terminal state. */
    readonly settled: Promise<void>
    getState(): TransformRunState
    isSettled(): boolean
    subscribe(listener: () => void): () => void
    /** Aborts the in-flight operation; late events are discarded. */
    cancel(): void
    /**
     * Whether the outcome may be applied to `currentDocText` (Business
     * Rules #3/#4): the run must be done, and the dispatched target text
     * must be byte-identical in the current document — the selected span at
     * its original offsets for `replace-span` (edits strictly after the
     * span keep it valid), the entire document for `insert-at`. Comparison
     * is exact text equality, never fuzzy relocation; a mismatch means the
     * user must re-run the action.
     */
    checkPrecondition(currentDocText: string): ApplyPrecondition
}

class TransformRunHandleImpl implements TransformRunHandle {
    readonly runId: RunId
    readonly kind: 'transform-selection' | 'insert-at'
    /** Mutable ONLY through `renamedTo` — a vault rename re-keys the run. */
    snapshot: DocumentSnapshot
    readonly target: TransformTarget
    readonly editorId: string
    readonly editorName: string
    readonly actionLabel: string | null
    readonly settled: Promise<void>

    private readonly abort = new AbortController()
    private readonly listeners = new Set<() => void>()
    private status: TransformRunStatus = 'pending'
    private outcome: TransformOutcome | null = null
    private error: OperationErrorInfo | null = null
    private lastProgress: string | null = null
    private terminal = false
    /** Frees the concurrency permit (null until admitted / once released). */
    private releasePermit: ReleasePermit | null = null

    constructor(
        private readonly input: StartTransformInput,
        requestGate: Semaphore
    ) {
        this.runId = asRunId(input.request.runId)
        this.kind = input.request.kind
        this.snapshot = input.snapshot
        this.target = input.target
        this.editorId = input.editorId
        this.editorName = input.editorName
        this.actionLabel = input.actionLabel ?? null
        this.settled = this.consume(requestGate).then(
            () => undefined,
            () => undefined
        )
    }

    /**
     * Follows a vault rename (issue #47): only the path changes — text,
     * target span and outcome are content-based and stay valid, so a
     * pending preview survives the user retitling the note.
     */
    renamedTo(newPath: string): void {
        this.snapshot = { ...this.snapshot, filePath: newPath }
    }

    getState(): TransformRunState {
        return {
            status: this.status,
            outcome: this.outcome,
            error: this.error,
            lastProgress: this.lastProgress
        }
    }

    isSettled(): boolean {
        return this.terminal
    }

    subscribe(listener: () => void): () => void {
        this.listeners.add(listener)
        return () => {
            this.listeners.delete(listener)
        }
    }

    cancel(): void {
        if (!this.abort.signal.aborted) {
            this.abort.abort()
        }
        if (!this.terminal) {
            // Mark cancelled NOW (and free the permit) rather than waiting
            // for the aborted stream to wind down — mirrors `cancelRun`.
            this.terminate('cancelled', null)
        }
    }

    checkPrecondition(currentDocText: string): ApplyPrecondition {
        if (this.status !== 'done' || this.outcome === null) {
            return { ok: false, reason: 'not-done' }
        }
        const target = this.target
        if (target.kind === 'replace-span') {
            if (target.to > currentDocText.length) {
                return { ok: false, reason: 'text-changed' }
            }
            if (currentDocText.slice(target.from, target.to) !== target.spanText) {
                return { ok: false, reason: 'text-changed' }
            }
            return { ok: true, outcome: this.outcome }
        }
        if (currentDocText !== this.snapshot.text) {
            return { ok: false, reason: 'text-changed' }
        }
        return { ok: true, outcome: this.outcome }
    }

    private async consume(requestGate: Semaphore): Promise<void> {
        const signal = this.abort.signal
        // Same admission protocol as review editors: the backend request
        // must not start until a plugin-wide permit is free; while queued
        // the run truthfully reports 'pending'. Cancelling ejects the
        // queued waiter immediately (no permit consumed).
        let release: ReleasePermit
        try {
            release = await requestGate.acquire(signal)
        } catch {
            if (!this.terminal) {
                this.terminate('cancelled', null)
            }
            return
        }
        if (this.terminal) {
            release() // cancelled while queued (cancel() already terminated)
            return
        }
        this.releasePermit = release
        try {
            this.status = 'running'
            this.notify()
            try {
                for await (const event of this.input.execute(this.input.request, signal)) {
                    if (this.terminal) {
                        continue // post-terminal or post-cancel: discard
                    }
                    if (event.runId !== this.runId) {
                        continue // foreign run: discard
                    }
                    this.handleEvent(event)
                }
            } catch (cause) {
                if (!this.terminal) {
                    if (signal.aborted) {
                        this.terminate('cancelled', null)
                    } else {
                        this.terminate('error', {
                            code: 'unknown',
                            message: this.redact(
                                cause instanceof Error ? cause.message : String(cause)
                            )
                        })
                    }
                }
            }
            if (!this.terminal) {
                if (signal.aborted) {
                    this.terminate('cancelled', null)
                } else {
                    this.terminate('error', {
                        code: 'invalid-output',
                        message: 'Stream ended without a terminal event'
                    })
                }
            }
        } finally {
            // Backstop: the permit is normally freed the moment the run goes
            // terminal so a still-draining stream cannot starve other runs.
            release()
        }
    }

    private handleEvent(event: OperationEvent): void {
        switch (event.type) {
            case 'progress':
                this.lastProgress = event.message ?? null
                this.notify()
                return
            case 'finding':
                // Findings belong to review operations; a transform backend
                // emitting one is off-contract but harmless — discard.
                return
            case 'result':
                if (event.result.kind !== this.kind) {
                    this.terminate('error', {
                        code: 'invalid-output',
                        message: `Expected a '${this.kind}' result, got '${event.result.kind}'`
                    })
                    return
                }
                this.outcome = {
                    text:
                        event.result.kind === 'transform-selection'
                            ? event.result.replacement
                            : event.result.insertion,
                    rationale: event.result.rationale ?? null
                }
                this.terminate('done', null)
                return
            case 'error':
                if (event.error.code === 'cancelled') {
                    this.terminate('cancelled', null)
                } else {
                    this.terminate('error', {
                        code: event.error.code,
                        message: this.redact(event.error.message),
                        // Captured tool output rides along untouched (issue
                        // #42, same seam as reviews): redaction guards the
                        // MESSAGE because it is shown unprompted; the
                        // diagnostics content is only ever rendered behind
                        // the contract field's explicit gesture.
                        ...(event.error.diagnostics !== undefined
                            ? { diagnostics: event.error.diagnostics }
                            : {})
                    })
                }
                return
        }
    }

    private terminate(status: TransformRunStatus, error: OperationErrorInfo | null): void {
        this.terminal = true
        this.status = status
        this.error = error
        // Terminal = the backend work is over from the run's point of view;
        // free the permit immediately rather than when the stream closes.
        const release = this.releasePermit
        this.releasePermit = null
        release?.()
        this.notify()
    }

    private redact(message: string): string {
        return this.input.redactError ? this.input.redactError(message) : message
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
 * Manages transform runs per file: at most one active transform per file
 * path — dispatching a new action cancels the previous transform run for
 * that file (its late events are discarded by the cancelled handle).
 * Independent of the file's review run: a review's findings stay on screen
 * while a transform executes.
 *
 * The concurrency gate is injected — the plugin passes the
 * `RunController`'s gate so reviews and transforms share the ONE
 * plugin-wide `behavior.maxConcurrentRequests` budget. The default
 * (private unlimited gate) keeps headless/test callers unthrottled unless
 * they opt in.
 */
export class TransformController {
    private readonly runs = new Map<string, TransformRunHandleImpl>()

    constructor(
        private readonly requestGate: Semaphore = new Semaphore(() => Number.POSITIVE_INFINITY)
    ) {}

    startTransform(input: StartTransformInput): TransformRunHandle {
        const existing = this.runs.get(input.snapshot.filePath)
        if (existing) {
            existing.cancel()
        }
        const run = new TransformRunHandleImpl(input, this.requestGate)
        this.runs.set(input.snapshot.filePath, run)
        return run
    }

    /** The current (possibly settled) transform run for a file, if any. */
    getRun(filePath: string): TransformRunHandle | null {
        return this.runs.get(filePath) ?? null
    }

    /** Cancels and forgets the run for a file (file closed or deleted — a
     * rename goes through `renameUnder` instead). */
    discardRun(filePath: string): void {
        const run = this.runs.get(filePath)
        if (!run) {
            return
        }
        run.cancel()
        this.runs.delete(filePath)
    }

    /**
     * `discardRun` for a path AND everything under it — a FOLDER rename or
     * delete, which Obsidian reports as one event without per-child ones. Same
     * reasoning as `RunController.discardUnder`.
     */
    discardUnder(path: string): void {
        for (const filePath of [...this.runs.keys()]) {
            if (isPathUnder(filePath, path)) {
                this.discardRun(filePath)
            }
        }
    }

    /**
     * Follows a vault rename of `path` (note or folder) — issue #47, same
     * contract as `RunController.renameUnder`: a rename never changes
     * content, so the run is re-keyed with its outcome intact rather than
     * cancelled. A stale run already at a target path is discarded first.
     */
    renameUnder(oldPath: string, newPath: string): void {
        for (const [filePath, run] of [...this.runs]) {
            const moved = remapPathUnder(filePath, oldPath, newPath)
            if (moved === null || moved === filePath) {
                continue
            }
            const occupant = this.runs.get(moved)
            if (occupant && occupant !== run) {
                this.discardRun(moved)
            }
            this.runs.delete(filePath)
            run.renamedTo(moved)
            this.runs.set(moved, run)
        }
    }

    /** Cancels every active transform run and forgets them (plugin unload). */
    cancelAll(): void {
        for (const run of this.runs.values()) {
            run.cancel()
        }
        this.runs.clear()
    }
}
