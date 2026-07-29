import { describe, expect, it } from 'bun:test'
import { canCancelRun, canReviewSelection } from './command-gates'

describe('canReviewSelection', () => {
    it('allows only an actual selection in an editable, reviewable view', () => {
        expect(canReviewSelection({ editable: true, hasSelection: true, reviewable: true })).toBe(
            true
        )
    })

    it('rejects reading view even with a stale selection', () => {
        expect(canReviewSelection({ editable: false, hasSelection: true, reviewable: true })).toBe(
            false
        )
    })

    it('rejects an empty selection', () => {
        expect(canReviewSelection({ editable: true, hasSelection: false, reviewable: true })).toBe(
            false
        )
    })

    it('rejects a non-reviewable note (excluded or no dispatchable editor)', () => {
        expect(canReviewSelection({ editable: true, hasSelection: true, reviewable: false })).toBe(
            false
        )
    })
})

describe('canCancelRun', () => {
    it('allows cancelling an unsettled run', () => {
        expect(canCancelRun({ hasRun: true, settled: false })).toBe(true)
    })

    it('rejects when no run exists for the active file', () => {
        expect(canCancelRun({ hasRun: false, settled: false })).toBe(false)
    })

    it('rejects a settled run — nothing left to cancel', () => {
        expect(canCancelRun({ hasRun: true, settled: true })).toBe(false)
    })
})
