import { describe, expect, it } from 'bun:test'
import { BackgroundRequestGate, backgroundConcurrencyLimit } from './background-gate'
import { Semaphore } from './semaphore'
import type { ReleasePermit } from './semaphore'

/** Deterministic timer seam: nothing fires until the test advances it. */
class FakeClock {
    private next = 1
    private readonly pending = new Map<number, { at: number; callback: () => void }>()
    private now = 0

    readonly setTimer = (callback: () => void, ms: number): number => {
        const handle = this.next++
        this.pending.set(handle, { at: this.now + ms, callback })
        return handle
    }

    readonly clearTimer = (handle: number): void => {
        this.pending.delete(handle)
    }

    pendingCount(): number {
        return this.pending.size
    }

    /** Fires everything due within `ms`, in scheduling order. */
    async advance(ms: number): Promise<void> {
        this.now += ms
        for (const [handle, entry] of [...this.pending]) {
            if (entry.at <= this.now) {
                this.pending.delete(handle)
                entry.callback()
            }
        }
        await Promise.resolve()
        await Promise.resolve()
    }
}

/**
 * Awaits a promise expected to reject and returns its error. Bun's
 * `expect().rejects` is not thenable under the repo's lint rules, and a
 * deliberately-rejected promise must be observed or it trips the
 * unhandled-rejection check.
 */
async function rejection(promise: Promise<unknown>): Promise<Error | null> {
    try {
        await promise
        return null
    } catch (error) {
        return error instanceof Error ? error : new Error(String(error))
    }
}

function setup(cap: number): {
    semaphore: Semaphore
    gate: BackgroundRequestGate
    clock: FakeClock
    limit: { value: number }
} {
    const limit = { value: cap }
    const semaphore = new Semaphore(() => limit.value)
    const clock = new FakeClock()
    const gate = new BackgroundRequestGate({
        gate: semaphore,
        getLimit: () => limit.value,
        setTimer: clock.setTimer,
        clearTimer: clock.clearTimer,
        pollIntervalMs: 10
    })
    return { semaphore, gate, clock, limit }
}

describe('backgroundConcurrencyLimit', () => {
    it('reserves one slot for the foreground', () => {
        expect(backgroundConcurrencyLimit(4)).toEqual(3)
        expect(backgroundConcurrencyLimit(2)).toEqual(1)
    })

    it('floors at one so a serialized backend does not kill the feature', () => {
        expect(backgroundConcurrencyLimit(1)).toEqual(1)
        expect(backgroundConcurrencyLimit(0)).toEqual(1)
        expect(backgroundConcurrencyLimit(-3)).toEqual(1)
    })

    it('is unbounded when the plugin-wide cap is', () => {
        expect(backgroundConcurrencyLimit(Number.POSITIVE_INFINITY)).toEqual(
            Number.POSITIVE_INFINITY
        )
        expect(backgroundConcurrencyLimit(Number.NaN)).toEqual(Number.POSITIVE_INFINITY)
    })

    it('never exceeds the shared cap it is derived from', () => {
        for (const cap of [1, 2, 3, 5, 12]) {
            expect(backgroundConcurrencyLimit(cap)).toBeLessThanOrEqual(cap)
        }
    })
})

describe('background admission', () => {
    it('admits immediately when the pool is idle', async () => {
        const { gate, semaphore } = setup(3)
        expect(gate.hasCapacity()).toBe(true)
        const release = await gate.acquire()
        expect(semaphore.activeCount()).toEqual(1)
        release()
    })

    it('stops one short of the cap, leaving a slot for the foreground', async () => {
        const { gate, semaphore } = setup(3)
        const first = await gate.acquire()
        const second = await gate.acquire()
        expect(semaphore.activeCount()).toEqual(2)
        // Third background job: capacity remains, but it is the reserve.
        expect(gate.hasCapacity()).toBe(false)
        // A FOREGROUND acquire takes the reserved slot without waiting.
        const foreground: ReleasePermit[] = []
        void semaphore.acquire().then((release) => {
            foreground.push(release)
        })
        await Promise.resolve()
        expect(foreground).toHaveLength(1)
        first()
        second()
        foreground[0]?.()
    })

    it('never joins the queue, so a queued foreground request is never overtaken', async () => {
        const { gate, semaphore } = setup(2)
        // Foreground fills the pool.
        const a = await semaphore.acquire()
        const b = await semaphore.acquire()
        // Foreground queues.
        const queuedForeground: ReleasePermit[] = []
        void semaphore.acquire().then((release) => {
            queuedForeground.push(release)
        })
        expect(semaphore.queuedCount()).toEqual(1)

        let backgroundAdmitted = false
        void gate.acquire().then((release) => {
            backgroundAdmitted = true
            release()
        })
        await Promise.resolve()
        // The background job is waiting OUTSIDE the semaphore queue.
        expect(semaphore.queuedCount()).toEqual(1)
        expect(gate.waitingCount()).toEqual(1)
        expect(backgroundAdmitted).toBe(false)

        // Freeing one permit must hand it to the QUEUED FOREGROUND waiter.
        a()
        await Promise.resolve()
        expect(queuedForeground).toHaveLength(1)
        expect(backgroundAdmitted).toBe(false)
        b()
        queuedForeground[0]?.()
    })

    it('admits the background job once the foreground drains', async () => {
        const { gate, semaphore, clock } = setup(2)
        const a = await semaphore.acquire()
        const b = await semaphore.acquire()
        let admitted = false
        void gate.acquire().then((release) => {
            admitted = true
            release()
        })
        await clock.advance(10)
        expect(admitted).toBe(false)
        a()
        b()
        await clock.advance(10)
        expect(admitted).toBe(true)
        expect(gate.waitingCount()).toEqual(0)
    })

    it('re-reads the cap on every check, so raising the limit unblocks a waiter', async () => {
        const { gate, semaphore, clock, limit } = setup(2)
        const held = await semaphore.acquire()
        expect(gate.hasCapacity()).toBe(false) // limit 2 → background limit 1
        let admitted = false
        void gate.acquire().then((release) => {
            admitted = true
            release()
        })
        await clock.advance(10)
        expect(admitted).toBe(false)
        limit.value = 4 // background limit 3, one permit held
        await clock.advance(10)
        expect(admitted).toBe(true)
        held()
    })

    it('lets a background job take the only permit at a cap of one, when nothing else wants it', async () => {
        const { gate, semaphore } = setup(1)
        expect(gate.hasCapacity()).toBe(true)
        const release = await gate.acquire()
        expect(semaphore.activeCount()).toEqual(1)
        // ...and blocks a second background job while it holds it.
        expect(gate.hasCapacity()).toBe(false)
        release()
    })
})

describe('background cancellation', () => {
    it('rejects an already-aborted acquisition without touching the pool', async () => {
        const { gate, semaphore } = setup(3)
        const controller = new AbortController()
        controller.abort()
        expect(await rejection(gate.acquire(controller.signal))).not.toBeNull()
        expect(semaphore.activeCount()).toEqual(0)
    })

    it('drops a waiting job on abort and clears its timer', async () => {
        const { gate, semaphore, clock } = setup(1)
        const held = await semaphore.acquire()
        const controller = new AbortController()
        const pending = gate.acquire(controller.signal)
        await Promise.resolve()
        expect(gate.waitingCount()).toEqual(1)
        expect(clock.pendingCount()).toEqual(1)
        controller.abort()
        expect(await rejection(pending)).not.toBeNull()
        expect(gate.waitingCount()).toEqual(0)
        expect(clock.pendingCount()).toEqual(0)
        expect(semaphore.activeCount()).toEqual(1) // only the foreground permit
        held()
    })

    it('refuses waiters once disposed (plugin unload)', async () => {
        const { gate, semaphore, clock } = setup(1)
        const held = await semaphore.acquire()
        const pending = gate.acquire()
        await Promise.resolve()
        gate.dispose()
        expect(clock.pendingCount()).toEqual(0)
        held()
        await clock.advance(10)
        expect((await rejection(pending))?.message).toMatch(/unloaded/)
        expect((await rejection(gate.acquire()))?.message).toMatch(/unloaded/)
    })
})
