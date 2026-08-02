import { observationIdentity } from '../../domain/operations/cross-run'
import type { RunObserver } from '../orchestration/run-controller'
import type { HistoryService } from './history-service'

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
 *   (the fixes point at findings that are archived separately).
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
