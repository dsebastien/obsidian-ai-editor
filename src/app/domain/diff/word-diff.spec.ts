import { describe, expect, it } from 'bun:test'
import { LCS_TOKEN_BUDGET, tokenizeWords, wordDiff } from './word-diff'
import type { DiffSegment } from './word-diff'

function oldTextOf(segments: readonly DiffSegment[]): string {
    return segments
        .filter((segment) => segment.kind !== 'ins')
        .map((segment) => segment.text)
        .join('')
}

function newTextOf(segments: readonly DiffSegment[]): string {
    return segments
        .filter((segment) => segment.kind !== 'del')
        .map((segment) => segment.text)
        .join('')
}

/** Asserts the spec-pinned structural invariants for one diff result. */
function expectInvariants(oldText: string, newText: string): readonly DiffSegment[] {
    const segments = wordDiff(oldText, newText)
    expect(oldTextOf(segments)).toBe(oldText)
    expect(newTextOf(segments)).toBe(newText)
    for (const [index, segment] of segments.entries()) {
        expect(segment.text.length).toBeGreaterThan(0)
        if (index > 0) {
            expect(segment.kind).not.toBe((segments[index - 1] as DiffSegment).kind)
        }
    }
    // Red before green: an ins is never immediately followed by a del (every
    // change region emits del first, and regions are separated by same).
    for (let index = 1; index < segments.length; index += 1) {
        const previous = segments[index - 1] as DiffSegment
        const current = segments[index] as DiffSegment
        expect(previous.kind === 'ins' && current.kind === 'del').toBe(false)
    }
    return segments
}

/** Tiny deterministic PRNG (mulberry32) for the property sweep. */
function prng(seed: number): () => number {
    let state = seed
    return () => {
        state = (state + 0x6d2b79f5) | 0
        let t = Math.imul(state ^ (state >>> 15), 1 | state)
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
}

describe('tokenizeWords', () => {
    it('returns an empty list for the empty string', () => {
        expect(tokenizeWords('')).toEqual([])
    })

    it('splits into alternating word and whitespace runs, loss-free', () => {
        const text = '  hello \t world\n\nnext '
        const tokens = tokenizeWords(text)
        expect(tokens).toEqual(['  ', 'hello', ' \t ', 'world', '\n\n', 'next', ' '])
        expect(tokens.join('')).toBe(text)
    })

    it('keeps emoji and combining marks inside one token', () => {
        expect(tokenizeWords('a👩‍👩‍👧‍👧b été')).toEqual(['a👩‍👩‍👧‍👧b', ' ', 'été'])
    })
})

describe('wordDiff', () => {
    it('returns no segments for two empty texts', () => {
        expect(wordDiff('', '')).toEqual([])
    })

    it('returns one same segment for identical texts', () => {
        expect(wordDiff('same text here', 'same text here')).toEqual([
            { kind: 'same', text: 'same text here' }
        ])
    })

    it('returns a single ins segment when the old text is empty', () => {
        expect(wordDiff('', 'brand new text')).toEqual([{ kind: 'ins', text: 'brand new text' }])
    })

    it('returns a single del segment when the new text is empty', () => {
        expect(wordDiff('all gone', '')).toEqual([{ kind: 'del', text: 'all gone' }])
    })

    it('diffs a one-word replacement in the middle', () => {
        expect(wordDiff('the quick brown fox', 'the slow brown fox')).toEqual([
            { kind: 'same', text: 'the ' },
            { kind: 'del', text: 'quick' },
            { kind: 'ins', text: 'slow' },
            { kind: 'same', text: ' brown fox' }
        ])
    })

    it('emits del before ins in every change region', () => {
        const segments = wordDiff('alpha beta gamma', 'alpha delta gamma')
        expect(segments.map((segment) => segment.kind)).toEqual(['same', 'del', 'ins', 'same'])
    })

    it('diffs an insertion-only change', () => {
        expect(wordDiff('one three', 'one two three')).toEqual([
            { kind: 'same', text: 'one ' },
            { kind: 'ins', text: 'two ' },
            { kind: 'same', text: 'three' }
        ])
    })

    it('diffs a deletion-only change', () => {
        expect(wordDiff('one two three', 'one three')).toEqual([
            { kind: 'same', text: 'one ' },
            { kind: 'del', text: 'two ' },
            { kind: 'same', text: 'three' }
        ])
    })

    it('handles a fully changed text as one del + one ins', () => {
        expect(wordDiff('aaa bbb ccc', 'xxx yyy zzz')).toEqual([
            { kind: 'del', text: 'aaa bbb ccc' },
            { kind: 'ins', text: 'xxx yyy zzz' }
        ])
    })

    it('folds whitespace between two replacements into one block (display cleanup)', () => {
        // Both regions are del+ins pairs → the space joins them, and shows
        // up in BOTH the del and the ins segment (reconstruction holds).
        const segments = expectInvariants('aaa bbb', 'xxx yyy')
        expect(segments).toEqual([
            { kind: 'del', text: 'aaa bbb' },
            { kind: 'ins', text: 'xxx yyy' }
        ])
    })

    it('does not fold whitespace next to a pure insertion or deletion', () => {
        // 'two' is deleted with no counterpart: the surrounding whitespace
        // stays a same segment instead of being struck through.
        expect(wordDiff('one two three', 'one three')).toEqual([
            { kind: 'same', text: 'one ' },
            { kind: 'del', text: 'two ' },
            { kind: 'same', text: 'three' }
        ])
    })

    it('treats a pure whitespace change as a change, never normalizing it', () => {
        const segments = expectInvariants('one two', 'one\ntwo')
        expect(segments.some((segment) => segment.kind === 'del')).toBe(true)
        expect(segments.some((segment) => segment.kind === 'ins')).toBe(true)
    })

    it('preserves newlines and multi-space runs verbatim', () => {
        expectInvariants('line one\n\nline  two\ttabbed', 'line one\n\nline two\ttabbed end')
    })

    it('preserves leading and trailing whitespace', () => {
        expectInvariants('  padded start', '  padded end  ')
    })

    it('handles unicode words (emoji, CJK, combining marks)', () => {
        const segments = expectInvariants('café 東京 👍 fin', 'café 大阪 👍 fin')
        expect(segments).toEqual([
            { kind: 'same', text: 'café ' },
            { kind: 'del', text: '東京' },
            { kind: 'ins', text: '大阪' },
            { kind: 'same', text: ' 👍 fin' }
        ])
    })

    it('handles markdown punctuation as part of word tokens', () => {
        expectInvariants('a [[link]] and *emphasis*', 'a [[link]] and **strong**')
    })

    it('handles the old text being a prefix of the new text', () => {
        expect(wordDiff('start', 'start and more')).toEqual([
            { kind: 'same', text: 'start' },
            { kind: 'ins', text: ' and more' }
        ])
    })

    it('handles the new text being a suffix of the old text', () => {
        expect(wordDiff('drop this ending', 'ending')).toEqual([
            { kind: 'del', text: 'drop this ' },
            { kind: 'same', text: 'ending' }
        ])
    })

    it('handles repeated words deterministically', () => {
        // Same input → same output, and invariants hold despite ambiguity.
        const first = expectInvariants('a a a b a', 'a b a a')
        const second = wordDiff('a a a b a', 'a b a a')
        expect(second).toEqual([...first])
    })

    it('handles single-character texts', () => {
        expect(wordDiff('a', 'b')).toEqual([
            { kind: 'del', text: 'a' },
            { kind: 'ins', text: 'b' }
        ])
    })

    it('handles whitespace-only texts', () => {
        expectInvariants('   ', '\n\n')
        expectInvariants(' ', ' ')
    })

    it('diffs multi-paragraph rewrites while keeping shared paragraphs', () => {
        const oldText = 'Intro paragraph.\n\nMiddle stays the same.\n\nOld conclusion here.'
        const newText = 'Intro paragraph.\n\nMiddle stays the same.\n\nNew, better ending.'
        const segments = expectInvariants(oldText, newText)
        const sameText = segments
            .filter((segment) => segment.kind === 'same')
            .map((segment) => segment.text)
            .join('')
        expect(sameText).toContain('Middle stays the same.')
    })

    it('falls back to a coarse replacement above the token budget (still loss-free)', () => {
        // ~2100 distinct tokens per side (words + separators) after trimming:
        // product exceeds the 4M budget, so the middle degrades to del+ins.
        const oldText = `same-head ${Array.from({ length: 1_050 }, (_, i) => `old${i}`).join(' ')} same-tail`
        const newText = `same-head ${Array.from({ length: 1_050 }, (_, i) => `new${i}`).join(' ')} same-tail`
        const oldMiddleTokens = 1_050 * 2 - 1
        expect(oldMiddleTokens * oldMiddleTokens).toBeGreaterThan(LCS_TOKEN_BUDGET)
        const segments = expectInvariants(oldText, newText)
        expect(segments.map((segment) => segment.kind)).toEqual(['same', 'del', 'ins', 'same'])
    })

    it('trims common prefix and suffix so the LCS only sees the middle', () => {
        // A large shared prefix/suffix with a tiny middle change must not
        // trip the budget fallback: the changed region stays word-level.
        const shared = Array.from({ length: 3_000 }, (_, i) => `w${i}`).join(' ')
        const segments = expectInvariants(
            `${shared} CHANGE-ME ${shared}`,
            `${shared} CHANGED ${shared}`
        )
        expect(segments).toEqual([
            { kind: 'same', text: `${shared} ` },
            { kind: 'del', text: 'CHANGE-ME' },
            { kind: 'ins', text: 'CHANGED' },
            { kind: 'same', text: ` ${shared}` }
        ])
    })

    it('property sweep: invariants hold across random word soups', () => {
        const random = prng(0xa11ce)
        const vocabulary = ['alpha', 'beta', 'gamma', 'delta', '東京', '👍', 'x']
        const separators = [' ', '  ', '\n', '\n\n', '\t']
        const build = (length: number): string => {
            let text = ''
            for (let index = 0; index < length; index += 1) {
                text += vocabulary[Math.floor(random() * vocabulary.length)] as string
                text += separators[Math.floor(random() * separators.length)] as string
            }
            return text
        }
        for (let round = 0; round < 60; round += 1) {
            expectInvariants(build(Math.floor(random() * 40)), build(Math.floor(random() * 40)))
        }
    })
})
