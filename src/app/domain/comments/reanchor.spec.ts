import { describe, expect, it } from 'bun:test'
import { marginCommentSchema } from './margin-comment'
import type { MarginComment } from './margin-comment'
import { isAnchored, reanchorComment, reanchorComments, tallyAnchorOutcomes } from './reanchor'

function comment(overrides: Partial<MarginComment> = {}): MarginComment {
    return marginCommentSchema.parse({
        id: 'c1',
        quote: 'the quick brown fox',
        instruction: 'Too cliché?',
        editorId: 'editor-1',
        status: 'done',
        createdAt: 1,
        updatedAt: 2,
        ...overrides
    })
}

describe('reanchorComment', () => {
    it('anchors an untouched quote exactly', () => {
        const text = 'Before. the quick brown fox jumps. After.'
        const result = reanchorComment(text, comment())
        expect(result.outcome).toEqual('exact')
        expect(result.anchor).toEqual({ from: 8, to: 27, state: 'anchored' })
        expect(result.anchoredText).toEqual('the quick brown fox')
    })

    it('follows the span after an edit made while Obsidian was closed', () => {
        const text = 'A whole new opening paragraph.\n\nthe quick brown fox jumps.'
        const result = reanchorComment(text, comment())
        expect(result.outcome).toEqual('exact')
        expect(text.slice(result.anchor?.from ?? 0, result.anchor?.to ?? 0)).toEqual(
            'the quick brown fox'
        )
    })

    it('reports a typographically drifted quote as fuzzy, anchored to the SOURCE text', () => {
        // Smart quotes + a collapsed whitespace run: normalized match.
        const text = 'He said “the  quick brown fox” loudly.'
        const result = reanchorComment(text, comment({ quote: 'the quick brown fox' }))
        expect(result.outcome).toEqual('fuzzy')
        expect(result.anchoredText).toEqual('the  quick brown fox')
        expect(text.slice(result.anchor?.from ?? 0, result.anchor?.to ?? 0)).toEqual(
            'the  quick brown fox'
        )
    })

    it('orphans a quote the note no longer contains — and keeps the comment', () => {
        const result = reanchorComment('Nothing like it here.', comment())
        expect(result.outcome).toEqual('orphaned')
        expect(result.anchor).toBeNull()
        expect(result.anchoredText).toBeNull()
        expect(result.comment.quote).toEqual('the quick brown fox')
        expect(result.comment.instruction).toEqual('Too cliché?')
    })

    it('orphans an ambiguous quote rather than guessing an occurrence', () => {
        const text = 'fox here and fox there'
        expect(reanchorComment(text, comment({ quote: 'fox' })).outcome).toEqual('orphaned')
    })

    it('uses the stored occurrence index to disambiguate', () => {
        const text = 'fox here and fox there'
        const result = reanchorComment(text, comment({ quote: 'fox', occurrence: 1 }))
        expect(result.outcome).toEqual('exact')
        expect(result.anchor?.from).toEqual(13)
    })

    it('uses the stored prefix/suffix hints to disambiguate', () => {
        const text = 'fox here and fox there'
        const result = reanchorComment(text, comment({ quote: 'fox', suffix: ' there' }))
        expect(result.outcome).toEqual('exact')
        expect(result.anchor?.from).toEqual(13)
    })

    it('orphans everything against an empty note', () => {
        expect(reanchorComment('', comment()).outcome).toEqual('orphaned')
    })
})

describe('reanchorComments', () => {
    it('resolves each comment independently and preserves stored order', () => {
        const text = 'alpha and omega'
        const results = reanchorComments(text, [
            comment({ id: 'a', quote: 'omega' }),
            comment({ id: 'b', quote: 'gone' }),
            comment({ id: 'c', quote: 'alpha' })
        ])
        expect(results.map((entry) => entry.comment.id)).toEqual(['a', 'b', 'c'])
        expect(results.map((entry) => entry.outcome)).toEqual(['exact', 'orphaned', 'exact'])
    })

    it('tallies the outcomes for the margin summary line', () => {
        const text = 'alpha and “omega  bar”'
        const results = reanchorComments(text, [
            comment({ id: 'a', quote: 'alpha' }),
            comment({ id: 'b', quote: 'omega bar' }),
            comment({ id: 'c', quote: 'nowhere' })
        ])
        expect(tallyAnchorOutcomes(results)).toEqual({ exact: 1, fuzzy: 1, orphaned: 1 })
    })
})

describe('isAnchored', () => {
    it('treats exact and fuzzy as placed, orphaned as not', () => {
        expect(isAnchored('exact')).toBe(true)
        expect(isAnchored('fuzzy')).toBe(true)
        expect(isAnchored('orphaned')).toBe(false)
    })
})
