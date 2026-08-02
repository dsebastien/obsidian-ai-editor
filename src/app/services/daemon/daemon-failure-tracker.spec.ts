import { describe, expect, it } from 'bun:test'
import { DaemonFailureTracker, DAEMON_DISABLE_AFTER } from './daemon-failure-tracker'

const failed = [{ status: 'error' }, { status: 'error' }]
const partial = [{ status: 'error' }, { status: 'done' }]
const cancelled = [{ status: 'cancelled' }]

describe('DaemonFailureTracker (issue #23)', () => {
    it('disables after the configured number of consecutive fully-failed refreshes', () => {
        const tracker = new DaemonFailureTracker()
        for (let i = 1; i < DAEMON_DISABLE_AFTER; i++) {
            expect(tracker.record(failed)).toBe('continue')
        }
        expect(tracker.record(failed)).toBe('disable')
    })

    it('a partial success resets the streak — value was delivered', () => {
        const tracker = new DaemonFailureTracker()
        tracker.record(failed)
        tracker.record(failed)
        expect(tracker.record(partial)).toBe('continue')
        // The streak starts over.
        for (let i = 1; i < DAEMON_DISABLE_AFTER; i++) {
            expect(tracker.record(failed)).toBe('continue')
        }
        expect(tracker.record(failed)).toBe('disable')
    })

    it('an all-cancelled refresh neither counts nor resets — the user acted', () => {
        const tracker = new DaemonFailureTracker()
        tracker.record(failed)
        tracker.record(failed)
        expect(tracker.record(cancelled)).toBe('continue')
        expect(tracker.record(failed)).toBe('disable')
    })

    it('an empty refresh is a no-op', () => {
        const tracker = new DaemonFailureTracker()
        expect(tracker.record([])).toBe('continue')
    })

    it('reset() clears the streak (mode toggled)', () => {
        const tracker = new DaemonFailureTracker()
        tracker.record(failed)
        tracker.record(failed)
        tracker.reset()
        for (let i = 1; i < DAEMON_DISABLE_AFTER; i++) {
            expect(tracker.record(failed)).toBe('continue')
        }
        expect(tracker.record(failed)).toBe('disable')
    })

    it('disabling resets the streak so a re-enabled daemon starts clean', () => {
        const tracker = new DaemonFailureTracker()
        for (let i = 1; i <= DAEMON_DISABLE_AFTER; i++) {
            tracker.record(failed)
        }
        expect(tracker.record(failed)).toBe('continue')
    })
})
