import { describe, expect, it } from 'bun:test'
import { matchQuote } from './match'

const DOC = [
    '# Docker outages',
    '',
    'Your CI pipeline has a dependency you don’t own and can’t fix: Docker Hub.',
    'When it’s down, rate-limited, or having a bad day, your builds fail.',
    '',
    'Every docker pull in your pipeline is a live network call.',
    'A paid plan raises the pull ceiling, but it doesn’t change what’s serving the pulls.'
].join('\n')

describe('matchQuote — exact matching', () => {
    it('finds a unique verbatim quote', () => {
        const result = matchQuote(DOC, 'rate-limited, or having a bad day')
        expect(result.status).toEqual('matched')
        if (result.status === 'matched') {
            expect(DOC.slice(result.match.from, result.match.to)).toEqual(
                'rate-limited, or having a bad day'
            )
            expect(result.match.strategy).toEqual('exact')
        }
    })

    it('reports not-found for absent text', () => {
        expect(matchQuote(DOC, 'kubernetes operators').status).toEqual('not-found')
    })

    it('reports not-found for an empty quote', () => {
        expect(matchQuote(DOC, '').status).toEqual('not-found')
    })

    it('flags multiple occurrences without hints as ambiguous', () => {
        const result = matchQuote(DOC, 'pipeline')
        expect(result.status).toEqual('ambiguous')
        if (result.status === 'ambiguous') {
            expect(result.candidates.length).toBeGreaterThan(1)
        }
    })

    it('disambiguates multiple occurrences via prefix hint', () => {
        const result = matchQuote(DOC, 'pipeline', { prefix: 'in your' })
        expect(result.status).toEqual('matched')
        if (result.status === 'matched') {
            const before = DOC.slice(Math.max(0, result.match.from - 8), result.match.from)
            expect(before).toContain('your')
            expect(DOC.slice(result.match.from, result.match.to)).toEqual('pipeline')
        }
    })

    it('disambiguates multiple occurrences via suffix hint', () => {
        const result = matchQuote(DOC, 'pipeline', { suffix: 'has a dependency' })
        expect(result.status).toEqual('matched')
        if (result.status === 'matched') {
            const after = DOC.slice(result.match.to, result.match.to + 20)
            expect(after).toContain('has a dependency')
        }
    })

    it('disambiguates via occurrence index', () => {
        const first = matchQuote(DOC, 'pipeline', { occurrence: 0 })
        const second = matchQuote(DOC, 'pipeline', { occurrence: 1 })
        expect(first.status).toEqual('matched')
        expect(second.status).toEqual('matched')
        if (first.status === 'matched' && second.status === 'matched') {
            expect(second.match.from).toBeGreaterThan(first.match.from)
        }
    })

    it('stays ambiguous when the occurrence index is out of range', () => {
        expect(matchQuote(DOC, 'pipeline', { occurrence: 99 }).status).toEqual('ambiguous')
    })
})

describe('matchQuote — occurrence indexes ALL document occurrences', () => {
    // 'foo' occurs at offsets 2, 8, 14; prefix 'x ' matches occurrences 0 and 2.
    const REPEATED = 'x foo y foo x foo'

    it('resolves occurrence against the full occurrence list, never a hint-filtered pool', () => {
        const result = matchQuote(REPEATED, 'foo', { occurrence: 1 })
        expect(result.status).toEqual('matched')
        if (result.status === 'matched') {
            expect(result.match.from).toEqual(8)
        }
    })

    it('accepts a consistent prefix + occurrence combination', () => {
        const result = matchQuote(REPEATED, 'foo', { prefix: 'x ', occurrence: 2 })
        expect(result.status).toEqual('matched')
        if (result.status === 'matched') {
            expect(result.match.from).toEqual(14)
        }
    })

    it('stays ambiguous when occurrence and hints disagree (internally inconsistent)', () => {
        // Occurrence 1 is preceded by 'y ', not 'x ' — never anchor on a guess.
        expect(matchQuote(REPEATED, 'foo', { prefix: 'x ', occurrence: 1 }).status).toEqual(
            'ambiguous'
        )
    })

    it('anchors a unique quote even when the hints are inconsistent', () => {
        const result = matchQuote(REPEATED, 'y foo', { occurrence: 5 })
        expect(result.status).toEqual('matched')
    })
})

describe('matchQuote — normalized matching', () => {
    it('matches straight quotes against curly source apostrophes', () => {
        const result = matchQuote(DOC, "you don't own and can't fix")
        expect(result.status).toEqual('matched')
        if (result.status === 'matched') {
            expect(result.match.strategy).toEqual('normalized')
            expect(DOC.slice(result.match.from, result.match.to)).toEqual(
                'you don’t own and can’t fix'
            )
        }
    })

    it('matches across case drift', () => {
        const result = matchQuote(DOC, 'DOCKER HUB.')
        expect(result.status).toEqual('matched')
        if (result.status === 'matched') {
            expect(DOC.slice(result.match.from, result.match.to)).toEqual('Docker Hub.')
        }
    })

    it('matches across collapsed whitespace and newlines', () => {
        const quote = 'your builds fail. Every docker pull'
        const result = matchQuote(DOC, quote)
        expect(result.status).toEqual('matched')
        if (result.status === 'matched') {
            const matched = DOC.slice(result.match.from, result.match.to)
            expect(matched.startsWith('your builds fail.')).toBeTrue()
            expect(matched.endsWith('Every docker pull')).toBeTrue()
        }
    })

    it('never invents a match when normalization also fails', () => {
        expect(matchQuote(DOC, 'entirely absent words').status).toEqual('not-found')
    })
})
