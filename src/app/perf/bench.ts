/**
 * Benchmark harness and fixtures for the performance suite (plan M9,
 * "performance passes — large notes, many findings").
 *
 * Why this exists at all: every performance claim in `documentation/` is
 * supposed to be a MEASURED number, not an intuition. The suite in
 * `perf.bench.spec.ts` runs under `bun test` like everything else, prints what
 * it measured, and asserts a CEILING rather than a target — a benchmark that
 * asserts a tight number is a flaky test on someone else's laptop, and a
 * benchmark that asserts nothing is a comment.
 *
 * Run the performance suite alone:
 *
 * ```bash
 * bun test perf.bench
 * ```
 *
 * The fixtures are deterministic (a seeded LCG, no `Math.random`): two runs of
 * the same benchmark measure the same work, so a number that moves means the
 * CODE moved. They are also cheap to build relative to what they measure —
 * building is never inside the measured region.
 */

/** Deterministic 32-bit LCG. Seeded, so every fixture is reproducible. */
export function seededRandom(seed: number): () => number {
    let state = seed >>> 0
    return () => {
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0
        return state / 0x1_0000_0000
    }
}

const FIXTURE_WORDS = [
    'knowledge',
    'system',
    'note',
    'vault',
    'editor',
    'review',
    'context',
    'anchor',
    'prose',
    'signal',
    'draft',
    'thought',
    'idea',
    'method',
    'plugin',
    'writing',
    'clarity',
    'quote',
    'finding',
    'sentence'
] as const

/**
 * Builds a deterministic prose fixture of at least `chars` characters:
 * numbered sentences of 8-20 words, grouped into paragraphs. Numbering the
 * sentences keeps most spans UNIQUE, which is what makes a quote drawn from
 * the fixture anchor the way a real one does (a fixture of repeated filler
 * would exercise the ambiguity path on every quote and measure the wrong
 * thing).
 */
export function buildBenchNote(chars: number, seed = 7): string {
    const random = seededRandom(seed)
    const parts: string[] = []
    let length = 0
    let index = 0
    while (length < chars) {
        const wordCount = 8 + Math.floor(random() * 12)
        const words: string[] = []
        for (let i = 0; i < wordCount; i += 1) {
            words.push(FIXTURE_WORDS[Math.floor(random() * FIXTURE_WORDS.length)] as string)
        }
        const sentence = `${words.join(' ')} ${index}.`
        parts.push(sentence)
        length += sentence.length + 1
        index += 1
        parts.push(index % 6 === 0 ? '\n\n' : ' ')
    }
    return parts.join('')
}

/** A quote drawn from a fixture, with the hints a backend would send. */
export interface BenchQuote {
    readonly quote: string
    readonly prefix: string
    readonly suffix: string
    readonly from: number
    readonly to: number
}

/**
 * Draws `count` evenly-spread spans of `length` characters from `text`, each
 * with the 40-character prefix/suffix hints the operation contract uses.
 */
export function benchQuotes(text: string, count: number, length = 60): BenchQuote[] {
    const quotes: BenchQuote[] = []
    const stride = Math.max(1, Math.floor(text.length / (count + 2)))
    for (let index = 0; index < count; index += 1) {
        const from = Math.min(text.length - length - 1, stride * index + 13)
        const to = from + length
        quotes.push({
            quote: text.slice(from, to),
            prefix: text.slice(Math.max(0, from - 40), from),
            suffix: text.slice(to, to + 40),
            from,
            to
        })
    }
    return quotes
}

export interface BenchResult {
    readonly label: string
    /** Median wall-clock milliseconds across the timed runs. */
    readonly medianMs: number
    readonly minMs: number
    readonly maxMs: number
}

/**
 * Times `body` `runs` times after one untimed warm-up pass and reports the
 * MEDIAN. Median, not mean: one GC pause in the middle of a run should not
 * decide whether the suite passes.
 *
 * The result is printed as it is produced, so a CI log carries the numbers
 * even when every assertion passed and nobody looks at the diff.
 */
export function bench(label: string, body: () => void, runs = 3): BenchResult {
    body()
    const timings: number[] = []
    for (let index = 0; index < runs; index += 1) {
        const started = performance.now()
        body()
        timings.push(performance.now() - started)
    }
    timings.sort((left, right) => left - right)
    const result: BenchResult = {
        label,
        medianMs: timings[Math.floor(timings.length / 2)] ?? 0,
        minMs: timings[0] ?? 0,
        maxMs: timings[timings.length - 1] ?? 0
    }
    // stdout, not console: benchmarks report what they measured, this file is
    // test-only and never bundled — and 0.4.1 forbids disabling no-console.
    process.stdout.write(`${formatBenchResult(result)}\n`)
    return result
}

/** One-line report of a measurement, for the test log. */
export function formatBenchResult(result: BenchResult): string {
    return `  ⏱  ${result.label}: median ${result.medianMs.toFixed(2)}ms (min ${result.minMs.toFixed(2)}, max ${result.maxMs.toFixed(2)})`
}
