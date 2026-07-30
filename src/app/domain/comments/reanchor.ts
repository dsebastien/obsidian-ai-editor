import type { Anchor } from '../anchoring/anchor'
import { createAnchor } from '../anchoring/anchor'
import { createQuoteMatcher, type QuoteMatcher } from '../anchoring/match'
import type { MarginComment } from './margin-comment'

/**
 * Re-anchoring durable comments against the note as it reads NOW.
 *
 * A margin comment survives the session; the note does not stay still while it
 * does. So a comment is never restored from a stored position — it is
 * RESOLVED, from the same quote + prefix/suffix/occurrence hints a finding
 * carries, through the same matcher (`matchQuote`). One anchoring engine, one
 * set of rules, one place where "where does this text live" is decided.
 *
 * Three outcomes, and the vocabulary is the contract with the UI:
 *
 * - `exact`    — the quote is verbatim in the note, uniquely (or uniquely
 *                disambiguated by the hints). Fully actionable.
 * - `fuzzy`    — it matched only after typographic normalization (smart
 *                quotes, whitespace runs, case). Anchored, and safe to act on
 *                because `anchoredText` is sliced from the SOURCE, so any
 *                precondition check compares real text — but flagged, because
 *                the user should know the span drifted.
 * - `orphaned` — not found, or found in several places the hints cannot tell
 *                apart. The comment is KEPT and shown with its quote; it is
 *                never guessed into a position (Business Rules #4) and never
 *                deleted (the user parked a question; losing it because they
 *                rewrote a sentence would break the one promise this feature
 *                makes).
 */

export type CommentAnchorOutcome = 'exact' | 'fuzzy' | 'orphaned'

export interface AnchoredComment {
    readonly comment: MarginComment
    readonly outcome: CommentAnchorOutcome
    /** Live position in the current text; `null` when orphaned. */
    readonly anchor: Anchor | null
    /**
     * The CURRENT text at that position, sliced from the note (not the stored
     * quote): the precondition any later edit is verified against, exactly
     * like a finding's `anchoredText`. `null` when orphaned.
     */
    readonly anchoredText: string | null
}

/** Whether an outcome puts the comment somewhere in the document. */
export function isAnchored(outcome: CommentAnchorOutcome): boolean {
    return outcome !== 'orphaned'
}

/** Resolves ONE comment through a matcher already bound to the note text. */
function reanchorWith(matcher: QuoteMatcher, comment: MarginComment): AnchoredComment {
    const match = matcher.match(comment.quote, {
        ...(comment.prefix === undefined ? {} : { prefix: comment.prefix }),
        ...(comment.suffix === undefined ? {} : { suffix: comment.suffix }),
        ...(comment.occurrence === undefined ? {} : { occurrence: comment.occurrence })
    })
    if (match.status !== 'matched') {
        return { comment, outcome: 'orphaned', anchor: null, anchoredText: null }
    }
    const { from, to, strategy } = match.match
    return {
        comment,
        outcome: strategy === 'exact' ? 'exact' : 'fuzzy',
        anchor: createAnchor(from, to),
        anchoredText: matcher.text.slice(from, to)
    }
}

/** Resolves ONE comment against the current note text. */
export function reanchorComment(text: string, comment: MarginComment): AnchoredComment {
    return reanchorWith(createQuoteMatcher(text), comment)
}

/**
 * Resolves a note's comments in the order they were stored. Order is
 * preserved rather than sorted by position: orphans have no position, and a
 * list that reshuffles itself every time a match is lost would make the margin
 * jump around. Callers that render a margin column sort the anchored ones
 * themselves.
 *
 * ONE matcher for the whole batch. This runs on the refresh cycle — every edit
 * batch, on a note that may hold up to `MAX_COMMENTS_PER_NOTE` comments — and
 * a comment that no longer resolves walks the normalized rung of the ladder,
 * which costs a full pass over the note. Sharing the matcher makes that pass
 * happen at most once per call instead of once per comment (measured: 7.1 s →
 * 21 ms for 500 orphans on a 200 000-character note).
 */
export function reanchorComments(
    text: string,
    comments: readonly MarginComment[]
): readonly AnchoredComment[] {
    const matcher = createQuoteMatcher(text)
    return comments.map((comment) => reanchorWith(matcher, comment))
}

/** Counts by outcome — what a "3 comments, 1 orphaned" line reads from. */
export interface CommentAnchorTally {
    readonly exact: number
    readonly fuzzy: number
    readonly orphaned: number
}

export function tallyAnchorOutcomes(anchored: readonly AnchoredComment[]): CommentAnchorTally {
    let exact = 0
    let fuzzy = 0
    let orphaned = 0
    for (const entry of anchored) {
        if (entry.outcome === 'exact') {
            exact += 1
        } else if (entry.outcome === 'fuzzy') {
            fuzzy += 1
        } else {
            orphaned += 1
        }
    }
    return { exact, fuzzy, orphaned }
}
