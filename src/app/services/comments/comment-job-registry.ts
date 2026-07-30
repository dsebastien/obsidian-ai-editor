import {
    beginCommentJob,
    commentJobView,
    completeCommentJob,
    dismissCommentJob,
    failCommentJob,
    interruptCommentJob,
    restartCommentJob
} from '../../domain/comments/comment-job'
import type { CommentJobView } from '../../domain/comments/comment-job'
import type { MarginComment } from '../../domain/comments/margin-comment'
import type { CommentRunController, StartCommentRunInput } from '../orchestration/comment-run'
import type { MarginCommentRepository } from './comment-repository'

/**
 * The live registry of background comment jobs (plan §5.5 / M8, slice 2).
 *
 * Two things exist at once and this is the ONE place that keeps them agreeing:
 *
 * - the **durable comment** in the sidecar store — what survives the session,
 * - the **in-flight run** in `CommentRunController` — what a timer can tick on.
 *
 * The store is the record; the registry is the join. Every status change goes
 * through here so a job can never be `running` on disk with nothing running,
 * and a UI never has to reconcile two sources.
 *
 * ## Where jobs are surfaced — decided
 *
 * The **side panel**, in its own section, and nowhere else for now. The status
 * bar was the alternative and it was rejected: the status bar already carries
 * the finding count (M4), it is global chrome that every note pays for, and a
 * per-second timer there would put a permanently-animating element in the
 * user's peripheral vision for a feature they are deliberately not watching.
 * The side panel is opened on purpose, is already the narrow-pane fallback for
 * everything else, and is where the M8 margin column will fall back to. The
 * margin column itself is the next slice; nothing here assumes it.
 *
 * ## Notifications
 *
 * The registry notifies subscribers on every change, INCLUDING the once-a-tick
 * timer refresh, which is why it owns the ticker: a surface must not have to
 * poll to keep an elapsed timer honest, and the ticker must stop the moment
 * nothing is in flight (a plugin that schedules a 1s interval forever, to
 * animate nothing, is a battery bug).
 */

/** How often a live elapsed timer is refreshed. */
export const COMMENT_TIMER_TICK_MS = 1_000

/** Refusals `launch` can produce without ever reaching a backend. */
export type CommentLaunchFailure =
    /** The note already holds `MAX_COMMENTS_PER_NOTE` comments. */
    | 'note-full'
    /** A job is already in flight for this comment. */
    | 'already-running'

export type CommentLaunchResult =
    | { readonly ok: true; readonly comment: MarginComment }
    | { readonly ok: false; readonly reason: CommentLaunchFailure }

/** What the registry needs to start one job; the service supplies the rest. */
export interface LaunchCommentJobInput {
    readonly notePath: string
    /** The comment to record and answer; must be in `submitted` status. */
    readonly comment: MarginComment
    /** Everything backend-facing, already resolved by the service. */
    readonly run: Omit<StartCommentRunInput, 'commentId' | 'notePath'>
}

export interface CommentJobRegistryDeps {
    readonly repository: MarginCommentRepository
    readonly runs: CommentRunController
    /** Clock seam (glue passes `Date.now`). */
    readonly now?: () => number
    /** Timer seam per AGENTS.md: the glue passes `window.setInterval`. */
    readonly setTicker: (callback: () => void, ms: number) => number
    readonly clearTicker: (handle: number) => void
}

export class CommentJobRegistry {
    private readonly listeners = new Set<() => void>()
    private readonly unsubscribers = new Map<string, () => void>()
    private readonly now: () => number
    private ticker: number | null = null
    private disposed = false

    constructor(private readonly deps: CommentJobRegistryDeps) {
        this.now = deps.now ?? ((): number => Date.now())
    }

    /**
     * Records the comment and starts its job. The comment is written to the
     * store BEFORE the request goes out: a job that is not durable is not a
     * background job, and a crash between dispatch and the first write would
     * lose a question the user already asked.
     */
    launch(input: LaunchCommentJobInput): CommentLaunchResult {
        if (this.deps.runs.get(input.comment.id) !== null) {
            return { ok: false, reason: 'already-running' }
        }
        if (!this.deps.repository.upsert(input.notePath, input.comment)) {
            return { ok: false, reason: 'note-full' }
        }
        const handle = this.deps.runs.start({
            ...input.run,
            commentId: input.comment.id,
            notePath: input.notePath
        })
        if (handle === null) {
            // Lost a race against another launch for the same comment. The
            // record stands (it is the user's question) but this call did not
            // start anything.
            return { ok: false, reason: 'already-running' }
        }

        const commentId = input.comment.id
        const notePath = input.notePath
        let finalized = false
        // The store follows the run's OWN notifications, not its `settled`
        // promise. `cancel()` terminates the handle synchronously while the
        // aborted stream may still be winding down (or, for an executor that
        // ignores its signal, never wind down at all), so a cancelled job must
        // become durable at the moment it is cancelled rather than whenever
        // the iterator decides to return.
        const unsubscribe = handle.subscribe(() => {
            const state = handle.getState()
            const at = this.now()
            if (state.status === 'running') {
                this.mutate(notePath, commentId, (comment) => beginCommentJob(comment, at))
            } else if (!finalized && handle.isSettled()) {
                finalized = true
                if (state.status === 'done' && state.outcome) {
                    const outcome = state.outcome
                    this.mutate(notePath, commentId, (comment) =>
                        completeCommentJob(
                            comment,
                            { findings: outcome.findings, reply: outcome.summary },
                            at
                        )
                    )
                } else if (state.status === 'error') {
                    this.mutate(notePath, commentId, (comment) =>
                        failCommentJob(comment, state.error?.message ?? 'The request failed.', at)
                    )
                } else {
                    // Cancelled — by the user, or by unload. Either way nothing
                    // answered, and `interrupted` is the state that offers
                    // Retry without claiming to know why it ended.
                    this.mutate(notePath, commentId, (comment) => interruptCommentJob(comment, at))
                }
                this.syncTicker()
            }
            this.notify()
        })
        this.unsubscribers.set(commentId, unsubscribe)
        void handle.settled.then(() => {
            unsubscribe()
            this.unsubscribers.delete(commentId)
        })

        this.syncTicker()
        this.notify()
        return { ok: true, comment: input.comment }
    }

    /**
     * Prepares a retry: flips the durable comment back to `submitted` and
     * hands it back for the service to re-dispatch. Returns `null` when the
     * comment is gone or its status does not offer Retry — the caller must not
     * invent a request for a job that already has an answer.
     *
     * Nothing is resumed: the returned comment starts the lifecycle over with
     * a brand-new request (plan M8, Business Rules #1 and #13).
     */
    prepareRetry(notePath: string, commentId: string): MarginComment | null {
        const current = this.find(notePath, commentId)
        if (!current) {
            return null
        }
        const next = restartCommentJob(current, this.now())
        if (!next) {
            return null
        }
        this.deps.repository.upsert(notePath, next)
        this.notify()
        return next
    }

    /** Cancels one in-flight job; the store records it as `interrupted`. */
    cancel(commentId: string): boolean {
        return this.deps.runs.cancel(commentId)
    }

    /**
     * Removes a comment from the store for good, cancelling its job first.
     *
     * Business Rules #13 forbids deleting a comment SILENTLY — never
     * deleting one at all would be a different rule, and a worse one: the
     * user wrote the question, and an orphan they no longer care about would
     * otherwise be un-removable. Every caller must therefore ask first; the
     * store never deletes on its own.
     *
     * Follows a renamed note like every other mutation here.
     */
    delete(notePath: string, commentId: string): boolean {
        this.cancel(commentId)
        if (this.deps.repository.remove(notePath, commentId)) {
            this.notify()
            return true
        }
        const located = this.locate(commentId)
        if (!located) {
            return false
        }
        const removed = this.deps.repository.remove(located.notePath, commentId)
        this.notify()
        return removed
    }

    /** Closes a comment without acting on it. */
    dismiss(notePath: string, commentId: string): boolean {
        this.cancel(commentId)
        const changed = this.mutate(notePath, commentId, (comment) =>
            dismissCommentJob(comment, this.now())
        )
        this.notify()
        return changed
    }

    /**
     * Plugin unload: every in-flight job dies with the process, so every one
     * of them is recorded as `interrupted` NOW rather than being left to the
     * load-time normalization. Both paths exist because either can be the one
     * that runs — a clean unload gets here, a crash does not — and they must
     * agree on the outcome.
     */
    interruptAll(): readonly string[] {
        // `cancelAll` terminates each handle synchronously, and each handle's
        // subscription records `interrupted` on that transition — so by the
        // time this returns, the store already says so and the caller only has
        // to flush it.
        const cancelled = this.deps.runs.cancelAll()
        this.syncTicker()
        this.notify()
        return cancelled
    }

    /**
     * Every comment on a note as a render-ready row, in stored order, with the
     * live start time joined in from the in-flight run.
     */
    viewsFor(notePath: string): readonly CommentJobView[] {
        const now = this.now()
        return this.deps.repository.listFor(notePath).map((comment) =>
            commentJobView({
                comment,
                startedAt: this.deps.runs.get(comment.id)?.getState().startedAt ?? null,
                now
            })
        )
    }

    /** Every stored comment on a note, in stored order. */
    commentsFor(notePath: string): readonly MarginComment[] {
        return this.deps.repository.listFor(notePath)
    }

    /** The stored comment, or `null` when it is not (or no longer) there. */
    commentFor(notePath: string, commentId: string): MarginComment | null {
        return this.find(notePath, commentId)
    }

    /** Whether anything is in flight right now (drives the ticker and chrome). */
    hasActiveJobs(): boolean {
        return this.deps.runs.list().some((run) => !run.isSettled())
    }

    subscribe(listener: () => void): () => void {
        this.listeners.add(listener)
        return () => {
            this.listeners.delete(listener)
        }
    }

    /** Stops the ticker and drops subscriptions. Does NOT touch the store. */
    dispose(): void {
        this.disposed = true
        for (const unsubscribe of this.unsubscribers.values()) {
            unsubscribe()
        }
        this.unsubscribers.clear()
        this.stopTicker()
        this.listeners.clear()
    }

    // -- internals -----------------------------------------------------------

    private find(notePath: string, commentId: string): MarginComment | null {
        return (
            this.deps.repository.listFor(notePath).find((entry) => entry.id === commentId) ?? null
        )
    }

    /** Finds a comment by id across notes (a run knows its path, but a rename may have moved it). */
    private locate(commentId: string): { notePath: string; comment: MarginComment } | null {
        for (const notePath of this.deps.repository.notePaths()) {
            const comment = this.find(notePath, commentId)
            if (comment) {
                return { notePath, comment }
            }
        }
        return null
    }

    /**
     * Applies a guarded transition to the stored comment.
     *
     * The comment is re-read from the repository first: a rename, a delete or
     * a concurrent update may have moved or dropped it while the request was
     * in flight, and writing back a captured copy would resurrect a comment on
     * a note the user deleted.
     */
    private mutate(
        notePath: string,
        commentId: string,
        transition: (comment: MarginComment) => MarginComment | null
    ): boolean {
        const current = this.find(notePath, commentId)
        if (!current) {
            // The note was renamed under us: follow the comment to its new key
            // rather than dropping the answer the user waited for.
            const located = this.locate(commentId)
            if (!located) {
                return false
            }
            const moved = transition(located.comment)
            if (!moved) {
                return false
            }
            this.deps.repository.upsert(located.notePath, moved)
            return true
        }
        const next = transition(current)
        if (!next) {
            return false
        }
        this.deps.repository.upsert(notePath, next)
        return true
    }

    /** The ticker runs only while something is timing. */
    private syncTicker(): void {
        if (this.disposed) {
            this.stopTicker()
            return
        }
        if (this.hasActiveJobs()) {
            if (this.ticker === null) {
                this.ticker = this.deps.setTicker(() => this.notify(), COMMENT_TIMER_TICK_MS)
            }
            return
        }
        this.stopTicker()
    }

    private stopTicker(): void {
        if (this.ticker !== null) {
            this.deps.clearTicker(this.ticker)
            this.ticker = null
        }
    }

    private notify(): void {
        for (const listener of [...this.listeners]) {
            try {
                listener()
            } catch {
                // A faulty subscriber must never break the job pipeline.
            }
        }
    }
}
