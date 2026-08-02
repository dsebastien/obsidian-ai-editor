/**
 * Per-backend consecutive-failure tracking (issue #23) — the circuit-breaker
 * half of the retry policy.
 *
 * The registry answers one question: "has this backend been failing without a
 * single success in between?". While it reports unhealthy, the executor stops
 * spending AUTOMATIC retries on it (`withAutoRetry`) — the first failure of an
 * attempt surfaces immediately instead of burning the retry budget against a
 * backend that a dead key or an exhausted quota will fail identically forever.
 *
 * Deliberately NOT a gate on running: a manual summon always executes — the
 * user summoning a review IS the "try again" gesture, and it is how they
 * discover the problem is fixed. Any success (manual or automatic) resets the
 * counter. The unattended loop has its own, stronger stop: the daemon
 * auto-disables after repeated failed refreshes (`DaemonController`).
 *
 * One shared instance (`backendHealth`): health is a fact about a backend,
 * not about whichever surface happened to observe the failure.
 */

export interface BackendFailure {
    readonly code: string
    /** Consecutive failures since the last success. */
    readonly count: number
}

/** Consecutive failures after which a backend reads as unhealthy. */
export const UNHEALTHY_AFTER = 3

export class BackendHealthRegistry {
    private readonly failures = new Map<string, { code: string; count: number }>()

    recordSuccess(backendId: string): void {
        this.failures.delete(backendId)
    }

    /** Records one FINAL failure (after any retries; never `cancelled`). */
    recordFailure(backendId: string, code: string): void {
        const entry = this.failures.get(backendId)
        this.failures.set(backendId, { code, count: (entry?.count ?? 0) + 1 })
    }

    /** True after {@link UNHEALTHY_AFTER} consecutive failures. */
    isUnhealthy(backendId: string): boolean {
        return (this.failures.get(backendId)?.count ?? 0) >= UNHEALTHY_AFTER
    }

    /** The most recent failure streak, for messages; null when healthy. */
    lastFailure(backendId: string): BackendFailure | null {
        const entry = this.failures.get(backendId)
        return entry ? { code: entry.code, count: entry.count } : null
    }

    /** Config changed / plugin reload: yesterday's verdicts no longer apply. */
    resetAll(): void {
        this.failures.clear()
    }
}

/** The plugin-wide instance (see module doc). */
export const backendHealth = new BackendHealthRegistry()
