/**
 * How many finding highlights one note may carry (plan M9, performance pass).
 *
 * ## The number, and why there is one at all
 *
 * A single backend result is capped at 200 findings by the operation contract,
 * but a note's marks are the SUM over the run's editors: a panel of twenty
 * members can put four thousand highlights on one note, and nothing in the
 * settings stops a user adding more editors than that.
 *
 * The decoration set itself handles it: measured (`perf/perf.bench.spec.ts`),
 * 2 000 marks on a 200 000-character document rebuild in ~1.2 ms and remap on
 * a keystroke in ~0.06 ms; 10 000 marks cost ~6.4 ms to rebuild. So this cap
 * is NOT there to rescue CodeMirror — it is there because the marks are only
 * one of several per-finding costs paid on the same refresh cycle (building
 * the specs, keying them to skip a no-op dispatch, rendering the side-panel
 * list), the cycle fires on every edit batch, and those costs are additive.
 * Bounding the largest one keeps the editing loop's cost bounded by the
 * DOCUMENT rather than by how many editors the user has enabled.
 *
 * 2 000 is chosen as the point where the measured cost is still under a frame
 * at 60 Hz with room for everything else on the cycle. It is not a settings
 * knob: a user cannot be expected to reason about it, and every value that is
 * not pathological is under it.
 *
 * ## What the cap does NOT do
 *
 * It never hides a finding. Every one stays in the store, in the side-panel
 * list, in the counts, and remains acceptable and dismissable. The cap decides
 * which ones get a coloured span in the text — and the surface says how many
 * did not, because a plugin that quietly stopped highlighting would look
 * broken rather than bounded.
 */

/** Maximum number of finding marks rendered in one note. */
export const MAX_DECORATED_FINDINGS = 2_000

/** The shape the budget needs; the real spec carries much more. */
export interface DecorableSpan {
    /** Start offset in the current document. */
    readonly from: number
    /** The keyboard-triage cursor's finding, at most one per dispatch. */
    readonly current: boolean
}

export interface DecorationBudgetResult<T extends DecorableSpan> {
    /** The spans to decorate, at most {@link MAX_DECORATED_FINDINGS} of them. */
    readonly decorated: readonly T[]
    /** How many were left undecorated (still listed, still actionable). */
    readonly undecorated: number
}

/**
 * Keeps the first `cap` spans in DOCUMENT ORDER, plus the triage cursor's span
 * wherever it sits.
 *
 * Document order rather than store order because the cap has to be
 * predictable: "the first N highlights in the note" is a rule a user can
 * observe and reason about, while "the first N the store happened to hold" is
 * a rule that reshuffles when an editor finishes.
 *
 * The cursor is exempt because keyboard triage can step to ANY finding, and a
 * cursor standing on a span with no ring is a broken affordance rather than a
 * dropped nicety. Exactly one span can be `current`, so the exemption costs at
 * most one mark over the cap.
 *
 * Under the cap this returns the input untouched — same array, no sort, no
 * allocation. That is the only path real usage ever takes.
 */
export function applyDecorationBudget<T extends DecorableSpan>(
    specs: readonly T[],
    cap: number = MAX_DECORATED_FINDINGS
): DecorationBudgetResult<T> {
    if (cap <= 0) {
        return { decorated: [], undecorated: specs.length }
    }
    if (specs.length <= cap) {
        return { decorated: specs, undecorated: 0 }
    }
    const ordered = [...specs].sort((left, right) => left.from - right.from)
    const decorated = ordered.slice(0, cap)
    const cursor = ordered.slice(cap).find((spec) => spec.current)
    if (cursor !== undefined) {
        decorated.push(cursor)
    }
    return { decorated, undecorated: specs.length - decorated.length }
}

/**
 * What the side panel says when the cap bit. Names the consequence, not the
 * mechanism: "not highlighted" is what the user can see, "decoration budget"
 * is plugin vocabulary.
 */
export function undecoratedNoticeText(count: number): string {
    if (count <= 0) {
        return ''
    }
    return count === 1
        ? '1 finding is listed here but not highlighted in the note (too many to highlight at once).'
        : `${count} findings are listed here but not highlighted in the note (too many to highlight at once).`
}
