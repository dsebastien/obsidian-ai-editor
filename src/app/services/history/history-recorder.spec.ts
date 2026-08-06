import { describe, expect, it } from 'bun:test'
import { HISTORY_QUOTE_MAX } from '../../domain/history/history-entry'
import { transformHistoryRecord } from './history-recorder'
import type { TransformDecisionInput } from './history-recorder'
import { HistoryService } from './history-service'

const NOW = 1_700_000_000_000

function decisionInput(overrides: Partial<TransformDecisionInput> = {}): TransformDecisionInput {
    return {
        filePath: 'a.md',
        editorId: 'e1',
        editorName: 'Editor',
        kind: 'transform-selection',
        actionLabel: 'Rephrase',
        spanText: 'the original span',
        outcome: { text: 'the proposed text', rationale: 'clearer this way' },
        decision: 'accepted',
        ...overrides
    }
}

describe('transformHistoryRecord (issue #43 — transforms in history)', () => {
    it('maps an accepted replacement: span as quote, proposal as ONE replace edit, verdict as label', () => {
        const record = transformHistoryRecord(decisionInput())
        expect(record.kind).toBe('transform')
        expect(record.quote).toBe('the original span')
        expect(record.edits).toEqual([{ op: 'replace', text: 'the proposed text' }])
        expect(record.label).toBe('accepted')
        // No observation identity: a decided run is discarded on the spot,
        // so the verbatim-repeat skip must never suppress a real decision.
        expect(record.key).toBeUndefined()
    })

    it('maps a rejected insertion: no quote, an insert edit, the verdict as label', () => {
        const record = transformHistoryRecord(
            decisionInput({ kind: 'insert-at', spanText: null, decision: 'rejected' })
        )
        expect(record.quote).toBe('')
        expect(record.edits).toEqual([{ op: 'insert', text: 'the proposed text' }])
        expect(record.label).toBe('rejected')
    })

    it('joins the action label and the rationale as the text, skipping blanks', () => {
        expect(transformHistoryRecord(decisionInput()).text).toBe('Rephrase\nclearer this way')
        expect(
            transformHistoryRecord(decisionInput({ outcome: { text: 't', rationale: null } })).text
        ).toBe('Rephrase')
        expect(
            transformHistoryRecord(
                decisionInput({ actionLabel: null, outcome: { text: 't', rationale: null } })
            ).text
        ).toBe('')
    })

    it('records through the service with hard clips applied', () => {
        const history = new HistoryService({
            isRecordable: () => true,
            now: () => NOW
        })
        history.record(
            transformHistoryRecord(
                decisionInput({
                    spanText: 'x'.repeat(HISTORY_QUOTE_MAX * 2),
                    outcome: { text: 'y'.repeat(HISTORY_QUOTE_MAX * 2), rationale: null }
                })
            )
        )
        const [only] = history.listForFile('a.md')
        expect(only?.kind).toBe('transform')
        expect(only?.quote.length).toBe(HISTORY_QUOTE_MAX)
        expect(only?.edits[0]?.text.length).toBe(HISTORY_QUOTE_MAX)
    })

    it('never records for a non-recordable note (BR #7/#19 apply to transforms too)', () => {
        const history = new HistoryService({
            isRecordable: () => false,
            now: () => NOW
        })
        history.record(transformHistoryRecord(decisionInput()))
        expect(history.size()).toBe(0)
    })
})
