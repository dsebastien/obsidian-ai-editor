import { describe, expect, it } from 'bun:test'
import { notifyAfterSettled } from './memory-review-modal'

/**
 * In-flight-guard discipline of the memory review modal (adversarial review
 * 2026-08-07): closing the modal DURING a slow save must not release the
 * command's per-editor guard (`onDone`) while the save — and the journal
 * clear inside it — is still landing, or a second paid distillation could
 * launch over the same events.
 */
describe('notifyAfterSettled', () => {
    it('notifies immediately when no save is pending', () => {
        let notified = 0
        notifyAfterSettled(null, () => {
            notified += 1
        })
        expect(notified).toEqual(1)
    })

    it('tolerates a missing notify callback', () => {
        expect(() => notifyAfterSettled(null, undefined)).not.toThrow()
    })

    it('defers notification until an in-flight save resolves', async () => {
        let resolveSave: () => void = () => undefined
        const pending = new Promise<void>((resolve) => {
            resolveSave = resolve
        })
        let notified = 0
        notifyAfterSettled(pending, () => {
            notified += 1
        })
        // The modal closed, but the save has not settled: guard still held.
        await Promise.resolve()
        expect(notified).toEqual(0)
        resolveSave()
        await pending
        await Promise.resolve()
        expect(notified).toEqual(1)
    })

    it('notifies after a FAILED save too (the guard must not leak)', async () => {
        let rejectSave: (error: Error) => void = () => undefined
        const pending = new Promise<void>((_resolve, reject) => {
            rejectSave = reject
        })
        // The save path awaits and reports this rejection itself.
        pending.catch(() => undefined)
        let notified = 0
        notifyAfterSettled(pending, () => {
            notified += 1
        })
        rejectSave(new Error('disk full'))
        await Promise.resolve()
        await Promise.resolve()
        expect(notified).toEqual(1)
    })
})
