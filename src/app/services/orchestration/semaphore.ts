/**
 * Counting semaphore with a dynamic limit — the concurrency gate behind
 * `behavior.maxConcurrentRequests`. Pure and dependency-free so the whole
 * admission protocol is spec-covered without any backend or Obsidian glue.
 *
 * Semantics:
 * - FIFO: waiters are admitted strictly in acquisition order. A new
 *   `acquire` never jumps ahead of an already-queued waiter, even when the
 *   limit was raised in between.
 * - Dynamic limit: the limit is read (via `getLimit`) at every admission
 *   decision — each `acquire` and each `release`. A settings change
 *   therefore applies to subsequent admissions; permits already handed out
 *   are never revoked (in-flight requests are not killed by lowering the
 *   limit).
 * - Abort-aware: an aborted waiter leaves the queue immediately and its
 *   `acquire` promise rejects with the signal's reason. It never held a
 *   permit, so nothing is freed and no other waiter is affected.
 * - Double-release safe: each permit's release function is idempotent —
 *   calling it twice frees exactly one permit.
 */

/** Frees the permit returned by `acquire`. Idempotent. */
export type ReleasePermit = () => void

interface Waiter {
    readonly resolve: (release: ReleasePermit) => void
    readonly reject: (reason: unknown) => void
    /** Unhooks the abort listener once the waiter is admitted or aborted. */
    readonly detach: () => void
}

export class Semaphore {
    private active = 0
    private readonly queue: Waiter[] = []

    /**
     * @param getLimit Current maximum number of concurrently held permits.
     * Read at every admission decision; values below 1 are clamped to 1 so a
     * misconfigured limit can never deadlock the queue.
     */
    constructor(private readonly getLimit: () => number) {}

    /** Permits currently held (admitted and not yet released). */
    activeCount(): number {
        return this.active
    }

    /** Waiters queued behind the limit. */
    queuedCount(): number {
        return this.queue.length
    }

    /**
     * Resolves with a release function once a permit is free (immediately
     * when under the limit and nobody is queued ahead). Rejects with the
     * signal's abort reason if `signal` aborts first — the waiter is removed
     * from the queue and consumes nothing.
     */
    acquire(signal?: AbortSignal): Promise<ReleasePermit> {
        if (signal?.aborted) {
            return Promise.reject(abortReason(signal))
        }
        return new Promise<ReleasePermit>((resolve, reject) => {
            let detach = (): void => undefined
            const waiter: Waiter = {
                resolve,
                reject,
                detach: () => detach()
            }
            if (signal) {
                const onAbort = (): void => {
                    const index = this.queue.indexOf(waiter)
                    if (index === -1) {
                        return // already admitted: the permit stands, release() still applies
                    }
                    this.queue.splice(index, 1)
                    detach()
                    reject(abortReason(signal))
                }
                signal.addEventListener('abort', onAbort)
                detach = () => {
                    signal.removeEventListener('abort', onAbort)
                }
            }
            this.queue.push(waiter)
            this.admit()
        })
    }

    /** Admits queued waiters in FIFO order while capacity allows. */
    private admit(): void {
        while (this.queue.length > 0 && this.active < this.currentLimit()) {
            const waiter = this.queue.shift()
            if (!waiter) {
                return
            }
            waiter.detach()
            this.active += 1
            waiter.resolve(this.makeRelease())
        }
    }

    private makeRelease(): ReleasePermit {
        let released = false
        return () => {
            if (released) {
                return // double release must not free a second permit
            }
            released = true
            this.active -= 1
            this.admit()
        }
    }

    private currentLimit(): number {
        const limit = this.getLimit()
        return Number.isFinite(limit) ? Math.max(1, Math.floor(limit)) : Number.POSITIVE_INFINITY
    }
}

function abortReason(signal: AbortSignal): Error {
    // `signal.reason` is a DOMException (an Error) on all supported runtimes;
    // wrap non-Error reasons so rejections always carry an Error.
    const reason: unknown = signal.reason
    if (reason instanceof Error) {
        return reason
    }
    const detail = typeof reason === 'string' ? `: ${reason}` : ''
    return new Error(`Aborted while waiting for a concurrency permit${detail}`)
}
