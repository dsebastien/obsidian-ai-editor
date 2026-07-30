/**
 * Word-level diff between two texts, for the transform preview UI (plan §8:
 * word-level red/green inline diff, à la Quill).
 *
 * Pure and deterministic — no DOM, no CM6. The algorithm is a longest common
 * subsequence over WORD TOKENS, where a token is a maximal run of
 * non-whitespace OR a maximal run of whitespace. Whitespace runs are tokens
 * (compared verbatim), so the diff is loss-free: newlines, double spaces and
 * tabs survive round-tripping, and a pure whitespace change (space → newline)
 * shows up as a change instead of being silently normalized.
 *
 * Output invariants (spec-pinned):
 * - concatenating `same` + `del` segments reproduces the old text exactly;
 * - concatenating `same` + `ins` segments reproduces the new text exactly;
 * - no empty segments, no two adjacent segments of the same kind;
 * - within one change region, the deletion segment precedes the insertion
 *   segment (red before green — how the preview renders it);
 * - unicode-safe: tokens are never split inside a run of non-whitespace, so
 *   surrogate pairs, combining marks and emoji stay intact.
 *
 * Readability cleanup: a whitespace-only `same` segment sandwiched between
 * two full replacement regions (del + ins on both sides) is folded into the
 * surrounding change, so a fully rewritten phrase reads as ONE struck block
 * and ONE inserted block instead of red words interleaved with untouched
 * spaces. The folded whitespace then appears in both the del and the ins
 * segment — the reconstruction invariants above still hold.
 *
 * Cost guard: LCS is O(m·n) over token counts. Above `LCS_TOKEN_BUDGET`
 * (product of token counts, after common prefix/suffix trimming) the region
 * is SPLIT on unique common tokens and each gap is diffed on its own; only a
 * region with no unique common token left degrades to one del + one ins block.
 *
 * ## Why the split exists
 *
 * The coarse fallback alone is fast and useless. A whole-note "humanize" of a
 * 30 000-character note is ~8 700 tokens per side — product 76 M, thirty times
 * the budget — so the preview showed the ENTIRE selection struck through and
 * the ENTIRE replacement inserted: two segments, measured (`perf.bench.spec.ts`).
 * That is not a diff, it is a before/after, and the user has to find the
 * changes themselves. The threshold bites early, too: ~1 400 words is enough.
 *
 * Splitting on tokens that occur EXACTLY ONCE on each side (the patience-diff
 * idea) fixes both axes at once. Such a token can only align one way, so it is
 * a safe anchor; taking the longest increasing subsequence of those pairs
 * keeps the anchors monotone; and each gap between anchors is small enough to
 * diff properly. Prose is full of unique tokens — names, numbers, rare
 * words — so a real rewrite splits into hundreds of tiny LCS problems instead
 * of one impossible one, and gets FASTER as well as finer.
 */

export type DiffSegmentKind = 'same' | 'del' | 'ins'

export interface DiffSegment {
    readonly kind: DiffSegmentKind
    readonly text: string
}

/**
 * Maximum allowed product of (old token count × new token count) fed to the
 * LCS table. 4M cells ≈ 16 MB of Uint32 — bounded and fast; beyond it the
 * diff falls back to a whole-region replacement.
 */
export const LCS_TOKEN_BUDGET = 4_000_000

/** Splits text into alternating non-whitespace / whitespace run tokens. */
export function tokenizeWords(text: string): string[] {
    const tokens = text.match(/\s+|\S+/gu)
    return tokens ?? []
}

/** Number of leading tokens shared by both lists. */
function commonPrefixLength(a: readonly string[], b: readonly string[]): number {
    const max = Math.min(a.length, b.length)
    let count = 0
    while (count < max && a[count] === b[count]) {
        count += 1
    }
    return count
}

/** Number of trailing tokens shared by both lists (past the given prefix). */
function commonSuffixLength(a: readonly string[], b: readonly string[], prefix: number): number {
    const max = Math.min(a.length, b.length) - prefix
    let count = 0
    while (count < max && a[a.length - 1 - count] === b[b.length - 1 - count]) {
        count += 1
    }
    return count
}

/** Raw per-token operation, before merging into segments. */
interface TokenOp {
    readonly kind: DiffSegmentKind
    readonly text: string
}

/**
 * Classic LCS diff over the (already prefix/suffix-trimmed) middle tokens.
 * `lengths[i][j]` holds the LCS length of `oldTokens[i:]` × `newTokens[j:]`
 * (suffix-based), so the forward walk emits deletions before insertions at
 * every divergence point and stays fully deterministic.
 */
function lcsOps(oldTokens: readonly string[], newTokens: readonly string[]): TokenOp[] {
    const rows = oldTokens.length + 1
    const cols = newTokens.length + 1
    const lengths = new Uint32Array(rows * cols)
    for (let i = oldTokens.length - 1; i >= 0; i -= 1) {
        for (let j = newTokens.length - 1; j >= 0; j -= 1) {
            const index = i * cols + j
            if (oldTokens[i] === newTokens[j]) {
                lengths[index] = (lengths[index + cols + 1] ?? 0) + 1
            } else {
                const skipOld = lengths[index + cols] ?? 0
                const skipNew = lengths[index + 1] ?? 0
                lengths[index] = skipOld >= skipNew ? skipOld : skipNew
            }
        }
    }
    const ops: TokenOp[] = []
    let i = 0
    let j = 0
    while (i < oldTokens.length && j < newTokens.length) {
        const oldToken = oldTokens[i] as string
        const newToken = newTokens[j] as string
        if (oldToken === newToken) {
            ops.push({ kind: 'same', text: oldToken })
            i += 1
            j += 1
        } else if ((lengths[(i + 1) * cols + j] ?? 0) >= (lengths[i * cols + j + 1] ?? 0)) {
            ops.push({ kind: 'del', text: oldToken })
            i += 1
        } else {
            ops.push({ kind: 'ins', text: newToken })
            j += 1
        }
    }
    while (i < oldTokens.length) {
        ops.push({ kind: 'del', text: oldTokens[i] as string })
        i += 1
    }
    while (j < newTokens.length) {
        ops.push({ kind: 'ins', text: newTokens[j] as string })
        j += 1
    }
    return ops
}

/**
 * How many times an over-budget region may be split before its remainder is
 * given the coarse treatment.
 *
 * Each split strictly shrinks the region, so recursion terminates on its own;
 * the cap only bounds STACK DEPTH against an adversarial input that keeps
 * yielding exactly one anchor per level. In practice one split is enough — the
 * gaps it produces are orders of magnitude under the budget — so this never
 * fires on real text.
 */
const MAX_SPLIT_DEPTH = 12

/** One token that occurs exactly once on each side: a safe alignment point. */
interface Anchor {
    readonly oldIndex: number
    readonly newIndex: number
}

/**
 * Tokens occurring EXACTLY ONCE in both lists, paired and kept in an order
 * that increases on both sides (longest increasing subsequence by new index).
 *
 * Whitespace runs are never anchors: they are the most repeated tokens in any
 * text, a lone one aligns nothing, and anchoring on one would cut a change
 * region in half around a space.
 */
function uniqueCommonAnchors(oldTokens: readonly string[], newTokens: readonly string[]): Anchor[] {
    const oldPositions = new Map<string, number>()
    const oldDuplicates = new Set<string>()
    for (let index = 0; index < oldTokens.length; index += 1) {
        const token = oldTokens[index] as string
        if (oldPositions.has(token)) {
            oldDuplicates.add(token)
        } else {
            oldPositions.set(token, index)
        }
    }
    const newPositions = new Map<string, number>()
    const newDuplicates = new Set<string>()
    for (let index = 0; index < newTokens.length; index += 1) {
        const token = newTokens[index] as string
        if (newPositions.has(token)) {
            newDuplicates.add(token)
        } else {
            newPositions.set(token, index)
        }
    }

    // Candidates in OLD order, so the LIS below only has to make the NEW
    // indexes increase.
    const candidates: Anchor[] = []
    for (const [token, oldIndex] of oldPositions) {
        if (oldDuplicates.has(token) || newDuplicates.has(token) || /^\s+$/u.test(token)) {
            continue
        }
        const newIndex = newPositions.get(token)
        if (newIndex !== undefined) {
            candidates.push({ oldIndex, newIndex })
        }
    }
    candidates.sort((left, right) => left.oldIndex - right.oldIndex)
    return longestIncreasingByNewIndex(candidates)
}

/**
 * Longest strictly-increasing (by `newIndex`) subsequence of anchors already
 * sorted by `oldIndex`. Patience algorithm, O(n log n), deterministic.
 */
function longestIncreasingByNewIndex(candidates: readonly Anchor[]): Anchor[] {
    if (candidates.length === 0) {
        return []
    }
    // `tailIndexes[length - 1]` = index into `candidates` of the smallest
    // possible tail of an increasing subsequence of that length.
    const tailIndexes: number[] = []
    const previous = new Array<number>(candidates.length).fill(-1)
    for (let index = 0; index < candidates.length; index += 1) {
        const value = candidates[index]?.newIndex ?? 0
        let low = 0
        let high = tailIndexes.length
        while (low < high) {
            const middle = (low + high) >> 1
            const candidateIndex = tailIndexes[middle] ?? 0
            if ((candidates[candidateIndex]?.newIndex ?? 0) < value) {
                low = middle + 1
            } else {
                high = middle
            }
        }
        if (low > 0) {
            previous[index] = tailIndexes[low - 1] ?? -1
        }
        tailIndexes[low] = index
    }
    const result: Anchor[] = []
    let cursor = tailIndexes[tailIndexes.length - 1] ?? -1
    while (cursor >= 0) {
        const anchor = candidates[cursor]
        if (anchor === undefined) {
            break
        }
        result.push(anchor)
        cursor = previous[cursor] ?? -1
    }
    return result.reverse()
}

/**
 * Diffs one region: LCS when it fits the budget, otherwise split on unique
 * common tokens and diff each gap. A region with nothing to split on becomes
 * one del + one ins block — correct, coarse, and the only case where the
 * output stops being word-level.
 */
function diffRegion(
    oldTokens: readonly string[],
    newTokens: readonly string[],
    depth: number
): TokenOp[] {
    if (oldTokens.length === 0 && newTokens.length === 0) {
        return []
    }
    if (oldTokens.length === 0) {
        return [{ kind: 'ins', text: newTokens.join('') }]
    }
    if (newTokens.length === 0) {
        return [{ kind: 'del', text: oldTokens.join('') }]
    }
    if (oldTokens.length * newTokens.length <= LCS_TOKEN_BUDGET) {
        return lcsOps(oldTokens, newTokens)
    }
    const anchors = depth >= MAX_SPLIT_DEPTH ? [] : uniqueCommonAnchors(oldTokens, newTokens)
    if (anchors.length === 0) {
        return [
            { kind: 'del', text: oldTokens.join('') },
            { kind: 'ins', text: newTokens.join('') }
        ]
    }
    const ops: TokenOp[] = []
    let oldCursor = 0
    let newCursor = 0
    for (const anchor of anchors) {
        ops.push(
            ...diffRegion(
                oldTokens.slice(oldCursor, anchor.oldIndex),
                newTokens.slice(newCursor, anchor.newIndex),
                depth + 1
            )
        )
        ops.push({ kind: 'same', text: oldTokens[anchor.oldIndex] as string })
        oldCursor = anchor.oldIndex + 1
        newCursor = anchor.newIndex + 1
    }
    ops.push(...diffRegion(oldTokens.slice(oldCursor), newTokens.slice(newCursor), depth + 1))
    return ops
}

/**
 * Merges token ops into display segments: consecutive `same` ops join into
 * one segment; every maximal run of non-`same` ops becomes at most one `del`
 * segment followed by at most one `ins` segment (red before green), with the
 * original token order preserved inside each.
 */
function mergeOps(ops: readonly TokenOp[]): DiffSegment[] {
    const segments: DiffSegment[] = []
    let sameText = ''
    let delText = ''
    let insText = ''
    const flushChange = (): void => {
        if (delText.length > 0) {
            segments.push({ kind: 'del', text: delText })
            delText = ''
        }
        if (insText.length > 0) {
            segments.push({ kind: 'ins', text: insText })
            insText = ''
        }
    }
    const flushSame = (): void => {
        if (sameText.length > 0) {
            segments.push({ kind: 'same', text: sameText })
            sameText = ''
        }
    }
    for (const op of ops) {
        if (op.kind === 'same') {
            flushChange()
            sameText += op.text
        } else {
            flushSame()
            if (op.kind === 'del') {
                delText += op.text
            } else {
                insText += op.text
            }
        }
    }
    flushChange()
    flushSame()
    return segments
}

/** Whether a segment is a whitespace-only `same` bridge. */
function isWhitespaceSame(segment: DiffSegment): boolean {
    return segment.kind === 'same' && /^\s+$/u.test(segment.text)
}

/** Whether the segments starting at `index` form a del+ins replacement pair. */
function replacementAt(segments: readonly DiffSegment[], index: number): boolean {
    return segments[index]?.kind === 'del' && segments[index + 1]?.kind === 'ins'
}

/**
 * Folds whitespace-only `same` segments that sit between two full
 * replacement regions into one combined replacement (see the module doc).
 * Only fires when BOTH neighbors are del+ins pairs — a pure insertion or
 * pure deletion next door keeps its untouched whitespace visible as-is
 * (folding there would strike through or green-highlight whitespace that
 * has no changed counterpart).
 */
function foldWhitespaceBridges(segments: readonly DiffSegment[]): DiffSegment[] {
    const folded: DiffSegment[] = []
    let index = 0
    while (index < segments.length) {
        const segment = segments[index] as DiffSegment
        const previousIndex = folded.length - 2
        if (
            isWhitespaceSame(segment) &&
            previousIndex >= 0 &&
            replacementAt(folded, previousIndex) &&
            replacementAt(segments, index + 1)
        ) {
            const previousIns = folded.pop() as DiffSegment
            const previousDel = folded.pop() as DiffSegment
            const nextDel = segments[index + 1] as DiffSegment
            const nextIns = segments[index + 2] as DiffSegment
            folded.push(
                { kind: 'del', text: previousDel.text + segment.text + nextDel.text },
                { kind: 'ins', text: previousIns.text + segment.text + nextIns.text }
            )
            index += 3
            continue
        }
        folded.push(segment)
        index += 1
    }
    return folded
}

/**
 * Computes the word-level diff from `oldText` to `newText`. See the module
 * doc for the exact output invariants.
 */
export function wordDiff(oldText: string, newText: string): DiffSegment[] {
    if (oldText === newText) {
        return oldText.length === 0 ? [] : [{ kind: 'same', text: oldText }]
    }
    const oldTokens = tokenizeWords(oldText)
    const newTokens = tokenizeWords(newText)
    const prefix = commonPrefixLength(oldTokens, newTokens)
    const suffix = commonSuffixLength(oldTokens, newTokens, prefix)
    const oldMiddle = oldTokens.slice(prefix, oldTokens.length - suffix)
    const newMiddle = newTokens.slice(prefix, newTokens.length - suffix)
    const ops: TokenOp[] = oldTokens.slice(0, prefix).map((text) => ({ kind: 'same', text }))
    ops.push(...diffRegion(oldMiddle, newMiddle, 0))
    ops.push(
        ...oldTokens.slice(oldTokens.length - suffix).map(
            (text): TokenOp => ({
                kind: 'same',
                text
            })
        )
    )
    return foldWhitespaceBridges(mergeOps(ops))
}
