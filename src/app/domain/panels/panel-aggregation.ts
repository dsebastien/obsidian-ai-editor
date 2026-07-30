import type { AggregatePanelRequest, RawFinding, Verdict } from '../operations/contract'

/**
 * The partial-failure policy of a panel run (plan M6), as one pure decision.
 *
 * ## The policy
 *
 * **A panel completes with the members that succeeded.** A failed member is
 * never silently dropped: it is reported as failed, it stays individually
 * retryable inside the run (the stage-A per-editor retry machinery), and it is
 * named to the chairperson so the scorecard can say what it did not see.
 * Aggregation runs as soon as at least ONE member succeeded; with none, there
 * is nothing to synthesize and the run says so instead of billing a backend to
 * aggregate emptiness.
 *
 * The alternative — fail the whole panel when any member fails — was rejected:
 * a four-member panel on a laptop-hosted model times out on one member often
 * enough that all-or-nothing would mean "usually nothing", and three honest
 * reviews plus a named gap is strictly more useful than a refusal.
 *
 * ## Why the failed members still travel in the request
 *
 * The `aggregate-panel` contract carries a `failed` flag per member precisely
 * so the chairperson knows the panel was incomplete. Sending only the
 * successful members would let it write a confident scorecard over a partial
 * panel without ever knowing it was partial — the exact failure the
 * `missingMembers` field exists to prevent.
 */

/** One member's state at the moment the panel's members settled. */
export interface PanelMemberReview {
    readonly editorName: string
    /** Terminal status of the member's editor stream. */
    readonly status: 'pending' | 'running' | 'done' | 'error' | 'cancelled'
    readonly findings: readonly RawFinding[]
    readonly summary?: string | null
    readonly verdict?: Verdict | null
}

/** Contract cap: findings carried per member in the aggregation request. */
export const AGGREGATION_FINDINGS_PER_MEMBER = 200
/** Contract cap: members carried in one aggregation request. */
export const AGGREGATION_MAX_MEMBERS = 20

// ---------------------------------------------------------------------------
// Compaction and budget
// ---------------------------------------------------------------------------

/**
 * ## Why the aggregation payload is compacted at all
 *
 * A four-member review of a long note can produce hundreds of findings, each
 * carrying anchoring aids, evidence and a full replacement suggestion. Sent
 * raw, that request is several times the size of the note the members read —
 * on a panel over a big document it blows past any sane context budget, and
 * the failure mode is a truncation the MODEL performs silently, somewhere in
 * the middle, with no record of what it dropped.
 *
 * So the plugin does the dropping, deterministically, and says how much.
 *
 * ## What is dropped, and what is never touched
 *
 * The chairperson WEIGHS members; it never anchors a span, never re-verifies a
 * source and never applies a replacement. So `prefix`, `suffix`, `occurrence`,
 * `confidence`, `rationale` and `evidence` are dropped outright, and
 * `critique` / `suggestion` / `summary` are truncated to fixed caps.
 *
 * **Quotes are never truncated.** A `PanelTopFix` points back at a member
 * finding BY QUOTE, and the surface that resolves the pointer matches against
 * the finding's real quote — a shortened quote in the request would come back
 * as a pointer that resolves to nothing, or to the wrong span.
 *
 * Truncation is per-FIELD and unconditional; the budget then decides how many
 * findings travel, never how much of one. Half a critique changes what the
 * member said; a shorter list of complete findings is honest, and countable —
 * which is what `omittedFindings` reports.
 */

/** Per-field caps applied to every finding before the budget is considered. */
export const AGGREGATION_CRITIQUE_MAX = 600
export const AGGREGATION_SUGGESTION_MAX = 600
export const AGGREGATION_SUMMARY_MAX = 1_500

/**
 * Floor for the findings budget. Below this an aggregation would carry so
 * little that the scorecard is guesswork — a user who set a tiny context
 * budget for their reviews still gets a usable panel, and the request is
 * bounded by the contract caps regardless.
 */
export const AGGREGATION_MIN_FINDINGS_BUDGET = 4_000

/**
 * Share of the context budget the aggregation request may spend. The members'
 * reviews already cost a full request each; the scorecard is a synthesis over
 * their output, not a second review, so it gets a fraction rather than the
 * whole allowance.
 */
export const AGGREGATION_BUDGET_SHARE = 0.5

/** What the aggregation request may spend, and what is already spoken for. */
export interface PanelAggregationBudget {
    /** `behavior.contextBudgetChars` — the same policy the reviews obey. */
    readonly contextBudgetChars: number
    /**
     * Length of the charter, which IS the aggregation call's system prompt and
     * is never truncated (same rule as a persona: half a brief silently
     * produces a different chairperson).
     */
    readonly charterChars: number
}

/**
 * Characters available for member findings, after the charter and the member
 * envelopes (names, verdicts, summaries) are paid for. Never below the floor:
 * the request is bounded by the contract caps in any case, and refusing to
 * carry findings would make the scorecard worse than the reviews it
 * summarizes.
 */
export function panelFindingsBudget(budget: PanelAggregationBudget, envelopeChars: number): number {
    const allowance = Math.floor(budget.contextBudgetChars * AGGREGATION_BUDGET_SHARE)
    return Math.max(
        AGGREGATION_MIN_FINDINGS_BUDGET,
        allowance - budget.charterChars - envelopeChars
    )
}

function clip(text: string, max: number): string {
    return text.length <= max ? text : `${text.slice(0, max)}…`
}

/** The finding as the chairperson sees it: what it weighs, nothing else. */
function compactFinding(
    finding: RawFinding
): AggregatePanelRequest['members'][number]['findings'][number] {
    return {
        // Verbatim: a top fix points back at this exact string.
        quote: finding.quote,
        critique: clip(finding.critique, AGGREGATION_CRITIQUE_MAX),
        severity: finding.severity,
        ...(finding.suggestion
            ? { suggestion: clip(finding.suggestion, AGGREGATION_SUGGESTION_MAX) }
            : {}),
        evidence: []
    }
}

/** What one compacted finding costs against the budget. */
function findingCost(
    finding: AggregatePanelRequest['members'][number]['findings'][number]
): number {
    return finding.quote.length + finding.critique.length + (finding.suggestion?.length ?? 0)
}

export type PanelAggregationPlan =
    | {
          readonly kind: 'aggregate'
          /** Every member, failures flagged — the request payload. */
          readonly members: AggregatePanelRequest['members']
          /** Names of the members that did not succeed, in run order. */
          readonly missingMembers: readonly string[]
      }
    | {
          readonly kind: 'skip'
          /** No member produced a review: nothing to synthesize. */
          readonly reason: 'no-member-succeeded'
          readonly missingMembers: readonly string[]
      }

/**
 * Decides whether a settled panel run aggregates, and with what payload.
 *
 * A member "succeeded" when its stream reached `done` — it produced a valid
 * review result, findings or not (a clean read is a real verdict, not a
 * failure). Everything else is missing: `error`, `cancelled`, and the
 * non-terminal statuses, which cannot occur at a settled run and are treated
 * as missing rather than trusted.
 *
 * Payloads are clamped to the operation contract's caps: a backend that
 * streamed more findings than the contract allows must not make the
 * aggregation request unserializable. They are then compacted and fitted to
 * the budget (see above); with no budget the contract caps are the only limit,
 * which is what the specs of the pure policy exercise.
 *
 * ## The fitting rule, and why it is round-robin
 *
 * Findings are taken one member at a time, in run order, cycling: member A's
 * first, B's first, C's first, A's second, and so on. One verbose member
 * therefore cannot starve the others — the failure mode of filling the budget
 * member by member, which would leave the last member of a four-member panel
 * entirely unheard while the scorecard claims to weigh it.
 *
 * When a member's next finding does not fit, that member LEAVES the rotation:
 * its remaining findings are omitted. Skipping one and taking the next would
 * present the member's list as a prefix when it is not — and `omittedFindings`
 * promises exactly a prefix, which is what lets the chairperson reason about
 * what it did not see.
 */
export function planPanelAggregation(
    members: readonly PanelMemberReview[],
    budget?: PanelAggregationBudget
): PanelAggregationPlan {
    const capped = members.slice(0, AGGREGATION_MAX_MEMBERS)
    const missingMembers = capped
        .filter((member) => member.status !== 'done')
        .map((member) => member.editorName)
    if (missingMembers.length === capped.length) {
        return { kind: 'skip', reason: 'no-member-succeeded', missingMembers }
    }
    const candidates = capped.map((member) => {
        const failed = member.status !== 'done'
        return {
            editorName: member.editorName,
            failed,
            summary:
                !failed && member.summary ? clip(member.summary, AGGREGATION_SUMMARY_MAX) : null,
            verdict: !failed && member.verdict ? member.verdict : null,
            findings: failed
                ? []
                : member.findings.slice(0, AGGREGATION_FINDINGS_PER_MEMBER).map(compactFinding)
        }
    })
    const envelopeChars = candidates.reduce(
        (total, member) => total + member.editorName.length + (member.summary?.length ?? 0),
        0
    )
    const kept = fitFindings(
        candidates.map((member) => member.findings),
        budget === undefined ? Number.POSITIVE_INFINITY : panelFindingsBudget(budget, envelopeChars)
    )
    const payload = candidates.map((member, index) => {
        const take = kept[index] ?? 0
        return {
            editorName: member.editorName,
            findings: member.findings.slice(0, take),
            ...(member.summary === null ? {} : { summary: member.summary }),
            ...(member.verdict === null ? {} : { verdict: member.verdict }),
            failed: member.failed,
            omittedFindings: member.findings.length - take
        }
    })
    return { kind: 'aggregate', members: payload, missingMembers }
}

/**
 * How many findings each member keeps, by round-robin within `budgetChars`.
 * Returns one count per input list, in the same order.
 */
function fitFindings(
    perMember: readonly (readonly AggregatePanelRequest['members'][number]['findings'][number][])[],
    budgetChars: number
): number[] {
    const kept = perMember.map(() => 0)
    // Members still taking their turn; a member drops out when its next
    // finding does not fit (see the prefix rule above) or when it runs out.
    let active = perMember.map((_findings, index) => index)
    let remaining = budgetChars
    while (active.length > 0) {
        const next: number[] = []
        for (const index of active) {
            const findings = perMember[index]
            const finding = findings?.[kept[index] ?? 0]
            if (finding === undefined) {
                continue // this member has no findings left
            }
            const cost = findingCost(finding)
            if (cost > remaining) {
                continue // dropped from the rotation: the rest is omitted
            }
            remaining -= cost
            kept[index] = (kept[index] ?? 0) + 1
            next.push(index)
        }
        active = next
    }
    return kept
}
