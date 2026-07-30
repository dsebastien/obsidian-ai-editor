import type { FindingId } from '../ids'
import type { Verdict } from '../operations/contract'

/**
 * The two reconciliations every scorecard renderer must run before it shows
 * anything (plan M6).
 *
 * A `PanelResult` is model-authored text that LOOKS like structure: member
 * names, per-fix credits and quotes are all strings the chairperson wrote, and
 * Zod validates their shape, never their identity. Rendering them verbatim
 * would let a panel add a row for an editor that never ran, or credit one
 * member for another's finding.
 *
 * The policy lives in `domain` rather than next to one of its renderers
 * because there are two — the side panel and the CLI — and two
 * implementations of "which members does this scorecard name" would eventually
 * disagree about a partial run, which is exactly the case the scorecard exists
 * to make legible. The display vocabulary (labels, the `(panel)` marker) stays
 * in the UI layer; only the reconciliation is here.
 */

/** One member's line, reconciled against the run's roster. */
export interface ScorecardMemberEntry {
    readonly editorName: string
    readonly verdict: Verdict | null
    readonly keyPoint: string | null
    /** True when the member failed and the panel could not weigh it. */
    readonly missing: boolean
    /**
     * True when the scorecard never mentioned this member — it ran, but the
     * synthesis says nothing about it. Distinct from `missing`, which is the
     * run's own record that no review was produced.
     */
    readonly unnamed: boolean
}

/** What `scorecardMembers` needs: the run's facts plus the panel's claims. */
export interface ScorecardMemberSource {
    /** Every member editor name of the run, in run order. */
    readonly memberNames: readonly string[]
    /** Members that produced no review, in run order. */
    readonly missingMembers: readonly string[]
    /** The scorecard's own member list — model text, checked here. */
    readonly memberVerdicts: readonly {
        readonly editorName: string
        readonly verdict?: Verdict | undefined
        readonly keyPoint?: string | undefined
    }[]
}

/**
 * Members as a scorecard lists them: the panel's own order first (a ranking is
 * a statement), then every roster member it did not name.
 *
 * Names outside the roster are dropped — an invented or misspelled member
 * would otherwise render as a row for an editor that never ran AND hide the
 * real one, which reappears through the roster pass below.
 */
export function scorecardMembers(source: ScorecardMemberSource): ScorecardMemberEntry[] {
    const missing = new Set(source.missingMembers)
    // `missingMembers` is folded into the roster because it is equally ours
    // (the run derives it from member statuses), and a member that failed is
    // still a member.
    const roster = [...new Set([...source.memberNames, ...source.missingMembers])]
    const known = new Set(roster)
    const listed = source.memberVerdicts
        .filter((entry) => known.has(entry.editorName))
        .map((entry) => ({
            editorName: entry.editorName,
            verdict: entry.verdict ?? null,
            keyPoint: entry.keyPoint ?? null,
            missing: missing.has(entry.editorName),
            unnamed: false
        }))
    const named = new Set(listed.map((entry) => entry.editorName))
    const unlisted = roster
        .filter((name) => !named.has(name))
        .map((name) => ({
            editorName: name,
            verdict: null,
            keyPoint: null,
            missing: missing.has(name),
            unnamed: true
        }))
    return [...listed, ...unlisted]
}

/** A live finding a top fix may point at. */
export interface TopFixCandidate {
    readonly id: FindingId
    readonly editorName: string
    /** The finding's quote, exactly as the member reported it. */
    readonly quote: string
}

function normalizeQuote(quote: string): string {
    return quote.replace(/\s+/g, ' ').trim().toLowerCase()
}

/**
 * Resolves a top fix's pointer to a live finding.
 *
 * Precedence, narrowest evidence first: an exact quote match inside the member
 * the fix credits, then an exact match from any member, then the same two
 * steps on whitespace-and-case-normalized quotes. The normalized pass exists
 * because a model asked to copy a quote character-for-character will sometimes
 * re-wrap it; it runs LAST so an exact match is never displaced by a fuzzy one.
 *
 * Returns `null` rather than guessing when nothing matches. A top fix that
 * reveals the wrong span is worse than one that reveals none: the user would
 * act on it (Business Rules #4 — only exact or uniquely-contextualized matches
 * are actionable).
 *
 * Returns the CANDIDATE, not just its id, because the cross-member fallback
 * means the finding a fix resolves to may belong to a different editor than
 * the one the fix credits — and the row must then show the owner the user is
 * about to be shown, not the model's claim.
 */
export function resolveTopFix(
    fix: { readonly editorName?: string | undefined; readonly quote?: string | undefined },
    candidates: readonly TopFixCandidate[]
): TopFixCandidate | null {
    const quote = fix.quote
    if (quote === undefined || quote.length === 0) {
        return null
    }
    const owned =
        fix.editorName === undefined
            ? []
            : candidates.filter((candidate) => candidate.editorName === fix.editorName)
    const normalized = normalizeQuote(quote)
    const passes: readonly ((candidate: TopFixCandidate) => boolean)[] = [
        (candidate): boolean => candidate.quote === quote,
        (candidate): boolean => normalizeQuote(candidate.quote) === normalized
    ]
    for (const matches of passes) {
        const inMember = owned.find(matches)
        if (inMember) {
            return inMember
        }
        const anywhere = candidates.find(matches)
        if (anywhere) {
            return anywhere
        }
    }
    return null
}
