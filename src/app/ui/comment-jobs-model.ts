import { commentJobAccessibleName, summarizeCommentJobs } from '../domain/comments/comment-job'
import type { CommentJobView } from '../domain/comments/comment-job'
import type { MarginComment } from '../domain/comments/margin-comment'

/**
 * The side-panel section for background comment jobs (plan §5.5 / M8, slice 2).
 *
 * Pure projection: the panel renders exactly what this returns and decides
 * nothing. Three rules are encoded here rather than in the DOM code:
 *
 * 1. **Dismissed comments are not listed.** They stay in the store so the same
 *    question is not re-asked, but a list that keeps showing what the user
 *    closed is a list they stop reading.
 * 2. **In-flight and retryable rows come first**, then answered ones, and
 *    within each group the stored order is preserved. What needs attention is
 *    at the top; the rest is history, and history that reshuffles itself while
 *    the user reads it is worse than history in a stable order.
 * 3. **The section disappears when it is empty.** A permanently-visible
 *    "Background comments (0)" header is chrome every note pays for.
 */

export interface CommentJobRow {
    readonly commentId: string
    /** The question the user parked, clipped for one line. */
    readonly question: string
    /** Editor that was asked, by the name it had when the comment was made. */
    readonly editorName: string
    readonly view: CommentJobView
    /** One announced sentence for assistive tech (WCAG 2.5.3 safe). */
    readonly accessibleName: string
}

export interface CommentJobsSection {
    /** `null` when there is nothing to show — the section is not rendered. */
    readonly heading: string | null
    readonly rows: readonly CommentJobRow[]
}

const QUESTION_MAX = 90

export interface CommentJobsSectionInput {
    readonly comments: readonly MarginComment[]
    /** Views produced by the registry, aligned with `comments` by id. */
    readonly views: readonly CommentJobView[]
    /**
     * Current name of an editor id, when it still exists. Falls back to the
     * name denormalized on the comment, so a deleted editor still reads as a
     * name rather than a uuid.
     */
    readonly editorName: (editorId: string) => string | null
}

export function commentJobsSection(input: CommentJobsSectionInput): CommentJobsSection {
    const viewById = new Map(input.views.map((view) => [view.commentId, view]))
    const rows: CommentJobRow[] = []
    for (const comment of input.comments) {
        const view = viewById.get(comment.id)
        if (!view || view.status === 'dismissed') {
            continue
        }
        const editorName =
            (input.editorName(comment.editorId) ?? comment.editorName) || 'Unknown editor'
        rows.push({
            commentId: comment.id,
            question: clip(comment.instruction),
            editorName,
            view,
            accessibleName: commentJobAccessibleName(view, editorName)
        })
    }
    if (rows.length === 0) {
        return { heading: null, rows: [] }
    }
    const ordered = [
        ...rows.filter((row) => needsAttention(row)),
        ...rows.filter((row) => !needsAttention(row))
    ]
    const tally = summarizeCommentJobs(ordered.map((row) => row.view))
    const count = ordered.length === 1 ? '1 comment' : `${ordered.length} comments`
    return {
        heading:
            tally.length > 0 ? `Background comments — ${tally}` : `Background comments — ${count}`,
        rows: ordered
    }
}

/**
 * Notice copy for a retry outcome. `null` = say nothing: a dispatched retry
 * announces itself by the row turning into a running one with a timer, and a
 * Notice on top of that is noise.
 *
 * Every other branch DOES speak, because the row would otherwise sit unchanged
 * and the click would look ignored.
 */
export function commentRetryNotice(
    status:
        | 'started'
        | 'excluded'
        | 'rule-disabled'
        | 'no-editor'
        | 'needs-confirmation'
        | 'invalid-span'
        | 'note-full'
        | 'already-running'
        | 'unknown-comment'
        | 'not-retryable'
        | 'orphaned'
): string | null {
    switch (status) {
        case 'started':
            return null
        case 'excluded':
            return 'That note is excluded, so nothing is sent for it.'
        case 'rule-disabled':
            return 'A rule switches AI Editor off for that note.'
        case 'no-editor':
            return 'The editor this comment was asked of cannot run right now.'
        case 'needs-confirmation':
            return 'That note is large — open it and re-ask so the size warning can be confirmed.'
        case 'orphaned':
            // The comment is kept, never deleted (Business Rules #13); it just
            // cannot be re-asked until the text it is about comes back.
            return 'The text this comment was about is no longer in the note, so it cannot be re-asked.'
        case 'not-retryable':
            return 'That comment already has an answer.'
        case 'unknown-comment':
            return 'That comment is no longer stored.'
        case 'already-running':
            return 'That comment is already being answered.'
        case 'note-full':
            return 'That note is at the comment limit.'
        case 'invalid-span':
            return 'That comment has no text to ask about.'
    }
}

/**
 * Notice copy for parking a NEW comment.
 *
 * `null` = say nothing on success: the margin card appears immediately with
 * its queued state, and a Notice on top of visible feedback is noise. The
 * caller adds its own confirmation only where the column may not be on screen.
 *
 * Deliberately a separate function from {@link commentRetryNotice} even though
 * several branches read the same: the two flows can refuse for different
 * reasons (a retry can be orphaned, a new comment cannot be `not-retryable`),
 * and one function covering both would have to accept statuses it can never
 * receive.
 */
export function commentStartNotice(
    status:
        | 'started'
        | 'excluded'
        | 'rule-disabled'
        | 'no-editor'
        | 'needs-confirmation'
        | 'invalid-span'
        | 'note-full'
        | 'already-running'
): string | null {
    switch (status) {
        case 'started':
            return null
        case 'excluded':
            return 'This note is excluded, so nothing is sent for it.'
        case 'rule-disabled':
            return 'A rule switches AI Editor off for this note.'
        case 'no-editor':
            return 'That editor cannot run right now — check the Editors settings tab.'
        case 'needs-confirmation':
            // Only reachable when the caller skipped the confirmation round
            // trip; the dialog is the normal path.
            return 'This note is large — confirm the size warning to ask about it.'
        case 'invalid-span':
            return 'Select the text to comment on first.'
        case 'note-full':
            return 'This note is at the comment limit. Resolve or delete a comment first.'
        case 'already-running':
            return 'That comment is already being answered.'
    }
}

function needsAttention(row: CommentJobRow): boolean {
    return row.view.canCancel || row.view.canRetry
}

function clip(text: string): string {
    const collapsed = text.replace(/\s+/g, ' ').trim()
    return collapsed.length > QUESTION_MAX ? `${collapsed.slice(0, QUESTION_MAX)}…` : collapsed
}
