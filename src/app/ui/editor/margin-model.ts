import { commentJobAccessibleName } from '../../domain/comments/comment-job'
import type { CommentJobView } from '../../domain/comments/comment-job'
import type { MarginComment } from '../../domain/comments/margin-comment'
import type { CommentAnchorOutcome } from '../../domain/comments/reanchor'

/**
 * What the margin comment column renders (plan §5.5 / M8, slice 3).
 *
 * Pure projection over the durable comment, its live job view and its
 * re-anchoring outcome. The DOM class (`margin-column.ts`) renders exactly
 * what comes out of here and decides nothing; the geometry is decided by
 * `margin-layout.ts`. Splitting the three is what lets every rule below be
 * spec-pinned without a vault, a backend or CodeMirror.
 *
 * Four rules are encoded here rather than in the DOM:
 *
 * 1. **Resolved comments leave the margin.** A `dismissed` comment stays in
 *    the store so the same question is not re-asked (Business Rules #13), but
 *    it is not margin furniture any more. The side panel is where history
 *    lives.
 * 2. **Orphans are visible, grouped, and collapsed by default.** A comment
 *    whose quote no longer resolves has no line to sit next to, and pinning it
 *    to a guessed position is exactly what Business Rules #4 forbids. It goes
 *    into one collapsed group at the top of the column, WITH its quote, so the
 *    user can find the text themselves. Never silently dropped.
 * 3. **The body is truncated, never trimmed away.** A margin card shows the
 *    first {@link MARGIN_BODY_MAX} characters of the answer and expands in
 *    place; the full text is always one click away and never only in a
 *    tooltip (a tooltip cannot be selected, scrolled or read by touch).
 * 4. **An affordance appears only when it can act.** Retry needs a live
 *    anchor (re-asking about text that is gone would answer about something
 *    else — `retryCommentJob` refuses it, so the button must not offer it),
 *    Cancel needs something in flight, Reveal needs a position.
 *
 * ## Resolve vs delete — two different promises
 *
 * **Resolve** closes the conversation and KEEPS the record (store status
 * `dismissed`): the question was answered or has stopped mattering, and the
 * store remembers it so nothing re-asks it. **Delete** removes the comment
 * from the store for good. Business Rules #13 forbids *silently* deleting a
 * comment — a button the user pressed is not silent, and without it a parked
 * question could only ever be hidden, never taken back.
 */

/** Characters of the answer shown before the body is truncated. */
export const MARGIN_BODY_MAX = 220

/** Characters of the question shown on a card (it is a header, not the content). */
export const MARGIN_QUESTION_MAX = 140

/** Characters of an orphan's quote shown so the user can locate the text. */
export const MARGIN_QUOTE_MAX = 120

/** Everything the column needs about one comment, resolved by the glue. */
export interface MarginCommentInput {
    readonly comment: MarginComment
    /** Live job state (status label, timer, what can be done to it). */
    readonly view: CommentJobView
    /** Result of re-anchoring the comment against the live note text. */
    readonly outcome: CommentAnchorOutcome
    /** Persona colour of the editor that owns the job. */
    readonly color: string
    /** Current name of that editor, falling back to the denormalized one. */
    readonly editorName: string
    /** Whether the user expanded this card's body. */
    readonly expanded: boolean
}

export interface MarginCardActions {
    readonly canReveal: boolean
    readonly canRetry: boolean
    readonly canCancel: boolean
    readonly canResolve: boolean
    readonly canDelete: boolean
}

export interface MarginCardView {
    readonly commentId: string
    readonly editorName: string
    readonly color: string
    /** The question the user parked, clipped. */
    readonly question: string
    /** Sentence-case state ("Reviewing", "2 findings", "Interrupted"). */
    readonly statusLabel: string
    /** Live elapsed time while the job runs, else `null`. */
    readonly timer: string | null
    /** The answer (or the failure reason), clipped unless expanded. */
    readonly body: string | null
    /** True when `body` is a clipped view of a longer text. */
    readonly truncated: boolean
    /** True when the user expanded it (the toggle reads "Show less"). */
    readonly expanded: boolean
    /**
     * The quote, shown for orphans only: it is the only way left to find the
     * text the question was about.
     */
    readonly quote: string | null
    /** Matched only after normalization — the span drifted; say so. */
    readonly drifted: boolean
    readonly orphaned: boolean
    readonly actions: MarginCardActions
    /** One announced sentence for assistive tech (WCAG 2.5.3 safe). */
    readonly accessibleName: string
}

/** One line's worth of comments, positioned as a unit. */
export interface MarginGroupInput {
    /** Cluster key from `clusterByLine` — the first member's comment id. */
    readonly key: string
    /** Desired y of the line, in column coordinates. */
    readonly anchorTop: number
    /** Whether the user expanded a multi-comment group. */
    readonly expanded: boolean
    readonly comments: readonly MarginCommentInput[]
}

export interface MarginGroupView {
    readonly key: string
    readonly anchorTop: number
    /**
     * True when the group holds several comments and is not expanded: it
     * renders as one "N comments" chip. A single comment is never collapsed —
     * a chip that expands to one card is a click that buys nothing.
     */
    readonly collapsed: boolean
    /** Chip text while collapsed, else `null`. */
    readonly chipLabel: string | null
    /** Chip accessible name while collapsed, else `null`. */
    readonly chipAccessibleName: string | null
    /** Cards to render: all of them, or none while collapsed. */
    readonly cards: readonly MarginCardView[]
}

export interface MarginOrphanGroupView {
    readonly heading: string
    readonly expanded: boolean
    /** Cards to render: all of them, or none while collapsed. */
    readonly cards: readonly MarginCardView[]
}

export interface MarginColumnModel {
    readonly groups: readonly MarginGroupView[]
    /** `null` when nothing is orphaned — no empty group, ever. */
    readonly orphans: MarginOrphanGroupView | null
    /** True when there is nothing at all to render (the column is not shown). */
    readonly empty: boolean
}

export interface MarginColumnModelInput {
    /** Anchored comments, already clustered by line. */
    readonly groups: readonly MarginGroupInput[]
    /** Comments whose quote no longer resolves, in stored order. */
    readonly orphans: readonly MarginCommentInput[]
    readonly orphansExpanded: boolean
}

/** Whether a comment belongs in the margin at all. */
export function isMarginVisible(comment: MarginComment): boolean {
    return comment.status !== 'dismissed'
}

export function marginColumnModel(input: MarginColumnModelInput): MarginColumnModel {
    const groups = input.groups.map((group) => marginGroupView(group))
    const orphanCards = input.orphans.map((entry) => marginCardView(entry))
    const orphans: MarginOrphanGroupView | null =
        orphanCards.length === 0
            ? null
            : {
                  heading: orphanHeading(orphanCards.length),
                  expanded: input.orphansExpanded,
                  cards: input.orphansExpanded ? orphanCards : []
              }
    return {
        groups,
        orphans,
        empty: groups.length === 0 && orphans === null
    }
}

/**
 * Identity of a rendered column: everything the DOM depends on, and NOTHING
 * that only moves it.
 *
 * The column is rebuilt only when this changes. `anchorTop` is deliberately
 * excluded — scrolling changes every anchor on every frame, and rebuilding
 * there would throw away keyboard focus, re-collapse expanded answers and
 * flicker the whole margin. Scrolling repositions; it never re-renders.
 */
export function marginModelKey(model: MarginColumnModel): string {
    const parts: string[] = []
    for (const group of model.groups) {
        parts.push(`g:${group.key}:${group.collapsed ? '1' : '0'}`)
        for (const card of group.cards) {
            parts.push(cardKey(card))
        }
    }
    if (model.orphans !== null) {
        parts.push(`o:${model.orphans.heading}:${model.orphans.expanded ? '1' : '0'}`)
        for (const card of model.orphans.cards) {
            parts.push(cardKey(card))
        }
    }
    return parts.join('|')
}

function cardKey(card: MarginCardView): string {
    const actions = [
        card.actions.canReveal,
        card.actions.canRetry,
        card.actions.canCancel,
        card.actions.canResolve,
        card.actions.canDelete
    ]
        .map((allowed) => (allowed ? '1' : '0'))
        .join('')
    return [
        'c',
        card.commentId,
        card.editorName,
        card.color,
        card.question,
        card.statusLabel,
        card.timer ?? '',
        card.body ?? '',
        card.expanded ? '1' : '0',
        card.truncated ? '1' : '0',
        card.quote ?? '',
        card.drifted ? '1' : '0',
        actions
    ].join(' ')
}

/**
 * Heading of the orphan group. Names the state AND the consequence in the one
 * place the user meets it — "orphaned" alone is plugin vocabulary.
 */
export function orphanHeading(count: number): string {
    return count === 1 ? '1 comment lost its text' : `${count} comments lost their text`
}

/** Chip text for a collapsed line group. */
export function clusterChipLabel(count: number): string {
    return count === 1 ? '1 comment' : `${count} comments`
}

function marginGroupView(group: MarginGroupInput): MarginGroupView {
    const cards = group.comments.map((entry) => marginCardView(entry))
    const collapsed = cards.length > 1 && !group.expanded
    return {
        key: group.key,
        anchorTop: group.anchorTop,
        collapsed,
        chipLabel: collapsed ? clusterChipLabel(cards.length) : null,
        chipAccessibleName: collapsed
            ? `${clusterChipLabel(cards.length)} on this line, from ${listEditors(cards)}`
            : null,
        cards: collapsed ? [] : cards
    }
}

export function marginCardView(input: MarginCommentInput): MarginCardView {
    const { comment, view, outcome } = input
    const orphaned = outcome === 'orphaned'
    // Normalized ONCE, then measured: deciding "truncated" by comparing the
    // clipped string to the raw one would report whitespace collapsing as
    // truncation and offer a "Show more" that reveals nothing.
    const full = normalize(bodyText(comment))
    const truncated = full !== null && full.length > MARGIN_BODY_MAX
    return {
        commentId: comment.id,
        editorName: input.editorName,
        color: input.color,
        question: clip(comment.instruction, MARGIN_QUESTION_MAX),
        statusLabel: view.statusLabel,
        timer: view.timer,
        body: full === null ? null : input.expanded || !truncated ? full : clipTo(full),
        truncated,
        expanded: input.expanded && truncated,
        quote: orphaned ? clip(comment.quote, MARGIN_QUOTE_MAX) : null,
        drifted: outcome === 'fuzzy',
        orphaned,
        actions: {
            canReveal: !orphaned,
            // An orphan has no live span, and `retryCommentJob` refuses it
            // rather than re-asking about whatever is there now.
            canRetry: view.canRetry && !orphaned,
            canCancel: view.canCancel,
            canResolve: view.canDismiss,
            canDelete: true
        },
        accessibleName: cardAccessibleName(input, view)
    }
}

/**
 * The announced sentence: who was asked, where the job stands, what was
 * asked, and — for an orphan — that it no longer points anywhere. The visible
 * card splits those across elements; assistive tech must hear one.
 */
function cardAccessibleName(input: MarginCommentInput, view: CommentJobView): string {
    const base = commentJobAccessibleName(view, input.editorName)
    const parts = [base, clip(input.comment.instruction, MARGIN_QUESTION_MAX)]
    if (input.outcome === 'orphaned') {
        parts.push('the text it was about is no longer in the note')
    } else if (input.outcome === 'fuzzy') {
        parts.push('the text it was about has changed slightly')
    }
    return parts.join(' — ')
}

/**
 * What the card shows under the question: the editor's note-level reply, the
 * critiques it pinned, or the failure reason. `null` when the job has nothing
 * to say yet (queued, running, interrupted) — the status line already says
 * where it stands, and an empty body would be a box of nothing.
 *
 * Several findings are joined rather than listed as one: a margin card is a
 * comment, and the side panel is where a findings LIST belongs.
 */
function bodyText(comment: MarginComment): string | null {
    if (comment.status === 'failed') {
        return comment.error ?? null
    }
    if (comment.status !== 'done') {
        return null
    }
    if (comment.reply && comment.reply.trim().length > 0) {
        return comment.reply.trim()
    }
    const critiques = comment.findings
        .map((finding) => finding.critique.trim())
        .filter((critique) => critique.length > 0)
    return critiques.length === 0 ? null : critiques.join('\n\n')
}

function listEditors(cards: readonly MarginCardView[]): string {
    const names: string[] = []
    for (const card of cards) {
        if (!names.includes(card.editorName)) {
            names.push(card.editorName)
        }
    }
    return names.join(', ')
}

/**
 * Collapses runs of spaces and tabs but KEEPS newlines: an answer that came
 * back as paragraphs stays paragraphs in the card. `null` in, `null` out, and
 * a string that normalizes to nothing is nothing.
 */
function normalize(text: string | null): string | null {
    if (text === null) {
        return null
    }
    const collapsed = text
        .replace(/[ \t]+/g, ' ')
        .replace(/\n{3,}/g, '\n\n')
        .trim()
    return collapsed.length === 0 ? null : collapsed
}

/** Clips a normalized body to {@link MARGIN_BODY_MAX}. */
function clipTo(text: string): string {
    return `${text.slice(0, MARGIN_BODY_MAX).trimEnd()}…`
}

/** Single-line clip for headers (question, quote): newlines become spaces. */
function clip(text: string, max: number): string {
    const collapsed = text.replace(/\s+/g, ' ').trim()
    return collapsed.length > max ? `${collapsed.slice(0, max)}…` : collapsed
}
