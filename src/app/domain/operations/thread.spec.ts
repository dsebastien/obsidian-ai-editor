import { describe, expect, it } from 'bun:test'
import { createAnchor } from '../anchoring/anchor'
import type { ThreadTurnResult } from './contract'
import { threadTurnResultSchema } from './contract'
import {
    completedThreadTurns,
    currentSpanText,
    isThreadFull,
    resolveThreadOutcome,
    THREAD_MAX_TURNS,
    threadTurnsLeft,
    type ThreadMessage
} from './thread'

function exchanges(count: number): ThreadMessage[] {
    const thread: ThreadMessage[] = []
    for (let index = 0; index < count; index++) {
        thread.push({ role: 'user', content: `push ${index}` })
        thread.push({ role: 'editor', content: `reply ${index}` })
    }
    return thread
}

function result(overrides: Partial<ThreadTurnResult> = {}): ThreadTurnResult {
    return threadTurnResultSchema.parse({
        kind: 'thread-turn',
        reply: 'Fair point, but the repetition still reads as an accident.',
        ...overrides
    })
}

describe('thread cap helpers', () => {
    it('counts completed exchanges, not messages', () => {
        expect(completedThreadTurns([])).toEqual(0)
        expect(completedThreadTurns(exchanges(3))).toEqual(3)
    })

    it('reports the thread full at the cap and never negative room', () => {
        expect(isThreadFull([])).toBe(false)
        expect(threadTurnsLeft([])).toEqual(THREAD_MAX_TURNS)
        expect(isThreadFull(exchanges(THREAD_MAX_TURNS - 1))).toBe(false)
        expect(isThreadFull(exchanges(THREAD_MAX_TURNS))).toBe(true)
        expect(threadTurnsLeft(exchanges(THREAD_MAX_TURNS))).toEqual(0)
        expect(threadTurnsLeft(exchanges(THREAD_MAX_TURNS + 2))).toEqual(0)
    })
})

describe('resolveThreadOutcome', () => {
    it('reads a plain hold with no revision', () => {
        expect(resolveThreadOutcome(result())).toEqual({
            kind: 'hold',
            reply: 'Fair point, but the repetition still reads as an accident.',
            revisedCritique: null,
            revisedSuggestion: null
        })
    })

    it('carries revisions and trims the reply', () => {
        const outcome = resolveThreadOutcome(
            result({
                reply: '  Sharpened.  ',
                revisedCritique: '  The repetition buries the verb.  ',
                revisedSuggestion: '  swift auburn fox  '
            })
        )
        expect(outcome).toEqual({
            kind: 'hold',
            reply: 'Sharpened.',
            revisedCritique: 'The repetition buries the verb.',
            revisedSuggestion: 'swift auburn fox'
        })
    })

    it('treats blank revisions as absent', () => {
        const outcome = resolveThreadOutcome(
            result({ revisedCritique: '   ', revisedSuggestion: '' })
        )
        expect(outcome).toEqual({
            kind: 'hold',
            reply: 'Fair point, but the repetition still reads as an accident.',
            revisedCritique: null,
            revisedSuggestion: null
        })
    })

    it('concedes, ignoring any revision sent alongside', () => {
        const outcome = resolveThreadOutcome(
            result({
                concede: true,
                reply: 'You are right, the repetition is deliberate.',
                revisedSuggestion: 'something else'
            })
        )
        expect(outcome).toEqual({
            kind: 'concede',
            reply: 'You are right, the repetition is deliberate.'
        })
    })

    it('defaults concede to false when the backend omits it', () => {
        const parsed = threadTurnResultSchema.parse({ kind: 'thread-turn', reply: 'Holding.' })
        expect(parsed.concede).toBe(false)
        expect(resolveThreadOutcome(parsed).kind).toEqual('hold')
    })

    it('rejects an empty reply at the contract boundary', () => {
        expect(threadTurnResultSchema.safeParse({ kind: 'thread-turn', reply: '' }).success).toBe(
            false
        )
    })
})

describe('currentSpanText', () => {
    const doc = 'The quick brown fox jumps over the lazy dog'

    it('reads the live text of an anchored span', () => {
        expect(
            currentSpanText(
                { anchor: createAnchor(4, 15), anchoredText: 'quick brown', quote: 'quick brown' },
                doc
            )
        ).toEqual('quick brown')
    })

    it('follows the anchor after the span text changed in place', () => {
        // Same offsets, edited content: the thread must discuss what is there
        // NOW, not what the review saw.
        const edited = 'The QUICK BROWN fox jumps over the lazy dog'
        expect(
            currentSpanText(
                { anchor: createAnchor(4, 15), anchoredText: 'quick brown', quote: 'quick brown' },
                edited
            )
        ).toEqual('QUICK BROWN')
    })

    it('falls back to the anchored text for a stale anchor', () => {
        expect(
            currentSpanText(
                {
                    anchor: { from: 4, to: 15, state: 'stale' },
                    anchoredText: 'quick brown',
                    quote: 'quick  brown'
                },
                doc
            )
        ).toEqual('quick brown')
    })

    it('falls back to the raw quote when unanchored', () => {
        expect(
            currentSpanText({ anchor: null, anchoredText: null, quote: 'quick brown' }, doc)
        ).toEqual('quick brown')
    })

    it('never reads out of bounds', () => {
        expect(
            currentSpanText(
                { anchor: createAnchor(4, 999), anchoredText: 'quick brown', quote: 'q' },
                doc
            )
        ).toEqual('quick brown')
    })
})
