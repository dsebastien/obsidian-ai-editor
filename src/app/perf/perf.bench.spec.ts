import { EditorState } from '@codemirror/state'
import { describe, expect, test } from 'bun:test'

import { createQuoteMatcher, matchQuote } from '../domain/anchoring/match'
import { commentJobView } from '../domain/comments/comment-job'
import type { MarginComment } from '../domain/comments/margin-comment'
import { reanchorComments } from '../domain/comments/reanchor'
import { spanHints } from '../domain/comments/span-hints'
import { tokenizeWords, wordDiff } from '../domain/diff/word-diff'
import {
    behaviorSettingsSchema,
    editorConfigSchema,
    promptSourceSchema
} from '../domain/settings/settings-schema'
import { createCachingVaultReader } from '../services/context/caching-vault-reader'
import { assembleContext } from '../services/context/context-assembler'
import type { NoteMetadata, VaultReader } from '../services/context/vault-reader.intf'
import {
    findingDecorationsField,
    markStaleEffect,
    setFindingsEffect,
    type FindingDecorationSpec
} from '../ui/editor/finding-decorations'
import { clusterByLine } from '../ui/editor/margin-layout'
import {
    marginColumnModel,
    marginModelKey,
    type MarginCommentInput
} from '../ui/editor/margin-model'
import { bench, benchQuotes, buildBenchNote } from './bench'

/**
 * The performance suite (plan M9, "performance passes — large notes, many
 * findings"). Every number in the history entry for the performance pass was
 * produced by this file.
 *
 * Run it alone:
 *
 * ```bash
 * bun test perf.bench
 * ```
 *
 * **Assertions are CEILINGS, not targets.** Each one sits far above the
 * measured median on a developer laptop, because a benchmark that fails on a
 * slower machine is a broken test, not a caught regression. What they catch is
 * the thing that actually happens: an accidental O(n²) that turns 20 ms into
 * 2 s. Tightening a ceiling is a deliberate act, made by the commit that made
 * the code fast enough for it — so the git history of this file IS the record
 * of what each performance fix bought.
 *
 * Sizes are the documented pathological cases, not averages: a 200 000-char
 * note (well past the 8 000-word size warning), 200 findings (the operation
 * contract's per-result cap), 500 comments (`MAX_COMMENTS_PER_NOTE`).
 */

const LARGE_NOTE_CHARS = 200_000

/**
 * Per-test timeout for the benchmarks.
 *
 * Bun's default is 5 s, which is a fine default for a unit test and a useless
 * one for a benchmark whose job is to measure something slow and say so: a
 * timeout reports "timed out" where the suite wants to report "2 872 ms". The
 * CEILING assertions are what fail on a regression; this only decides how long
 * a failing benchmark may take before it gives up.
 */
const BENCH_TIMEOUT_MS = 180_000

describe('perf: anchoring a large note with many findings', () => {
    const note = buildBenchNote(LARGE_NOTE_CHARS)
    const quotes = benchQuotes(note, 200)
    // Case drift is the most common way a model breaks a "verbatim" quote, and
    // it puts every finding on the expensive rung of the ladder.
    const drifted = quotes.map((quote) => ({ ...quote, quote: quote.quote.toUpperCase() }))

    test(
        '200 verbatim quotes anchor against a 200k note',
        () => {
            const result = bench('anchor 200 exact quotes / 200k note', () => {
                const matcher = createQuoteMatcher(note)
                for (const quote of quotes) {
                    matcher.match(quote.quote, { prefix: quote.prefix, suffix: quote.suffix })
                }
            })
            expect(result.medianMs).toBeLessThan(200)
        },
        BENCH_TIMEOUT_MS
    )

    test(
        '200 quotes that MISS the exact pass still anchor in bounded time',
        () => {
            const result = bench('anchor 200 normalized-path quotes / 200k note', () => {
                const matcher = createQuoteMatcher(note)
                for (const quote of drifted) {
                    matcher.match(quote.quote, { prefix: quote.prefix, suffix: quote.suffix })
                }
            })
            expect(result.medianMs).toBeLessThan(400)
        },
        BENCH_TIMEOUT_MS
    )

    test(
        '200 quotes that match NOTHING resolve in bounded time',
        () => {
            // The true worst case: every rung is walked and none hits. A model
            // that quotes the RENDERED text of a note it was sent as markdown
            // produces exactly this.
            const result = bench('anchor 200 not-found quotes / 200k note', () => {
                const matcher = createQuoteMatcher(note)
                for (let index = 0; index < 200; index += 1) {
                    matcher.match(`absent phrase ${index} that is nowhere in the note`)
                }
            })
            expect(result.medianMs).toBeLessThan(400)
        },
        BENCH_TIMEOUT_MS
    )

    test(
        'the ONE-SHOT form costs a full pass per call — which is why the seam exists',
        () => {
            // Kept deliberately, at a smaller n: `matchQuote` is the one-shot
            // API and re-derives everything per call by construction. Anyone
            // tempted to loop it against one document can read the price here
            // instead of shipping it. 25 quotes, not 200, because the point is
            // the SHAPE of the cost, not how long the suite takes to prove it.
            const result = bench('matchQuote (one-shot) ×25 missing quotes / 200k note', () => {
                for (let index = 0; index < 25; index += 1) {
                    matchQuote(note, `absent phrase ${index} that is nowhere in the note`)
                }
            })
            expect(result.medianMs).toBeLessThan(3_000)
        },
        BENCH_TIMEOUT_MS
    )
})

describe('perf: re-anchoring durable comments', () => {
    const note = buildBenchNote(LARGE_NOTE_CHARS)

    function comments(count: number, mangleQuote: (quote: string) => string): MarginComment[] {
        return benchQuotes(note, count, 50).map((quote, index) => {
            const hints = spanHints(note, quote.from, quote.to)
            return {
                id: `comment-${index}`,
                editorId: 'ed-1',
                editorName: 'Editor',
                instruction: 'Is this claim true?',
                quote: mangleQuote(hints?.quote ?? quote.quote),
                prefix: hints?.prefix ?? quote.prefix,
                suffix: hints?.suffix ?? quote.suffix,
                occurrence: hints?.occurrence ?? 0,
                status: 'done',
                findings: [],
                reply: 'An answer.',
                createdAt: 1,
                updatedAt: 2
            } as unknown as MarginComment
        })
    }

    test(
        '500 anchored comments re-anchor on every refresh cycle',
        () => {
            const anchored = comments(500, (quote) => quote)
            const result = bench('reanchor 500 anchored comments / 200k note', () => {
                reanchorComments(note, anchored)
            })
            expect(result.medianMs).toBeLessThan(400)
        },
        BENCH_TIMEOUT_MS
    )

    test(
        '500 ORPHANED comments re-anchor in bounded time',
        () => {
            // The freeze case. An orphan never hits the exact pass, so every
            // one of them walks the normalized rung. `MAX_COMMENTS_PER_NOTE`
            // is 500, so this is the worst a single note can hold — and it
            // runs on the refresh cycle, i.e. while the user types.
            const orphaned = comments(500, (quote) => `${quote} ~gone~`)
            const result = bench('reanchor 500 orphaned comments / 200k note', () => {
                reanchorComments(note, orphaned)
            })
            expect(result.medianMs).toBeLessThan(300)
        },
        BENCH_TIMEOUT_MS
    )
})

describe('perf: word diff on a large replacement', () => {
    const oldText = buildBenchNote(30_000, 3)
    const random = (() => {
        let state = 12_345
        return () => {
            state = (Math.imul(state, 1664525) + 1013904223) >>> 0
            return state / 0x1_0000_0000
        }
    })()
    // A rewrite, not a different document: ~25% of the words changed, which is
    // what "humanize this section" actually returns.
    const newText = oldText
        .split(/(\s+)/u)
        .map((token) => (/\S/u.test(token) && random() < 0.25 ? `${token}ish` : token))
        .join('')

    test(
        'a ~30k-char rewrite diffs in bounded time',
        () => {
            const oldTokens = tokenizeWords(oldText).length
            const newTokens = tokenizeWords(newText).length
            expect(oldTokens).toBeGreaterThan(5_000)
            expect(newTokens).toBeGreaterThan(5_000)
            const result = bench(`wordDiff 30k chars (${oldTokens}×${newTokens} tokens)`, () => {
                wordDiff(oldText, newText)
            })
            expect(result.medianMs).toBeLessThan(2_000)
        },
        BENCH_TIMEOUT_MS
    )

    test(
        'the diff of a large rewrite reconstructs both texts',
        () => {
            // A cost guard that traded correctness for speed would be worse
            // than a slow diff, so the reconstruction invariants are asserted
            // at benchmark size too, not only in the unit specs.
            const segments = wordDiff(oldText, newText)
            const rebuiltOld = segments
                .filter((segment) => segment.kind !== 'ins')
                .map((segment) => segment.text)
                .join('')
            const rebuiltNew = segments
                .filter((segment) => segment.kind !== 'del')
                .map((segment) => segment.text)
                .join('')
            expect(rebuiltOld).toBe(oldText)
            expect(rebuiltNew).toBe(newText)
        },
        BENCH_TIMEOUT_MS
    )

    test(
        'the diff of a large rewrite is REPORTED at its real granularity',
        () => {
            // Speed is not the only axis. A cost guard that degrades a 25 %
            // rewrite into one struck block plus one inserted block is fast
            // and useless — the user is shown their whole selection in red and
            // the whole replacement in green, which is exactly the diff they
            // could have made in their head. So the granularity is measured,
            // and the number is in the history next to the timings.
            const segments = wordDiff(oldText, newText)
            const changed = segments.filter((segment) => segment.kind !== 'same').length
            // eslint-disable-next-line no-console -- reason: benchmarks report what they measured; this file is test-only and never bundled into the plugin.
            console.log(`  ⏱  wordDiff 30k chars granularity: ${changed} changed segments`)
            // Before the anchor split this was 2 — the whole selection struck,
            // the whole replacement inserted.
            expect(changed).toBeGreaterThan(500)
        },
        BENCH_TIMEOUT_MS
    )
})

describe('perf: decoration rebuilds with many findings', () => {
    const doc = buildBenchNote(LARGE_NOTE_CHARS)

    function specs(count: number): FindingDecorationSpec[] {
        return benchQuotes(doc, count, 20).map((quote, index) => ({
            findingId: `finding-${index}`,
            editorId: `ed-${index % 6}`,
            from: quote.from,
            to: quote.to,
            color: '#ff8800',
            editorName: `Editor ${index % 6}`,
            panelName: null,
            severity: 'suggestion' as const,
            edgeIndex: index % 6,
            stale: false,
            current: false
        }))
    }

    test(
        'a full rebuild of 2000 finding marks',
        () => {
            const built = specs(2_000)
            const state = EditorState.create({ doc, extensions: [findingDecorationsField] })
            const result = bench('setFindingsEffect 2000 marks / 200k doc', () => {
                // Reading `.state` forces the field update — `update()` alone
                // returns a transaction and computes the new state lazily, so
                // a benchmark that ignores it measures nothing.
                expect(state.update({ effects: setFindingsEffect.of(built) }).state).toBeDefined()
            })
            expect(result.medianMs).toBeLessThan(120)
        },
        BENCH_TIMEOUT_MS
    )

    test(
        'an incremental stale-marking pass over 2000 marks',
        () => {
            const built = specs(2_000)
            const state = EditorState.create({
                doc,
                extensions: [findingDecorationsField]
            }).update({ effects: setFindingsEffect.of(built) }).state
            const staleIds = built.slice(0, 100).map((spec) => spec.findingId)
            const result = bench('markStaleEffect 100 of 2000 marks', () => {
                expect(state.update({ effects: markStaleEffect.of(staleIds) }).state).toBeDefined()
            })
            expect(result.medianMs).toBeLessThan(120)
        },
        BENCH_TIMEOUT_MS
    )

    test(
        'a keystroke maps 2000 marks',
        () => {
            // The one that runs on EVERY transaction: `DecorationSet.map`.
            const built = specs(2_000)
            const state = EditorState.create({
                doc,
                extensions: [findingDecorationsField]
            }).update({ effects: setFindingsEffect.of(built) }).state
            const result = bench('keystroke maps 2000 marks', () => {
                expect(state.update({ changes: { from: 10, insert: 'x' } }).state).toBeDefined()
            })
            expect(result.medianMs).toBeLessThan(30)
        },
        BENCH_TIMEOUT_MS
    )
})

describe('perf: margin column model with many comments', () => {
    const note = buildBenchNote(LARGE_NOTE_CHARS)
    const inputs: MarginCommentInput[] = benchQuotes(note, 500, 50).map((quote, index) => {
        const comment = {
            id: `comment-${index}`,
            editorId: 'ed-1',
            editorName: 'Editor',
            instruction: 'Is this claim true, and is it well supported by what came before it?',
            quote: quote.quote,
            status: 'done',
            findings: [],
            reply: 'A reasonably long answer that will need clipping. '.repeat(10),
            createdAt: 1,
            updatedAt: 2
        } as unknown as MarginComment
        return {
            comment,
            view: commentJobView({ comment, startedAt: null, now: 10 }),
            outcome: 'exact' as const,
            color: '#ff8800',
            editorName: 'Editor',
            expanded: false
        }
    })

    test(
        '500 comments project and key in bounded time',
        () => {
            const byId = new Map(inputs.map((input) => [input.comment.id, input]))
            const clusters = clusterByLine(
                inputs.map((input, index) => ({
                    id: input.comment.id,
                    anchorTop: Math.floor(index / 2) * 24
                }))
            )
            const result = bench('marginColumnModel + key, 500 comments', () => {
                const model = marginColumnModel({
                    groups: clusters.map((cluster) => ({
                        key: cluster.key,
                        anchorTop: cluster.anchorTop,
                        expanded: false,
                        comments: cluster.ids
                            .map((id) => byId.get(id))
                            .filter((input): input is MarginCommentInput => input !== undefined)
                    })),
                    orphans: [],
                    orphansExpanded: false
                })
                marginModelKey(model)
            })
            expect(result.medianMs).toBeLessThan(60)
        },
        BENCH_TIMEOUT_MS
    )
})

describe('perf: context assembly with a big budget and many linked notes', () => {
    const LINKED_NOTES = 20 // `maxLinkedNotes` caps at 20 (settings schema)
    const NOTE_PATH = 'Articles/Draft.md'

    class CountingVault implements VaultReader {
        reads = 0
        metadataReads = 0
        private readonly notes = new Map<string, string>()

        constructor() {
            this.notes.set(NOTE_PATH, 'body')
            for (let index = 0; index < LINKED_NOTES; index += 1) {
                this.notes.set(
                    `Linked/Note ${index}.md`,
                    `# Linked ${index}\n${'x '.repeat(2_000)}`
                )
            }
        }

        readNote(path: string): Promise<string | null> {
            this.reads += 1
            return Promise.resolve(this.notes.get(path) ?? null)
        }

        resolveLink(linkText: string): string | null {
            return this.notes.has(`${linkText}.md`) ? `${linkText}.md` : null
        }

        getOutgoingLinks(path: string): string[] {
            return path === NOTE_PATH
                ? [...this.notes.keys()].filter((key) => key !== NOTE_PATH)
                : []
        }

        getNoteMetadata(path: string): NoteMetadata | null {
            this.metadataReads += 1
            return this.notes.has(path) ? { tags: [], frontmatter: {} } : null
        }

        getNoteTypeIds(): readonly string[] {
            return []
        }
    }

    const editor = editorConfigSchema.parse({
        id: 'ed-1',
        name: 'Concision Editor',
        includeLinkedNotes: true,
        maxLinkedNotes: LINKED_NOTES
    })
    const behavior = behaviorSettingsSchema.parse({ contextBudgetChars: 2_000_000 })
    const voiceProfile = promptSourceSchema.parse({})
    const noteText = buildBenchNote(40_000)

    test(
        'one editor attaches 20 linked notes, reading each once',
        async () => {
            const vault = new CountingVault()
            const context = await assembleContext({
                editor,
                voiceProfile,
                behavior,
                vault,
                notePath: NOTE_PATH,
                noteText
            })
            expect(context.attachments).toHaveLength(LINKED_NOTES)
            expect(vault.reads).toBe(LINKED_NOTES)
        },
        BENCH_TIMEOUT_MS
    )

    test(
        'eight editors over the same note assemble in bounded time',
        async () => {
            // The number this benchmark exists to pin: a panel of 8 members
            // over one note assembles 8 independent contexts, and every one of
            // them walks the same link graph and reads the same notes.
            const vault = new CountingVault()
            const started = performance.now()
            for (let index = 0; index < 8; index += 1) {
                await assembleContext({
                    editor,
                    voiceProfile,
                    behavior,
                    vault,
                    notePath: NOTE_PATH,
                    noteText
                })
            }
            const elapsed = performance.now() - started
            // eslint-disable-next-line no-console -- reason: benchmarks report what they measured; this file is test-only and never bundled into the plugin.
            console.log(
                `  ⏱  assembleContext ×8 editors / 20 linked notes (raw): ${elapsed.toFixed(2)}ms, ${vault.reads} note reads, ${vault.metadataReads} metadata reads`
            )
            expect(elapsed).toBeLessThan(2_000)
            // The number the caching reader exists to fix: 8 editors, 20
            // notes, 160 reads.
            expect(vault.reads).toBe(8 * LINKED_NOTES)
        },
        BENCH_TIMEOUT_MS
    )

    test(
        'through ONE run-scoped reader, eight editors read each note once',
        async () => {
            const vault = new CountingVault()
            const shared = createCachingVaultReader(vault)
            const started = performance.now()
            for (let index = 0; index < 8; index += 1) {
                await assembleContext({
                    editor,
                    voiceProfile,
                    behavior,
                    vault: shared,
                    notePath: NOTE_PATH,
                    noteText
                })
            }
            const elapsed = performance.now() - started
            // eslint-disable-next-line no-console -- reason: benchmarks report what they measured; this file is test-only and never bundled into the plugin.
            console.log(
                `  ⏱  assembleContext ×8 editors / 20 linked notes (run-scoped reader): ${elapsed.toFixed(2)}ms, ${vault.reads} note reads, ${vault.metadataReads} metadata reads`
            )
            expect(vault.reads).toBe(LINKED_NOTES)
            expect(vault.metadataReads).toBe(LINKED_NOTES + 1)
        },
        BENCH_TIMEOUT_MS
    )
})
