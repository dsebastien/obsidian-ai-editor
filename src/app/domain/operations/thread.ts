import type { Anchor } from '../anchoring/anchor'
import type { ThreadTurnResult } from './contract'

/**
 * Per-finding push-back threads (plan M4, design §6 decision 1: threads are
 * the card half of freeform "Ask an editor").
 *
 * A thread is a short back-and-forth about ONE finding: the user pushes back
 * ("I disagree — this repetition is intentional"), the same editor persona
 * that produced the finding answers, and the answer either withdraws the
 * finding (concede) or holds it with a sharpened critique / revised
 * suggestion. This module owns the pure rules; the state itself lives on the
 * finding in the `FindingStore`, and the backend round trip is orchestrated by
 * the run handle.
 *
 * Invariants:
 * - `thread` holds COMPLETED exchanges only and is therefore strictly
 *   alternating `user, editor, user, editor…` (even length). An in-flight or
 *   failed turn lives in `ThreadTurn`, never in `thread` — so a failure can
 *   never leave a dangling user message that the next request would replay as
 *   an unanswered turn.
 * - Threads are session-scoped: they live and die with the finding (a retried
 *   editor removes its findings, so their threads go with them). Nothing is
 *   persisted.
 */

/** One completed message of a finding's thread. */
export interface ThreadMessage {
    readonly role: 'user' | 'editor'
    readonly content: string
}

/**
 * The turn that is not part of `thread` yet: either in flight (the user's
 * message is on screen with a spinner) or failed (the message is shown with
 * the reason so the user can send it again). Cleared on success, when the two
 * completed messages join `thread`.
 */
export type ThreadTurn =
    | { readonly status: 'pending'; readonly message: string }
    | { readonly status: 'failed'; readonly message: string; readonly reason: string }

/**
 * Maximum completed exchanges (user + editor) per finding. A push-back thread
 * is a triage device, not a chat: past a handful of turns the useful move is
 * to accept, dismiss, or re-review — and every turn replays the whole history
 * to the backend, so the cost grows quadratically.
 */
export const THREAD_MAX_TURNS = 6

/** Completed exchanges in a thread (`thread.length / 2` by the invariant). */
export function completedThreadTurns(thread: readonly ThreadMessage[]): number {
    return Math.floor(thread.length / 2)
}

/** Whether the thread reached {@link THREAD_MAX_TURNS} completed exchanges. */
export function isThreadFull(thread: readonly ThreadMessage[]): boolean {
    return completedThreadTurns(thread) >= THREAD_MAX_TURNS
}

/** Exchanges the user may still send on this finding (never negative). */
export function threadTurnsLeft(thread: readonly ThreadMessage[]): number {
    return Math.max(0, THREAD_MAX_TURNS - completedThreadTurns(thread))
}

/**
 * Why a push-back could not be sent. Lives in the domain so every layer can
 * name a refusal without depending on the store: the `FindingStore` decides,
 * the run handle and the dispatch service pass it through, and the card turns
 * it into copy.
 */
export type ThreadBeginFailure =
    | 'not-found'
    /** The finding is terminal (accepted / rejected / dismissed / superseded). */
    | 'invalid-status'
    /** A turn is already in flight for this finding. */
    | 'in-flight'
    /** {@link THREAD_MAX_TURNS} completed exchanges reached. */
    | 'cap-reached'
    | 'blank-message'

/**
 * What a validated `thread-turn` result means for the finding. Concede wins
 * over any revision: a withdrawn finding has no suggestion left to apply, so
 * a model that both concedes and revises is read as withdrawing (the contract
 * says so too).
 */
export type ThreadOutcome =
    | { readonly kind: 'concede'; readonly reply: string }
    | {
          readonly kind: 'hold'
          readonly reply: string
          readonly revisedCritique: string | null
          readonly revisedSuggestion: string | null
      }

/**
 * Normalizes a backend thread-turn result into an outcome: blank revisions
 * count as absent (the schema bounds length but cannot require non-empty
 * optionals), and whitespace-only replies are impossible (`reply` is
 * `min(1)`) but are still trimmed for display.
 */
export function resolveThreadOutcome(result: ThreadTurnResult): ThreadOutcome {
    const reply = result.reply.trim()
    if (result.concede) {
        return { kind: 'concede', reply }
    }
    return {
        kind: 'hold',
        reply,
        revisedCritique: blankToNull(result.revisedCritique),
        revisedSuggestion: blankToNull(result.revisedSuggestion)
    }
}

function blankToNull(value: string | undefined): string | null {
    if (value === undefined) {
        return null
    }
    const trimmed = value.trim()
    return trimmed.length > 0 ? trimmed : null
}

/**
 * The text a thread turn must talk about: the CURRENT text of the finding's
 * span when it is still anchored (the user may have edited it since the
 * review — pushing back about text that no longer exists is worse than
 * useless), otherwise the anchored text captured at review time, otherwise
 * the raw quote. Never fuzzy-relocates and never guesses (Business Rules
 * #3/#4): a stale anchor's offsets are not consulted.
 */
export function currentSpanText(
    finding: {
        readonly anchor: Anchor | null
        readonly anchoredText: string | null
        readonly quote: string
    },
    currentText: string
): string {
    const anchor = finding.anchor
    if (
        anchor !== null &&
        anchor.state === 'anchored' &&
        anchor.from <= anchor.to &&
        anchor.to <= currentText.length
    ) {
        return currentText.slice(anchor.from, anchor.to)
    }
    return finding.anchoredText ?? finding.quote
}
