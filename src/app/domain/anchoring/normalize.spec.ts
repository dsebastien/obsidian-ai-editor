import { describe, expect, it } from 'bun:test'
import { normalizeForMatching, projectToSource } from './normalize'

describe('normalizeForMatching', () => {
    it('lowercases text', () => {
        expect(normalizeForMatching('Hello World').text).toEqual('hello world')
    })

    it('folds smart quotes to ASCII', () => {
        expect(normalizeForMatching('“Hello” ‘world’').text).toEqual('"hello" \'world\'')
    })

    it('folds dashes and ellipsis', () => {
        expect(normalizeForMatching('a – b — c…').text).toEqual('a - b - c...')
    })

    it('collapses whitespace runs including newlines', () => {
        expect(normalizeForMatching('a  b\n\nc\td').text).toEqual('a b c d')
    })

    it('drops leading and trailing whitespace', () => {
        expect(normalizeForMatching('  hello  ').text).toEqual('hello')
    })

    it('maps non-breaking spaces to plain spaces', () => {
        expect(normalizeForMatching('a b').text).toEqual('a b')
    })

    it('keeps a source offset for every produced character', () => {
        const normalized = normalizeForMatching('A  “B”')
        expect(normalized.sourceOffsets.length).toEqual(normalized.text.length)
    })

    it('produces monotonically non-decreasing source offsets', () => {
        const normalized = normalizeForMatching('Hé…  “ok”\n\nDone')
        const offsets = [...normalized.sourceOffsets]
        for (let i = 1; i < offsets.length; i++) {
            expect(offsets[i]).toBeGreaterThanOrEqual(offsets[i - 1] ?? 0)
        }
    })

    it('expands multi-character folds (ellipsis) with repeated offsets', () => {
        const normalized = normalizeForMatching('a…b')
        expect(normalized.text).toEqual('a...b')
        expect(normalized.sourceOffsets).toEqual([0, 1, 1, 1, 2])
    })
})

describe('projectToSource', () => {
    it('projects a normalized range back onto the source', () => {
        const source = 'The  “Quick”  Fox'
        const normalized = normalizeForMatching(source)
        const index = normalized.text.indexOf('"quick"')
        expect(index).toBeGreaterThanOrEqual(0)
        const range = projectToSource(normalized, index, index + '"quick"'.length)
        expect(range).not.toBeNull()
        expect(source.slice(range!.from, range!.to)).toEqual('“Quick”')
    })

    it('returns null for an empty range', () => {
        const normalized = normalizeForMatching('abc')
        expect(projectToSource(normalized, 1, 1)).toBeNull()
    })

    it('returns null for out-of-bounds ranges', () => {
        const normalized = normalizeForMatching('abc')
        expect(projectToSource(normalized, -1, 2)).toBeNull()
        expect(projectToSource(normalized, 0, 99)).toBeNull()
    })

    it('round-trips a range through whitespace collapsing', () => {
        const source = 'one\n\ntwo   three'
        const normalized = normalizeForMatching(source)
        const index = normalized.text.indexOf('two three')
        const range = projectToSource(normalized, index, index + 'two three'.length)
        expect(source.slice(range!.from, range!.to)).toEqual('two   three')
    })
})
