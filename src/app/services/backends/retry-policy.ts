/**
 * Automatic-retry policy (issue #23): which failures are worth another paid
 * request, how many, and after how long. Pure decisions — the executor
 * wrapper (`withAutoRetry` in `backend-executor.ts`) owns the clock and the
 * stream; this module owns the judgement, so every row of the policy table
 * is spec-pinned without a transport.
 *
 * The table (issue #23):
 *
 * | Cause            | Behaviour                                          |
 * |------------------|----------------------------------------------------|
 * | network          | retry, ≤ 2 extra attempts, exponential backoff     |
 * | timeout          | retry ONCE, immediately (the wait already happened)|
 * | rate-limit       | retry ONCE, honouring Retry-After up to a cap      |
 * | invalid-output   | retry ONCE (models are stochastic; a second sample |
 * |                  | often parses) — see #18 for the upstream fixes     |
 * | auth             | never — a wrong key fails identically forever      |
 * | quota            | never — clears only when the user pays             |
 * | truncated        | never — the same ask will hit the same cap         |
 * | cancelled        | never — the user meant it                          |
 * | unknown / rest   | never — retrying blind is spending blind           |
 *
 * Every automatic retry is another PAID request; the counts are deliberately
 * small, and the circuit breaker (`backend-health.ts`) suppresses automatic
 * retries entirely against a backend that keeps failing.
 */

export interface RetryDecision {
    readonly retry: boolean
    readonly delayMs: number
}

const NO_RETRY: RetryDecision = { retry: false, delayMs: 0 }

/** Base delay of the exponential backoff (network failures). */
const BACKOFF_BASE_MS = 1_000
/** Backoff growth per attempt (1 s, 3 s, …). */
const BACKOFF_FACTOR = 3
/** Jitter applied to backoff delays: ±25%, spreading synchronized retries. */
const JITTER = 0.25

/**
 * Longest wait an automatic rate-limit retry may sit out. The wait happens
 * while the editor holds its concurrency permit, so a provider asking for
 * minutes must surface as an error the user sees rather than as a silent
 * stall of the whole request gate.
 */
export const RATE_LIMIT_WAIT_CAP_MS = 30_000
/** Wait used when the provider sent no Retry-After. */
const RATE_LIMIT_DEFAULT_WAIT_MS = 5_000

/**
 * Decision for retrying after a FAILED attempt.
 *
 * @param code the operation error code of the failed attempt
 * @param attempt 1-based index of the attempt that just failed
 * @param retryAfterMs the provider's Retry-After, when it sent one
 * @param random source for jitter (injectable for specs); `Math.random` shape
 */
export function decideRetry(
    code: string,
    attempt: number,
    retryAfterMs: number | null,
    random: () => number
): RetryDecision {
    switch (code) {
        case 'network':
            return attempt <= 2 ? { retry: true, delayMs: backoffMs(attempt, random) } : NO_RETRY
        case 'timeout':
            // The failed attempt already consumed a full timeout window —
            // an extra backoff on top would only lengthen the outage.
            return attempt <= 1 ? { retry: true, delayMs: 0 } : NO_RETRY
        case 'invalid-output':
            return attempt <= 1 ? { retry: true, delayMs: 0 } : NO_RETRY
        case 'rate-limit': {
            if (attempt > 1) {
                return NO_RETRY
            }
            const wait = retryAfterMs ?? RATE_LIMIT_DEFAULT_WAIT_MS
            // A provider asking for longer than the cap is not asking for a
            // retry — it is asking the user to slow down. Surface the error.
            return wait <= RATE_LIMIT_WAIT_CAP_MS ? { retry: true, delayMs: wait } : NO_RETRY
        }
        default:
            return NO_RETRY
    }
}

function backoffMs(attempt: number, random: () => number): number {
    const base = BACKOFF_BASE_MS * BACKOFF_FACTOR ** (attempt - 1)
    const jitter = 1 + (random() * 2 - 1) * JITTER
    return Math.round(base * jitter)
}
