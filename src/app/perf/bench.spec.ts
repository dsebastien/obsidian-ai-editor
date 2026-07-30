import { describe, expect, test } from 'bun:test'

import { bench, benchQuotes, buildBenchNote, formatBenchResult, seededRandom } from './bench'

describe('seededRandom', () => {
    test('is deterministic for a seed', () => {
        const left = seededRandom(42)
        const right = seededRandom(42)
        expect([left(), left(), left()]).toEqual([right(), right(), right()])
    })

    test('differs across seeds', () => {
        expect(seededRandom(1)()).not.toBe(seededRandom(2)())
    })

    test('stays in [0, 1)', () => {
        const random = seededRandom(9)
        for (let index = 0; index < 200; index += 1) {
            const value = random()
            expect(value).toBeGreaterThanOrEqual(0)
            expect(value).toBeLessThan(1)
        }
    })
})

describe('buildBenchNote', () => {
    test('reaches the requested size', () => {
        expect(buildBenchNote(5_000).length).toBeGreaterThanOrEqual(5_000)
    })

    test('is reproducible', () => {
        expect(buildBenchNote(5_000)).toBe(buildBenchNote(5_000))
    })

    test('differs by seed', () => {
        expect(buildBenchNote(5_000, 1)).not.toBe(buildBenchNote(5_000, 2))
    })
})

describe('benchQuotes', () => {
    const text = buildBenchNote(20_000)

    test('draws the requested number of in-bounds spans', () => {
        const quotes = benchQuotes(text, 25)
        expect(quotes).toHaveLength(25)
        for (const quote of quotes) {
            expect(quote.to).toBeLessThanOrEqual(text.length)
            expect(text.slice(quote.from, quote.to)).toBe(quote.quote)
        }
    })

    test('carries the hints that surround each span', () => {
        for (const quote of benchQuotes(text, 10)) {
            expect(text.slice(quote.from - quote.prefix.length, quote.from)).toBe(quote.prefix)
            expect(text.slice(quote.to, quote.to + quote.suffix.length)).toBe(quote.suffix)
        }
    })

    test('spreads the spans across the text', () => {
        const quotes = benchQuotes(text, 10)
        const firstFrom = quotes[0]?.from ?? 0
        const lastFrom = quotes[quotes.length - 1]?.from ?? 0
        expect(lastFrom).toBeGreaterThan(firstFrom + text.length / 4)
    })

    test('quotes are unique enough to anchor (numbered sentences)', () => {
        for (const quote of benchQuotes(text, 20)) {
            expect(text.indexOf(quote.quote)).toBe(text.lastIndexOf(quote.quote))
        }
    })
})

describe('bench', () => {
    test('runs the body once per run plus a warm-up, and reports timings', () => {
        let calls = 0
        const result = bench('unit', () => {
            calls += 1
        })
        expect(calls).toBe(4) // 1 warm-up + 3 timed
        expect(result.label).toBe('unit')
        expect(result.minMs).toBeLessThanOrEqual(result.medianMs)
        expect(result.medianMs).toBeLessThanOrEqual(result.maxMs)
    })
})

describe('formatBenchResult', () => {
    test('names the measurement and its three numbers', () => {
        const line = formatBenchResult({ label: 'thing', medianMs: 1.5, minMs: 1, maxMs: 2 })
        expect(line).toContain('thing')
        expect(line).toContain('1.50')
        expect(line).toContain('1.00')
        expect(line).toContain('2.00')
    })
})
