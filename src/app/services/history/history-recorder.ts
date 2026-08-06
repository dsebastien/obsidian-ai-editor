import { observationIdentity } from '../../domain/operations/cross-run'
import type { RunObserver } from '../orchestration/run-controller'
import type { TransformOutcome } from '../orchestration/transform-run'
import type { HistoryService, RecordInput } from './history-service'

/**
 * Adapts run outcomes (`RunObserver`, issue #21) into history records. Pure
 * mapping — what of each outcome is WORTH keeping, in the clipped shape the
 * entry model enforces:
 *
 * - a finding keeps its observation (quote + critique + severity), its
 *   proposal ops/texts, and #19's observation identity as the repeat key;
 * - a thread turn keeps the exchange (the user's push-back and the editor's
 *   reply) with its outcome;
 * - a scorecard keeps the verdict, the rationale and the per-member verdicts
 *   (the fixes point at findings that are archived separately);
 * - a transform (issue #43, `transformHistoryRecord` below) keeps the span
 *   it targeted, the proposed text, and the user's verdict — recorded at
 *   DECISION time, not through the `RunObserver`.
 */
export function createHistoryRecorder(history: HistoryService): RunObserver {
    return {
        editorSettled(input): void {
            for (const finding of input.findings) {
                history.record({
                    filePath: input.filePath,
                    editorId: input.editorId,
                    editorName: input.editorName,
                    kind: 'finding',
                    key: observationIdentity(finding.raw),
                    quote: finding.raw.quote,
                    text: finding.raw.critique,
                    edits: finding.raw.edits.map((edit) => ({
                        op: edit.op,
                        text: edit.text ?? ''
                    })),
                    label: finding.raw.severity
                })
            }
        },
        threadSettled(input): void {
            history.record({
                filePath: input.filePath,
                editorId: input.editorId,
                editorName: input.editorName,
                kind: 'thread',
                quote: input.quote,
                text: `You: ${input.message}\n${input.editorName}: ${input.reply}`,
                label: input.outcome
            })
        },
        panelSettled(input): void {
            const members = input.result.memberVerdicts
                .map((member) =>
                    member.verdict === undefined
                        ? member.editorName
                        : `${member.editorName}: ${member.verdict}`
                )
                .join(' · ')
            history.record({
                filePath: input.filePath,
                editorId: '',
                editorName: input.panelName,
                kind: 'scorecard',
                text: [input.result.rationale ?? '', members]
                    .filter((s) => s.length > 0)
                    .join('\n'),
                label: input.result.recommendation
            })
        }
    }
}

/** The user's verdict on a presented transform/generate outcome (issue #43). */
export type TransformDecision = 'accepted' | 'rejected'

export interface TransformDecisionInput {
    readonly filePath: string
    readonly editorId: string
    readonly editorName: string
    readonly kind: 'transform-selection' | 'insert-at'
    /** Sentence-case verb label ("Rephrase"); null when the caller had none. */
    readonly actionLabel: string | null
    /** Exact text of the replaced span; null for insertions. */
    readonly spanText: string | null
    readonly outcome: TransformOutcome
    readonly decision: TransformDecision
}

/**
 * Maps one decided transform outcome (issue #43, deferred from #21) into a
 * history record: the targeted span as the quote, the proposed text as a
 * single edit, the action verb + model rationale as the text, the user's
 * verdict as the label. Recorded at DECISION time (accept/reject), not at
 * run settle — an outcome the user never ruled on (cancelled, superseded,
 * discarded as stale) is not an outcome at all. No observation identity:
 * a decided run is discarded on the spot, so verbatim repeats cannot occur.
 * Clipping is the service's job, same as every other record.
 */
export function transformHistoryRecord(input: TransformDecisionInput): RecordInput {
    return {
        filePath: input.filePath,
        editorId: input.editorId,
        editorName: input.editorName,
        kind: 'transform',
        quote: input.spanText ?? '',
        text: [input.actionLabel ?? '', input.outcome.rationale ?? '']
            .filter((part) => part.length > 0)
            .join('\n'),
        edits: [
            {
                op: input.kind === 'transform-selection' ? 'replace' : 'insert',
                text: input.outcome.text
            }
        ],
        label: input.decision
    }
}
