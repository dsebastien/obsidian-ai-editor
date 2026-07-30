import type { OperationEvent, RawFinding, ReviewRequest } from '../../domain/operations/contract'
import { rawFindingIdentity } from '../../domain/operations/finding-identity'
import type { RunId } from '../../domain/ids'
import { asRunId } from '../../domain/ids'
import type { BackgroundRequestGate } from './background-gate'
import type { OperationErrorInfo } from './run-controller'
import type { ReleasePermit } from './semaphore'

/**
 * One BACKGROUND comment job in flight (plan §5.5 / M8, slice 2).
 *
 * The third orchestration shape in this codebase, and the differences from the
 * other two are the whole point:
 *
 * | | review run | transform run | comment run |
 * |---|---|---|---|
 * | keyed by | file | file | comment id |
 * | survives a note switch | run does, view does not | no | **yes** |
 * | survives a restart | no | no | **as `interrupted`** |
 * | admission | `Semaphore` (FIFO) | `Semaphore` (FIFO) | `BackgroundRequestGate` |
 *
 * A comment run is keyed by COMMENT, not by file: the user can park several
 * questions on one note and keep writing, and none of them is "the" run for
 * that note. Nothing about it is bound to a view, so closing the note, opening
 * another one, or collapsing the pane changes nothing — the result lands in
 * the durable store and shows up wherever the comment is rendered next.
 *
 * What it shares with the other two, deliberately:
 * - the event protocol (runId matching, exactly-once terminal, post-terminal
 *   discard, stream-end-without-terminal = `invalid-output`),
 * - the ONE plugin-wide concurrency budget, entered through the background
 *   gate so a parked question never delays a review the user is watching,
 * - the redaction seam for error messages (Business Rules #12),
 * - cancellation semantics (abort drops the waiter, late events are discarded).
 *
 * It does NOT anchor anything. A background answer is persisted as raw quotes
 * and re-anchored against the live note whenever it is displayed
 * (`reanchorComment`) — anchoring at produce time would bake in offsets for a
 * document the user has been editing the whole time the job ran, which is
 * exactly what Business Rules #13 forbids.
 */

export type CommentRunStatus = 'pending' | 'running' | 'done' | 'error' | 'cancelled'

/** How a comment run ended — what the caller writes into the durable store. */
export type CommentRunResolution = 'done' | 'error' | 'cancelled'

/** What the editor reported. */
export interface CommentRunOutcome {
    readonly findings: readonly RawFinding[]
    /** Note-level answer when the editor pinned nothing. */
    readonly summary: string | null
}

export interface CommentRunState {
    readonly status: CommentRunStatus
    readonly outcome: CommentRunOutcome | null
    readonly error: OperationErrorInfo | null
    readonly lastProgress: string | null
    /**
     * Unix ms the backend request actually started (permit granted), or
     * `null` while the job is still waiting for capacity. The live elapsed
     * timer reads this: counting from when the user submitted would show
     * queue time as work time.
     */
    readonly startedAt: number | null
}

export interface StartCommentRunInput {
    /** Durable comment this job answers. */
    readonly commentId: string
    /** Vault-relative path of the note the comment sits on, at dispatch. */
    readonly notePath: string
    /** Fully built request; `request.runId` is the run's identity. */
    readonly request: ReviewRequest
    readonly editorId: string
    readonly editorName: string
    /** Secret redaction for error messages (Business Rules #12). */
    readonly redactError?: (message: string) => string
    readonly execute: (request: ReviewRequest, signal: AbortSignal) => AsyncIterable<OperationEvent>
    /** Clock seam (the glue passes `Date.now`, specs pass a fake). */
    readonly now?: () => number
}

export interface CommentRunHandle {
    readonly runId: RunId
    readonly commentId: string
    readonly notePath: string
    readonly editorId: string
    readonly editorName: string
    /** Resolves once the run reaches a terminal state, with how it ended. */
    readonly settled: Promise<CommentRunResolution>
    getState(): CommentRunState
    isSettled(): boolean
    subscribe(listener: () => void): () => void
    /**
     * Aborts the in-flight request; late events are discarded. The run
     * terminates as `cancelled` immediately rather than waiting for the
     * stream to wind down, so the permit is reclaimed at once.
     */
    cancel(): void
}

class CommentRunHandleImpl implements CommentRunHandle {
    readonly runId: RunId
    readonly commentId: string
    readonly notePath: string
    readonly editorId: string
    readonly editorName: string
    readonly settled: Promise<CommentRunResolution>

    private readonly abort = new AbortController()
    private readonly listeners = new Set<() => void>()
    private readonly seenFindings = new Set<string>()
    private readonly findings: RawFinding[] = []
    private readonly now: () => number
    private status: CommentRunStatus = 'pending'
    private summary: string | null = null
    private outcome: CommentRunOutcome | null = null
    private error: OperationErrorInfo | null = null
    private lastProgress: string | null = null
    private startedAt: number | null = null
    private terminal = false
    private releasePermit: ReleasePermit | null = null

    constructor(
        private readonly input: StartCommentRunInput,
        gate: BackgroundRequestGate
    ) {
        this.runId = asRunId(input.request.runId)
        this.commentId = input.commentId
        this.notePath = input.notePath
        this.editorId = input.editorId
        this.editorName = input.editorName
        this.now = input.now ?? ((): number => Date.now())
        this.settled = this.consume(gate)
    }

    getState(): CommentRunState {
        return {
            status: this.status,
            outcome: this.outcome,
            error: this.error,
            lastProgress: this.lastProgress,
            startedAt: this.startedAt
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
            this.terminate('cancelled', null)
        }
    }

    private async consume(gate: BackgroundRequestGate): Promise<CommentRunResolution> {
        const signal = this.abort.signal
        // Background admission: no place in the FIFO queue, so a review the
        // user starts while this waits is never ordered behind it.
        let release: ReleasePermit
        try {
            release = await gate.acquire(signal)
        } catch {
            // Aborted, or the plugin unloaded while waiting. Either way the
            // request never started and nothing was spent.
            if (!this.terminal) {
                this.terminate('cancelled', null)
            }
            return this.resolution()
        }
        if (this.terminal) {
            release() // cancelled while waiting (cancel() already terminated)
            return this.resolution()
        }
        this.releasePermit = release
        try {
            this.status = 'running'
            this.startedAt = this.now()
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
            // terminal so a still-draining stream cannot hold background
            // capacity nobody is using.
            release()
        }
        return this.resolution()
    }

    private handleEvent(event: OperationEvent): void {
        switch (event.type) {
            case 'progress':
                this.lastProgress = event.message ?? null
                this.notify()
                return
            case 'finding':
                this.ingest(event.finding)
                this.notify()
                return
            case 'result':
                if (event.result.kind !== 'review') {
                    this.terminate('error', {
                        code: 'invalid-output',
                        message: `Expected a review result, got '${event.result.kind}'`
                    })
                    return
                }
                for (const raw of event.result.findings) {
                    this.ingest(raw)
                }
                this.summary = event.result.summary ?? null
                this.outcome = { findings: [...this.findings], summary: this.summary }
                this.terminate('done', null)
                return
            case 'error':
                if (event.error.code === 'cancelled') {
                    this.terminate('cancelled', null)
                } else {
                    this.terminate('error', {
                        code: event.error.code,
                        message: this.redact(event.error.message)
                    })
                }
                return
        }
    }

    /** Streamed and result findings land in one deduplicated list. */
    private ingest(raw: RawFinding): void {
        const key = rawFindingIdentity(raw)
        if (this.seenFindings.has(key)) {
            return
        }
        this.seenFindings.add(key)
        this.findings.push(raw)
    }

    private terminate(status: CommentRunStatus, error: OperationErrorInfo | null): void {
        this.terminal = true
        this.status = status
        this.error = error
        const release = this.releasePermit
        this.releasePermit = null
        release?.()
        this.notify()
    }

    private resolution(): CommentRunResolution {
        return this.status === 'done' ? 'done' : this.status === 'cancelled' ? 'cancelled' : 'error'
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
 * Owns the background comment runs of a session, keyed by comment id.
 *
 * There is deliberately no per-file "current run" here: several comments on
 * one note run independently, and a note switch changes nothing. Runs are
 * forgotten once terminal so a long session does not accumulate handles that
 * each pin a request payload.
 */
export class CommentRunController {
    private readonly runs = new Map<string, CommentRunHandle>()

    constructor(private readonly gate: BackgroundRequestGate) {}

    /**
     * Starts a job for a comment. Refuses when one is already in flight for
     * the SAME comment — a second request would produce a second answer for
     * one question, and the store has exactly one place to put it.
     */
    start(input: StartCommentRunInput): CommentRunHandle | null {
        const existing = this.runs.get(input.commentId)
        if (existing && !existing.isSettled()) {
            return null
        }
        const run = new CommentRunHandleImpl(input, this.gate)
        this.runs.set(input.commentId, run)
        // Forget it once it settles: the durable comment is the record from
        // then on, and the handle only pins memory.
        void run.settled.then(() => {
            if (this.runs.get(input.commentId) === run) {
                this.runs.delete(input.commentId)
            }
        })
        return run
    }

    /** The in-flight run for a comment, if any. */
    get(commentId: string): CommentRunHandle | null {
        return this.runs.get(commentId) ?? null
    }

    /** Every run currently tracked (in-flight or just-settled). */
    list(): readonly CommentRunHandle[] {
        return [...this.runs.values()]
    }

    /** Cancels one job; `false` when nothing was in flight for that comment. */
    cancel(commentId: string): boolean {
        const run = this.runs.get(commentId)
        if (!run) {
            return false
        }
        run.cancel()
        this.runs.delete(commentId)
        return true
    }

    /**
     * Cancels every job for a note (the note was deleted, or a rule switched
     * the plugin off for it). Returns the comment ids that were cancelled.
     *
     * A FOLDER path matches everything under it, for the same reason the
     * repository handles both shapes: Obsidian does not necessarily emit a
     * per-child event for a folder delete, and a run whose note is gone has
     * nowhere to deliver its answer.
     */
    cancelForNote(notePath: string): readonly string[] {
        const cancelled: string[] = []
        const prefix = `${notePath}/`
        for (const run of [...this.runs.values()]) {
            if (run.notePath === notePath || run.notePath.startsWith(prefix)) {
                run.cancel()
                this.runs.delete(run.commentId)
                cancelled.push(run.commentId)
            }
        }
        return cancelled
    }

    /**
     * Cancels every job (plugin unload). Returns the comment ids so the
     * caller can mark them `interrupted` in the durable store — the run is
     * over, and the next session must say so rather than claiming it is
     * still running.
     */
    cancelAll(): readonly string[] {
        const cancelled: string[] = []
        for (const run of this.runs.values()) {
            run.cancel()
            cancelled.push(run.commentId)
        }
        this.runs.clear()
        return cancelled
    }
}
