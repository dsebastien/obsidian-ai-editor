import type { RawFinding } from './contract'

/** A character span in document coordinates (anchor or selection alike). */
export interface Span {
    readonly from: number
    readonly to: number
}

/**
 * What makes two findings FROM DIFFERENT RUNS the same observation
 * (issue #19, contract v2 design §9).
 *
 * Keys on the observation — quote, locating hints, critique — and NEVER on
 * proposal content: a re-run that rephrases its edit is still raising the same
 * objection, and the user's triage of that objection must carry. Contrast with
 * `rawFindingIdentity`, which serves stream-vs-result dedupe WITHIN one
 * attempt and deliberately includes the edits.
 */
export function observationIdentity(raw: RawFinding): string {
    return JSON.stringify([
        raw.quote,
        raw.critique,
        raw.occurrence ?? null,
        raw.prefix ?? '',
        raw.suffix ?? ''
    ])
}

/**
 * Loose cross-run match for the dismissal-carry case (issue #19): a dismissed
 * finding must not resurrect just because the model reworded its critique, so
 * a new finding landing on an overlapping span of the same editor is treated
 * as the same judged objection. Empty spans (pure insertion points) count as
 * overlapping when they touch the other span.
 */
export function anchorsOverlap(a: Span, b: Span): boolean {
    if (a.from === a.to) {
        return a.from >= b.from && a.from <= b.to
    }
    if (b.from === b.to) {
        return b.from >= a.from && b.from <= a.to
    }
    return a.from < b.to && b.from < a.to
}
