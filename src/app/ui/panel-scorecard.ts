import type { FindingId } from '../domain/ids'
import type {
    OperationErrorDiagnostics,
    PanelDissent,
    Verdict
} from '../domain/operations/contract'
import { resolveTopFix, scorecardMembers } from '../domain/panels/scorecard-model'
import type { TopFixCandidate } from '../domain/panels/scorecard-model'
import type {
    PanelAggregationStatus,
    PanelRunState
} from '../services/orchestration/run-controller'
import { entityName } from './entity-label'
import { verdictLabel } from './verdict-label'

export type { TopFixCandidate }
export { resolveTopFix }

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
    /**
     * What the failing aggregation backend captured (issue #42). Content is
     * rendered ONLY behind an explicit gesture — the "Show details" modal —
     * never inlined next to `detail` (Business Rules #12, see the contract
     * field). Non-null only when `kind` is `failed`.
     */
    readonly diagnostics: OperationErrorDiagnostics | null
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

/** One member's line in the scorecard, with its verdict relabelled. */
export interface ScorecardMember {
    readonly editorName: string
    readonly verdict: Verdict | null
    /** Human label for `verdict`; null when the panel gave the member none. */
    readonly verdictLabel: string | null
    readonly keyPoint: string | null
    /** True when the member failed and the panel could not weigh it. */
    readonly missing: boolean
    /** True when the scorecard never mentioned this member (see the domain). */
    readonly unnamed: boolean
}

export interface ScorecardView {
    readonly panelName: string
    /**
     * True when the scorecard on screen was produced BEFORE the round
     * currently in flight ("Generate more" on a member). It is kept rather
     * than discarded — every finding it weighed is still there — but it must
     * say so, or it reads as a statement about findings it never saw.
     */
    readonly stale: boolean
    /**
     * The panel's name with the `(panel)` marker (`entityName`). The scorecard
     * block is the one place in the side panel where a panel and its member
     * editors sit in the same list, and the ring next to the name is
     * decoration — this is what makes Business Rules #11 hold for a screen
     * reader.
     */
    readonly panelLabel: string
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

/**
 * Wire status → display kind. Two are renamed: `done` says the request
 * finished where `ready` says the user has a scorecard, and `error` is the
 * request's word where `failed` is the outcome's — and the outcome is what
 * every surface branches on.
 *
 * Exported because the rail projects the same lifecycle onto its panel chip;
 * two mappings would eventually disagree about what a cancelled aggregation
 * looks like.
 */
export function scorecardStatusKind(status: PanelAggregationStatus): ScorecardStatusKind {
    switch (status) {
        case 'done':
            return 'ready'
        case 'error':
            return 'failed'
        default:
            return status
    }
}

const STATUS_LABELS: Readonly<Record<ScorecardStatusKind, string>> = {
    waiting: 'Waiting for the members to finish…',
    running: 'Writing the scorecard…',
    ready: 'Panel scorecard',
    // Names the consequence, not just the failure: the member reviews below
    // are intact and that is the thing the user needs told.
    failed: 'The scorecard could not be written — the member reviews below are unaffected.',
    cancelled: 'The scorecard was cancelled.',
    skipped: 'No member produced a review, so there is nothing to synthesize.',
    unavailable:
        'This panel has no usable aggregation backend, so no scorecard was written. Set one in Settings → Panels.'
}

function statusOf(panel: PanelRunState): ScorecardStatus {
    const kind = scorecardStatusKind(panel.status)
    return {
        kind,
        label: STATUS_LABELS[kind],
        detail: kind === 'failed' ? panel.error : null,
        diagnostics: kind === 'failed' ? panel.errorDiagnostics : null
    }
}

/**
 * Members as the scorecard lists them, with each verdict relabelled. The
 * reconciliation against the run's roster is the domain's
 * (`scorecardMembers`); this only adds the display vocabulary.
 */
function membersOf(panel: PanelRunState): ScorecardMember[] {
    return scorecardMembers({
        memberNames: panel.memberNames,
        missingMembers: panel.missingMembers,
        memberVerdicts: panel.result?.memberVerdicts ?? []
    }).map((entry) => ({
        ...entry,
        verdictLabel: entry.verdict === null ? null : verdictLabel(entry.verdict)
    }))
}

/**
 * Everything the side panel needs to render one panel run's scorecard.
 *
 * `disabledMemberNames` is the disabled-editor lens (Business Rules #21, the
 * hide/purge contract in `editor-visibility.ts`) projected onto the
 * scorecard's NAME-keyed rows — the run states carry the ids, the scorecard
 * result only knows members by name. A disabled member's row, dissent
 * positions and top-fix credit all disappear from the VIEW; the run's stored
 * result is untouched, so re-enabling the editor brings every row straight
 * back. The panel-level synthesis (verdict, rationale, ranked actions) stays:
 * it is the panel's voice, not the member's.
 */
export function buildScorecardView(
    panel: PanelRunState,
    candidates: readonly TopFixCandidate[],
    disabledMemberNames: ReadonlySet<string> = new Set()
): ScorecardView {
    const result = panel.result
    return {
        panelName: panel.panelName,
        stale: panel.resultStale && result !== null,
        panelLabel: entityName('panel', panel.panelName),
        status: statusOf(panel),
        verdict:
            result === null
                ? null
                : { verdict: result.recommendation, label: verdictLabel(result.recommendation) },
        rationale: result?.rationale ?? null,
        members: membersOf(panel).filter((member) => !disabledMemberNames.has(member.editorName)),
        topFixes: (result?.topFixes ?? []).map((fix, index) => {
            const resolved = resolveTopFix(fix, candidates)
            // The RESOLVED owner wins over the credited one: the row is
            // about to reveal that finding, so crediting anyone else is
            // a provenance claim the click contradicts. The model's name
            // stands only when nothing resolved (a structural fix) — and
            // never when it names a disabled member (`candidates` already
            // exclude their findings, so nothing of theirs can resolve;
            // the fix itself stays, as the panel's ranked action).
            const credited = resolved?.editorName ?? fix.editorName ?? null
            return {
                rank: index + 1,
                action: fix.action,
                editorName:
                    credited !== null && disabledMemberNames.has(credited) ? null : credited,
                findingId: resolved?.id ?? null
            }
        }),
        dissent: (result?.dissent ?? [])
            .map((entry) => ({
                ...entry,
                positions: entry.positions.filter(
                    (position) => !disabledMemberNames.has(position.editorName)
                )
            }))
            .filter((entry) => entry.positions.length > 0),
        missingMembers: panel.missingMembers.filter((name) => !disabledMemberNames.has(name))
    }
}

/**
 * The accessible name of ONE scorecard row (plan M9). The row is a stack of
 * unrelated spans — a name, a pill, a key point — and a screen reader reads
 * them as one unpunctuated run in which the member's verdict is impossible to
 * separate from the next member's name. Naming the row as a `group` gives
 * that sentence its boundaries, and puts the member first: the row exists to
 * say what THIS member concluded.
 *
 * The negative states are spelled out rather than left to the pill's colour,
 * for the same reason the pill itself avoids `--text-faint`: "was not weighed"
 * is the whole point of the row it appears on.
 */
export function scorecardMemberName(member: ScorecardMember): string {
    const parts = [member.editorName]
    if (member.missing) {
        parts.push('no review — not weighed by the panel')
    } else if (member.unnamed) {
        parts.push('reviewed, but not named in the scorecard')
    } else if (member.verdictLabel !== null) {
        parts.push(member.verdictLabel)
    }
    if (member.keyPoint !== null && member.keyPoint.length > 0) {
        parts.push(member.keyPoint)
    }
    return parts.join(' — ')
}
