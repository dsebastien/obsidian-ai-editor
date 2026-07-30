import { describe, expect, it } from 'bun:test'
import { matchQuote } from '../anchoring/match'
import { commentInstruction } from './comment-prompt'
import { spanHints } from './span-hints'

describe('spanHints', () => {
    it('captures the quote with context on both sides', () => {
        const text = 'Intro paragraph. The claim under review. Closing words.'
        const hints = spanHints(text, 17, 40)
        expect(hints?.quote).toEqual('The claim under review.')
        expect(hints?.prefix).toEqual('Intro paragraph. ')
        expect(hints?.suffix).toEqual(' Closing words.')
        expect(hints?.occurrence).toEqual(0)
    })

    it('records the occurrence index even when the quote is unique today', () => {
        const hints = spanHints('only once here', 0, 4)
        expect(hints?.occurrence).toEqual(0)
    })

    it('indexes the right occurrence of a repeated quote', () => {
        const text = 'ping. ping. ping.'
        expect(spanHints(text, 0, 4)?.occurrence).toEqual(0)
        expect(spanHints(text, 6, 10)?.occurrence).toEqual(1)
        expect(spanHints(text, 12, 16)?.occurrence).toEqual(2)
    })

    it('counts overlapping occurrences the way the matcher enumerates them', () => {
        // 'aa' occurs at 0, 1, 2 in 'aaaa' — the matcher advances by one char.
        expect(spanHints('aaaa', 2, 4)?.occurrence).toEqual(2)
    })

    it('clips the context at the note boundaries', () => {
        const text = 'abc'
        const hints = spanHints(text, 1, 2)
        expect(hints?.prefix).toEqual('a')
        expect(hints?.suffix).toEqual('c')
    })

    it('refuses a degenerate or out-of-bounds range instead of inventing a span', () => {
        const text = 'some text'
        expect(spanHints(text, 3, 3)).toBeNull()
        expect(spanHints(text, 5, 2)).toBeNull()
        expect(spanHints(text, -1, 4)).toBeNull()
        expect(spanHints(text, 0, text.length + 1)).toBeNull()
        expect(spanHints(text, 0.5, 4)).toBeNull()
    })
})

describe('spanHints round trip', () => {
    const roundTrip = (text: string, from: number, to: number): void => {
        const hints = spanHints(text, from, to)
        expect(hints).not.toBeNull()
        if (!hints) {
            return
        }
        const match = matchQuote(text, hints.quote, {
            prefix: hints.prefix,
            suffix: hints.suffix,
            occurrence: hints.occurrence
        })
        expect(match.status).toEqual('matched')
        if (match.status === 'matched') {
            expect(match.match.from).toEqual(from)
            expect(match.match.to).toEqual(to)
            expect(match.match.strategy).toEqual('exact')
        }
    }

    it('re-anchors a unique span to itself', () => {
        roundTrip('Intro paragraph. The claim under review. Closing words.', 17, 40)
    })

    it('re-anchors each occurrence of a repeated span to itself', () => {
        const text = 'ping. ping. ping.'
        roundTrip(text, 0, 4)
        roundTrip(text, 6, 10)
        roundTrip(text, 12, 16)
    })

    it('re-anchors a span at the very start and the very end of the note', () => {
        const text = 'Alpha beta gamma'
        roundTrip(text, 0, 5)
        roundTrip(text, 11, 16)
    })

    it('re-anchors a self-overlapping span', () => {
        roundTrip('aaaa', 2, 4)
    })
})

describe('commentInstruction', () => {
    it('quotes the span verbatim and states the question', () => {
        const text = commentInstruction({
            quote: 'The claim under review.',
            instruction: '  Is this supported?  '
        })
        expect(text).toContain('The claim under review.')
        expect(text).toContain('Their question: Is this supported?')
    })

    it('scopes the answer to the span and allows a note-level reply', () => {
        const text = commentInstruction({ quote: 'x', instruction: 'y' })
        expect(text).toContain('Answer only about that span.')
        // Never manufacture a finding just to have something to return.
        expect(text).toContain('summary')
        // Verbatim quoting is what makes the answer re-anchorable later.
        expect(text).toContain('verbatim')
    })

    it('clips an over-long span rather than blowing the instruction budget', () => {
        const text = commentInstruction({ quote: 'x'.repeat(5_000), instruction: 'why?' })
        expect(text).toContain('…')
        expect(text.length).toBeLessThan(2_400)
    })
})
