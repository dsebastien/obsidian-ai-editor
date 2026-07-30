import type { ReleasePermit, Semaphore } from './semaphore'

/**
 * Admission policy for BACKGROUND work (plan §5.5 / M8, slice 2).
 *
 * Background comment jobs share the ONE plugin-wide concurrency budget
 * (`behavior.maxConcurrentRequests`) with reviews, transforms and threads —
 * anything else would let a parked comment blow past a limit the user set to
 * control cost and rate limits. But sharing a budget FIFO is not enough: the
 * user is present for a review and absent for a comment, so a queue that
 * treats them alike makes the foreground wait on work nobody is watching.
 *
 * ## The policy — decided
 *
 * A background job takes a permit **only when there is free capacity right
 * now, beyond a reserve of one, and nobody is already waiting**:
 *
 * ```
 * admissible  ⇔  gate.queuedCount() === 0  ∧  gate.activeCount() < backgroundConcurrencyLimit(cap)
 * ```
 *
 * Two clauses, two distinct jobs:
 *
 * - **The reserve** (`cap - 1`) keeps a slot the foreground can take without
 *   waiting for anything. Without it, N background jobs fill the pool and the
 *   next Review sits behind a backend call whose whole point was that the user
 *   walked away from it.
 * - **The empty-queue clause** is what actually makes starvation impossible.
 *   `Semaphore` is strictly FIFO, so a background waiter that JOINED the queue
 *   would be admitted ahead of a review queued behind it, reserve or no
 *   reserve. Because the test above only ever passes when the semaphore would
 *   admit synchronously, a background job never occupies a queue position at
 *   all — it waits OUTSIDE the queue and re-checks. Foreground callers keep
 *   using `Semaphore.acquire` directly and are never ordered behind background
 *   work.
 *
 * The trade is deliberate and it costs the background side: a busy vault can
 * leave a comment queued indefinitely. That is the right way round — a job the
 * user parked can wait; the review they are staring at cannot.
 *
 * **At `cap = 1`** the reserve would be the entire budget, i.e. background
 * comments would never run at all. So the limit floors at 1: a background job
 * may take the single permit, but only while nothing is active and nothing is
 * queued, so it can delay a foreground request by at most one job. Refusing to
 * run the feature was the alternative and it is worse — a user who serializes
 * their backend has not asked for margin comments to be dead.
 *
 * Preemption (cancelling a running background job when a review arrives) was
 * rejected: the request is already paid for at the provider, killing it wastes
 * the spend and the wait, and the user would watch a comment die every time
 * they pressed Review.
 */

/** Default re-check interval while a background job waits outside the queue. */
export const DEFAULT_BACKGROUND_POLL_MS = 250

/**
 * How many permits background work may hold, given the plugin-wide cap.
 *
 * Mirrors `Semaphore`'s own clamping (non-finite = unlimited, values below 1
 * clamped) so the two can never disagree about what the cap means.
 */
export function backgroundConcurrencyLimit(cap: number): number {
    if (!Number.isFinite(cap)) {
        return Number.POSITIVE_INFINITY
    }
    const limit = Math.max(1, Math.floor(cap))
    return limit <= 1 ? 1 : limit - 1
}

export interface BackgroundGateDeps {
    /** The SHARED plugin-wide gate — the same instance foreground work uses. */
    readonly gate: Semaphore
    /** Live view of `behavior.maxConcurrentRequests`, read at every check. */
    readonly getLimit: () => number
    /**
     * Timer seam. Services never own real timers here: the Obsidian glue
     * passes `window.setTimeout`/`window.clearTimeout`, specs pass a fake
     * clock so the wait loop is deterministic.
     */
    readonly setTimer: (callback: () => void, ms: number) => number
    readonly clearTimer: (handle: number) => void
    readonly pollIntervalMs?: number
}

/**
 * Acquires plugin-wide permits on behalf of background work, under the policy
 * above. Deliberately NOT a `Semaphore` subclass: it holds no permits of its
 * own and no queue of its own — it decides WHEN to ask the real gate.
 */
export class BackgroundRequestGate {
    private readonly pollIntervalMs: number
    /** Armed re-check intervals, each able to cancel and fail its own waiter. */
    private readonly pauses = new Set<{ cancel: () => void; fail: (reason: Error) => void }>()
    private waiting = 0
    private disposed = false

    constructor(private readonly deps: BackgroundGateDeps) {
        this.pollIntervalMs = Math.max(1, deps.pollIntervalMs ?? DEFAULT_BACKGROUND_POLL_MS)
    }

    /**
     * Whether a background job could take a permit right now. Also the reason
     * a waiting job can be told it is waiting for capacity rather than for a
     * backend.
     */
    hasCapacity(): boolean {
        const { gate } = this.deps
        if (gate.queuedCount() > 0) {
            return false
        }
        return gate.activeCount() < backgroundConcurrencyLimit(this.deps.getLimit())
    }

    /** Background jobs currently parked outside the queue waiting for capacity. */
    waitingCount(): number {
        return this.waiting
    }

    /**
     * Resolves with a release function once background work is admissible.
     * Rejects with the signal's reason if it aborts first — the waiter is not
     * in any queue, so nothing is freed and nothing else is affected.
     *
     * Because admission is only attempted while the semaphore would admit
     * synchronously, the inner `acquire` never queues: the returned permit is
     * always granted in the same tick as the successful check.
     */
    async acquire(signal?: AbortSignal): Promise<ReleasePermit> {
        if (signal?.aborted) {
            throw abortReason(signal)
        }
        this.waiting += 1
        try {
            for (;;) {
                if (this.disposed) {
                    throw new Error(
                        'The plugin unloaded while a background job waited for capacity'
                    )
                }
                if (this.hasCapacity()) {
                    return await this.deps.gate.acquire(signal)
                }
                await this.pause(signal)
            }
        } finally {
            this.waiting -= 1
        }
    }

    /**
     * Plugin unload: every waiter is failed and its timer cleared, and later
     * acquisitions are refused. Clearing the timers without failing the
     * waiters would leave `acquire` promises pending forever — an unloaded
     * plugin holding live promises is exactly the leak `register*` exists to
     * prevent.
     */
    dispose(): void {
        this.disposed = true
        const reason = new Error('The plugin unloaded while a background job waited for capacity')
        for (const pause of [...this.pauses]) {
            pause.cancel()
            pause.fail(reason)
        }
        this.pauses.clear()
    }

    /** One abort-aware re-check interval. */
    private pause(signal?: AbortSignal): Promise<void> {
        return new Promise<void>((resolve, reject) => {
            let handle = 0
            let detach = (): void => undefined
            const entry = {
                cancel: (): void => {
                    this.deps.clearTimer(handle)
                },
                fail: reject
            }
            const finish = (): void => {
                this.pauses.delete(entry)
                detach()
            }
            handle = this.deps.setTimer(() => {
                finish()
                resolve()
            }, this.pollIntervalMs)
            this.pauses.add(entry)
            if (signal) {
                const onAbort = (): void => {
                    entry.cancel()
                    finish()
                    reject(abortReason(signal))
                }
                signal.addEventListener('abort', onAbort)
                detach = () => {
                    signal.removeEventListener('abort', onAbort)
                }
            }
        })
    }
}

function abortReason(signal: AbortSignal): Error {
    const reason: unknown = signal.reason
    if (reason instanceof Error) {
        return reason
    }
    const detail = typeof reason === 'string' ? `: ${reason}` : ''
    return new Error(`Aborted while waiting for background capacity${detail}`)
}
