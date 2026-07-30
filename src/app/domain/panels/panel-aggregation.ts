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
 * aggregation request unserializable.
 */
export function planPanelAggregation(members: readonly PanelMemberReview[]): PanelAggregationPlan {
    const capped = members.slice(0, AGGREGATION_MAX_MEMBERS)
    const missingMembers = capped
        .filter((member) => member.status !== 'done')
        .map((member) => member.editorName)
    if (missingMembers.length === capped.length) {
        return { kind: 'skip', reason: 'no-member-succeeded', missingMembers }
    }
    const payload = capped.map((member) => {
        const failed = member.status !== 'done'
        return {
            editorName: member.editorName,
            findings: failed
                ? []
                : member.findings.slice(0, AGGREGATION_FINDINGS_PER_MEMBER).map((finding) => ({
                      ...finding
                  })),
            ...(!failed && member.summary ? { summary: member.summary } : {}),
            ...(!failed && member.verdict ? { verdict: member.verdict } : {}),
            failed,
            omittedFindings: 0
        }
    })
    return { kind: 'aggregate', members: payload, missingMembers }
}
