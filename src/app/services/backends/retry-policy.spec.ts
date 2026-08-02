import { describe, expect, it } from 'bun:test'
import { decideRetry, RATE_LIMIT_WAIT_CAP_MS } from './retry-policy'

/** Deterministic "random" for jitter: 0.5 → jitter factor exactly 1. */
const flat = (): number => 0.5

describe('decideRetry (issue #23)', () => {
    it('retries network failures with exponential backoff, at most twice', () => {
        const first = decideRetry('network', 1, null, flat)
        expect(first.retry).toBeTrue()
        expect(first.delayMs).toEqual(1_000)
        const second = decideRetry('network', 2, null, flat)
        expect(second.retry).toBeTrue()
        expect(second.delayMs).toEqual(3_000)
        expect(decideRetry('network', 3, null, flat).retry).toBeFalse()
    })

    it('applies ±25% jitter to network backoff', () => {
        expect(decideRetry('network', 1, null, () => 0).delayMs).toEqual(750)
        expect(decideRetry('network', 1, null, () => 1).delayMs).toEqual(1_250)
    })

    it('retries a timeout once, immediately — the wait already happened', () => {
        expect(decideRetry('timeout', 1, null, flat)).toEqual({ retry: true, delayMs: 0 })
        expect(decideRetry('timeout', 2, null, flat).retry).toBeFalse()
    })

    it('retries invalid-output once — a second sample often parses', () => {
        expect(decideRetry('invalid-output', 1, null, flat)).toEqual({ retry: true, delayMs: 0 })
        expect(decideRetry('invalid-output', 2, null, flat).retry).toBeFalse()
    })

    it('honours Retry-After for a rate limit, up to the cap', () => {
        expect(decideRetry('rate-limit', 1, 12_000, flat)).toEqual({
            retry: true,
            delayMs: 12_000
        })
        // No Retry-After: a short default wait.
        expect(decideRetry('rate-limit', 1, null, flat)).toEqual({ retry: true, delayMs: 5_000 })
        // A provider asking for minutes is not asking for a retry.
        expect(decideRetry('rate-limit', 1, RATE_LIMIT_WAIT_CAP_MS + 1, flat).retry).toBeFalse()
        expect(decideRetry('rate-limit', 2, 1_000, flat).retry).toBeFalse()
    })

    it('never retries auth, quota, truncated, cancelled or unknown', () => {
        for (const code of ['auth', 'quota', 'truncated', 'cancelled', 'unknown', 'whatever']) {
            expect(decideRetry(code, 1, null, flat).retry).toBeFalse()
        }
    })
})
