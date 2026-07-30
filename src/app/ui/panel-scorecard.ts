import type { FindingId } from '../domain/ids'
import type { PanelDissent, Verdict } from '../domain/operations/contract'
import type { PanelRunState } from '../services/orchestration/run-controller'
import { verdictLabel } from './verdict-label'

/**
 * Pure projection of a panel run's aggregation state into what the side panel
 * renders at the top of a panel run (plan M6). No DOM, no Obsidian — the
 * ordering, the copy and the top-fix → finding resolution are all decided here
 * and spec-pinned in `panel-scorecard.spec.ts`.
 *
 * ## The scorecard NEVER replaces the member results
 *
 * Every non-`done` aggregation status still produces a view: the panel's name,
 * what happened to the scorecard, and which members are missing. The member
 * sections render underneath it regardless. An aggregation that failed costs
 * the user a synthesis, never the four reviews they paid for — which is why
 * there is no "hide the panel block on failure" branch anywhere below.
 */

/** Why the scorecard looks the way it does. Mirrors `PanelAggregationStatus`. */
export type ScorecardStatusKind =
    | 'waiting'
    | 'running'
    | 'ready'
    | 'failed'
    | 'cancelled'
    | 'skipped'
    | 'unavailable'

export interface ScorecardStatus {
    readonly kind: ScorecardStatusKind
    /** One line stating where the scorecard stands. */
    readonly label: string
    /** Redacted backend message, when there is one. */
    readonly detail: string | null
}

/** One ranked action, with the member finding it points at when it resolved. */
export interface ScorecardTopFix {
    /** 1-based position in the ranking, as the panel ordered it. */
    readonly rank: number
    readonly action: string
    /** The member credited with the underlying finding, when named. */
    readonly editorName: string | null
    /**
     * The finding to reveal when the row is selected. `null` when the fix
     * carried no pointer, or when it pointed at a quote no live finding has —
     * the row stays, because a structural fix is still a fix.
     */
    readonly findingId: FindingId | null
}

/** One member's line in the scorecard. */
export interface ScorecardMember {
    readonly editorName: string
    readonly verdict: Verdict | null
    /** Human label for `verdict`; null when the panel gave the member none. */
    readonly verdictLabel: string | null
    readonly keyPoint: string | null
    /** True when the member failed and the panel could not weigh it. */
    readonly missing: boolean
}

export interface ScorecardView {
    readonly panelName: string
    readonly status: ScorecardStatus
    /** The panel's overall verdict; null until the scorecard exists. */
    readonly verdict: { readonly verdict: Verdict; readonly label: string } | null
    readonly rationale: string | null
    readonly members: readonly ScorecardMember[]
    readonly topFixes: readonly ScorecardTopFix[]
    readonly dissent: readonly PanelDissent[]
    /** Members that produced no review, whether or not aggregation ran. */
    readonly missingMembers: readonly string[]
}

/** A live finding a top fix may point at. */
export interface TopFixCandidate {
    readonly id: FindingId
    readonly editorName: string
    /** The finding's quote, exactly as the member reported it. */
    readonly quote: string
}

function statusOf(panel: PanelRunState): ScorecardStatus {
    switch (panel.status) {
        case 'waiting':
            return { kind: 'waiting', label: 'Waiting for the members to finish…', detail: null }
        case 'running':
            return { kind: 'running', label: 'Writing the scorecard…', detail: null }
        case 'done':
            return { kind: 'ready', label: 'Panel scorecard', detail: null }
        case 'error':
            // Names the consequence, not just the failure: the member reviews
            // below are intact and that is the thing the user needs told.
            return {
                kind: 'failed',
                label: 'The scorecard could not be written — the member reviews below are unaffected.',
                detail: panel.error
            }
        case 'cancelled':
            return { kind: 'cancelled', label: 'The scorecard was cancelled.', detail: null }
        case 'skipped':
            return {
                kind: 'skipped',
                label: 'No member produced a review, so there is nothing to synthesize.',
                detail: null
            }
        case 'unavailable':
            return {
                kind: 'unavailable',
                label: 'This panel has no usable aggregation backend, so no scorecard was written. Set one in Settings → Panels.',
                detail: null
            }
    }
}

/**
 * Members as the scorecard lists them: the panel's own `memberVerdicts` first
 * (it decides the order — a ranking is a statement), then any member the panel
 * left out, marked missing.
 *
 * A missing member is listed even when the panel never mentioned it: silence
 * about a member that failed is exactly what `missingMembers` exists to
 * prevent, and the chairperson is instructed not to speak for it.
 */
function membersOf(panel: PanelRunState): ScorecardMember[] {
    const missing = new Set(panel.missingMembers)
    const listed = (panel.result?.memberVerdicts ?? []).map((entry) => ({
        editorName: entry.editorName,
        verdict: entry.verdict ?? null,
        verdictLabel: entry.verdict === undefined ? null : verdictLabel(entry.verdict),
        keyPoint: entry.keyPoint ?? null,
        missing: missing.has(entry.editorName)
    }))
    const named = new Set(listed.map((entry) => entry.editorName))
    const unlisted = panel.missingMembers
        .filter((name) => !named.has(name))
        .map((name) => ({
            editorName: name,
            verdict: null,
            verdictLabel: null,
            keyPoint: null,
            missing: true
        }))
    return [...listed, ...unlisted]
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
 */
export function resolveTopFixFinding(
    fix: { readonly editorName?: string | undefined; readonly quote?: string | undefined },
    candidates: readonly TopFixCandidate[]
): FindingId | null {
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
            return inMember.id
        }
        const anywhere = candidates.find(matches)
        if (anywhere) {
            return anywhere.id
        }
    }
    return null
}

/** Everything the side panel needs to render one panel run's scorecard. */
export function buildScorecardView(
    panel: PanelRunState,
    candidates: readonly TopFixCandidate[]
): ScorecardView {
    const result = panel.result
    return {
        panelName: panel.panelName,
        status: statusOf(panel),
        verdict:
            result === null
                ? null
                : { verdict: result.recommendation, label: verdictLabel(result.recommendation) },
        rationale: result?.rationale ?? null,
        members: membersOf(panel),
        topFixes: (result?.topFixes ?? []).map((fix, index) => ({
            rank: index + 1,
            action: fix.action,
            editorName: fix.editorName ?? null,
            findingId: resolveTopFixFinding(fix, candidates)
        })),
        dissent: result?.dissent ?? [],
        missingMembers: panel.missingMembers
    }
}
