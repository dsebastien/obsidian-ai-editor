import type { RawFinding } from '../operations/contract'
import type { MarginComment, MarginCommentStatus } from './margin-comment'

/**
 * The lifecycle of a BACKGROUND comment job (plan §5.5 / M8, slice 2).
 *
 * A margin comment is the only thing in this plugin that the user parks and
 * walks away from: they ask an editor about a span, keep writing, switch
 * notes, close the note — and the answer lands whenever it lands. That is a
 * different contract from a review (note-focused, ephemeral, watched while it
 * runs), and it forces two rules that live here:
 *
 * 1. **The status is the truth, and the truth includes "I do not know".** A
 *    job that was in flight when Obsidian quit is `interrupted`: the backend
 *    request is gone with the process, no result is coming, and nothing about
 *    it can be recovered. It offers **Retry** — a new request the user asks
 *    for — and is NEVER resumed. A resumed job would be a backend call the
 *    user did not authorize in this session (Business Rules #1) whose result
 *    would be presented as if it belonged to the original ask. Pretending a
 *    dead request is still alive is a lie the margin must not tell.
 * 2. **A retry replaces, it never merges.** Retrying clears the previous
 *    error and the previous answer. Keeping half of a failed round and
 *    appending a new one produces an answer no editor ever gave.
 *
 * Every transition is a pure function over `MarginComment` returning the next
 * comment, or `null` when the transition is not legal from the current status
 * — so an out-of-order event (a late stream terminal for a job the user
 * already dismissed) is refused where it can be spec-pinned, instead of
 * silently rewriting durable state.
 */

/** Statuses that mean "a request is queued or in flight in THIS session". */
const IN_FLIGHT: readonly MarginCommentStatus[] = ['submitted', 'running']

/** Statuses that offer Retry: the job ended without an answer. */
const RETRYABLE: readonly MarginCommentStatus[] = ['interrupted', 'failed']

export function isCommentInFlight(status: MarginCommentStatus): boolean {
    return IN_FLIGHT.includes(status)
}

/**
 * Whether the job can be retried. `done` is deliberately excluded: the editor
 * answered, and asking the same question again is a NEW comment rather than a
 * rerun of the old one (a rerun would silently destroy an answer the user may
 * still be reading). `dismissed` is excluded for the same reason it exists —
 * the user closed it so it would stop coming back.
 */
export function canRetryCommentJob(status: MarginCommentStatus): boolean {
    return RETRYABLE.includes(status)
}

/** Whether the job has something to cancel. */
export function canCancelCommentJob(status: MarginCommentStatus): boolean {
    return isCommentInFlight(status)
}

/** Whether the user can close the comment (everything but an already-closed one). */
export function canDismissCommentJob(status: MarginCommentStatus): boolean {
    return status !== 'dismissed'
}

/** What a completed job reports back. */
export interface CommentJobOutcome {
    readonly findings: readonly RawFinding[]
    /** Note-level answer when the editor replied without pinning a span. */
    readonly reply: string | null
}

/** `submitted` → `running`: the backend request actually started. */
export function beginCommentJob(comment: MarginComment, at: number): MarginComment | null {
    if (comment.status !== 'submitted') {
        return null
    }
    return { ...comment, status: 'running', updatedAt: at }
}

/**
 * → `done`. Accepted from either in-flight status: a fast backend can produce
 * its terminal event before the caller has recorded `running`.
 */
export function completeCommentJob(
    comment: MarginComment,
    outcome: CommentJobOutcome,
    at: number
): MarginComment | null {
    if (!isCommentInFlight(comment.status)) {
        return null
    }
    const { error: _error, reply: _reply, ...rest } = comment
    return {
        ...rest,
        status: 'done',
        findings: [...outcome.findings],
        ...(outcome.reply === null || outcome.reply.length === 0 ? {} : { reply: outcome.reply }),
        updatedAt: at
    }
}

/**
 * → `failed`, carrying the ALREADY-REDACTED message (Business Rules #12 — the
 * redaction seam lives at the backend boundary, not here).
 */
export function failCommentJob(
    comment: MarginComment,
    message: string,
    at: number
): MarginComment | null {
    if (!isCommentInFlight(comment.status)) {
        return null
    }
    return { ...comment, status: 'failed', error: message, updatedAt: at }
}

/**
 * → `interrupted`. Used in exactly two places, and they are the same event
 * seen from two sides: plugin unload (this session is ending, so every job
 * still in flight is dead) and the load-time normalization in
 * `loadCommentStore` (the previous session ended without getting to do that).
 * Recording it at unload is what makes the restart honest even for a job that
 * had not yet been written to disk as `running`.
 */
export function interruptCommentJob(comment: MarginComment, at: number): MarginComment | null {
    if (!isCommentInFlight(comment.status)) {
        return null
    }
    return { ...comment, status: 'interrupted', updatedAt: at }
}

/** → `dismissed`. Kept in the store so the same question is not re-asked. */
export function dismissCommentJob(comment: MarginComment, at: number): MarginComment | null {
    if (comment.status === 'dismissed') {
        return null
    }
    return { ...comment, status: 'dismissed', updatedAt: at }
}

/**
 * `interrupted` / `failed` → `submitted`: the Retry affordance.
 *
 * Clears the error AND the answer: a retried job is a fresh request whose
 * result replaces whatever the last round produced. (Neither status can
 * carry findings today — both mean the round produced nothing — but the
 * clearing is unconditional so a future partial-result state cannot leak an
 * old editor's words into a new round's answer.)
 */
export function restartCommentJob(comment: MarginComment, at: number): MarginComment | null {
    if (!canRetryCommentJob(comment.status)) {
        return null
    }
    const { error: _error, reply: _reply, ...rest } = comment
    return { ...rest, status: 'submitted', findings: [], updatedAt: at }
}

// ---------------------------------------------------------------------------
// Live timer
// ---------------------------------------------------------------------------

/**
 * Elapsed wall time as `m:ss`, or `h:mm:ss` past the hour.
 *
 * Seconds are FLOORED and negatives clamp to zero: the timer is read from a
 * clock the user's machine can move (sleep, NTP, timezone changes), and a
 * background job showing `-0:03` or jumping a second ahead of itself would
 * read as a bug in the thing that is supposed to prove the job is alive.
 */
export function formatElapsed(ms: number): string {
    const total = Number.isFinite(ms) ? Math.max(0, Math.floor(ms / 1_000)) : 0
    const seconds = total % 60
    const minutes = Math.floor(total / 60) % 60
    const hours = Math.floor(total / 3_600)
    const pad = (value: number): string => String(value).padStart(2, '0')
    return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`
}

// ---------------------------------------------------------------------------
// View model
// ---------------------------------------------------------------------------

/** Everything a surface needs to render one job row. Pure, no DOM. */
export interface CommentJobView {
    readonly commentId: string
    readonly status: MarginCommentStatus
    /** Sentence-case state ("Reviewing", "Interrupted", "2 findings"). */
    readonly statusLabel: string
    /** Live elapsed time, or `null` when the job is not timing. */
    readonly timer: string | null
    /** Second line: the failure message, the reply excerpt, or nothing. */
    readonly detail: string | null
    readonly canCancel: boolean
    readonly canRetry: boolean
    readonly canDismiss: boolean
}

export interface CommentJobViewInput {
    readonly comment: MarginComment
    /**
     * Unix ms the CURRENT attempt started, from the live job registry. `null`
     * for anything the registry is not tracking — which is every job restored
     * from disk. A restored `interrupted` job deliberately shows no timer:
     * the only honest elapsed time for it is unknown (the session it ran in
     * is gone), and reusing `updatedAt` would render the time since the
     * crash as if it were time spent working.
     */
    readonly startedAt: number | null
    readonly now: number
}

const DETAIL_MAX = 160

export function commentJobView(input: CommentJobViewInput): CommentJobView {
    const { comment, startedAt, now } = input
    const timing = isCommentInFlight(comment.status) && startedAt !== null
    return {
        commentId: comment.id,
        status: comment.status,
        statusLabel: commentStatusLabel(comment),
        timer: timing && startedAt !== null ? formatElapsed(now - startedAt) : null,
        detail: commentDetail(comment),
        canCancel: canCancelCommentJob(comment.status),
        canRetry: canRetryCommentJob(comment.status),
        canDismiss: canDismissCommentJob(comment.status)
    }
}

function commentStatusLabel(comment: MarginComment): string {
    switch (comment.status) {
        case 'submitted':
            return 'Queued'
        case 'running':
            return 'Reviewing'
        case 'interrupted':
            return 'Interrupted'
        case 'failed':
            return 'Failed'
        case 'dismissed':
            return 'Dismissed'
        case 'done': {
            const count = comment.findings.length
            if (count === 0) {
                return comment.reply ? 'Answered' : 'Nothing to report'
            }
            return count === 1 ? '1 finding' : `${count} findings`
        }
    }
}

function commentDetail(comment: MarginComment): string | null {
    if (comment.status === 'failed' && comment.error) {
        return truncateDetail(comment.error)
    }
    if (comment.status === 'interrupted') {
        // States the contract in the one place the user meets it. Nothing is
        // resumed; the only way forward is a new request they ask for.
        return 'Obsidian closed while this was running. Nothing was resumed — retry to ask again.'
    }
    if (comment.status === 'done' && comment.reply) {
        return truncateDetail(comment.reply)
    }
    return null
}

function truncateDetail(text: string): string {
    const collapsed = text.replace(/\s+/g, ' ').trim()
    return collapsed.length > DETAIL_MAX ? `${collapsed.slice(0, DETAIL_MAX)}…` : collapsed
}

/**
 * Composed accessible name for a job row: the surfaces render the label and
 * the timer as separate elements, but assistive tech must hear one sentence.
 */
export function commentJobAccessibleName(view: CommentJobView, editorName: string): string {
    const parts = [editorName, view.statusLabel]
    if (view.timer !== null) {
        parts.push(`for ${view.timer}`)
    }
    return parts.join(' — ')
}

/**
 * One-line tally for a section header ("2 running, 1 interrupted"). Empty
 * string when there is nothing worth announcing — a surface that shows this
 * for zero jobs would be permanent chrome for an occasional feature.
 */
export function summarizeCommentJobs(views: readonly CommentJobView[]): string {
    let running = 0
    let interrupted = 0
    let failed = 0
    for (const view of views) {
        if (isCommentInFlight(view.status)) {
            running += 1
        } else if (view.status === 'interrupted') {
            interrupted += 1
        } else if (view.status === 'failed') {
            failed += 1
        }
    }
    const parts: string[] = []
    if (running > 0) {
        parts.push(`${running} running`)
    }
    if (interrupted > 0) {
        parts.push(`${interrupted} interrupted`)
    }
    if (failed > 0) {
        parts.push(`${failed} failed`)
    }
    return parts.join(', ')
}
