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
 * (product of token counts, after common prefix/suffix trimming) the middle
 * degrades to one del + one ins block — still correct, just coarser. Typical
 * selection-sized transforms are far below the budget.
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
    if (oldMiddle.length * newMiddle.length > LCS_TOKEN_BUDGET) {
        // Cost-guard fallback: one coarse replacement block for the middle.
        if (oldMiddle.length > 0) {
            ops.push({ kind: 'del', text: oldMiddle.join('') })
        }
        if (newMiddle.length > 0) {
            ops.push({ kind: 'ins', text: newMiddle.join('') })
        }
    } else {
        ops.push(...lcsOps(oldMiddle, newMiddle))
    }
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
