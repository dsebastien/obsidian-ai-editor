import { describe, expect, it } from 'bun:test'
import { Semaphore } from './semaphore'

/** Tracks a pending acquire without awaiting it. */
function track(promise: Promise<() => void>): {
    promise: Promise<() => void>
    state: () => 'pending' | 'acquired' | 'rejected'
    release: () => void
} {
    let state: 'pending' | 'acquired' | 'rejected' = 'pending'
    let releaseFn: (() => void) | null = null
    const tracked = promise.then(
        (release) => {
            state = 'acquired'
            releaseFn = release
            return release
        },
        (reason: unknown) => {
            state = 'rejected'
            throw reason
        }
    )
    // Rejections are asserted explicitly per test; without this guard a
    // deliberately-aborted waiter would trip Bun's unhandled-rejection check.
    tracked.catch(() => undefined)
    return {
        promise: tracked,
        state: () => state,
        release: () => releaseFn?.()
    }
}

/** Lets already-settled promises run their continuations. */
async function tick(): Promise<void> {
    await Promise.resolve()
    await Promise.resolve()
}

describe('Semaphore admission', () => {
    it('admits immediately while under the limit', async () => {
        const semaphore = new Semaphore(() => 2)
        const first = track(semaphore.acquire())
        const second = track(semaphore.acquire())
        await tick()
        expect(first.state()).toBe('acquired')
        expect(second.state()).toBe('acquired')
        expect(semaphore.activeCount()).toBe(2)
        expect(semaphore.queuedCount()).toBe(0)
    })

    it('queues the N+1th acquisition at limit N and admits it on release (FIFO)', async () => {
        const semaphore = new Semaphore(() => 2)
        const first = track(semaphore.acquire())
        const second = track(semaphore.acquire())
        const third = track(semaphore.acquire())
        const fourth = track(semaphore.acquire())
        await tick()
        expect(third.state()).toBe('pending')
        expect(fourth.state()).toBe('pending')
        expect(semaphore.queuedCount()).toBe(2)

        first.release()
        await tick()
        // FIFO: third (queued first) is admitted, fourth still waits.
        expect(third.state()).toBe('acquired')
        expect(fourth.state()).toBe('pending')
        expect(semaphore.activeCount()).toBe(2)

        second.release()
        await tick()
        expect(fourth.state()).toBe('acquired')
    })

    it('treats a released permit as idempotent — double release frees one slot', async () => {
        const semaphore = new Semaphore(() => 1)
        const first = track(semaphore.acquire())
        const second = track(semaphore.acquire())
        const third = track(semaphore.acquire())
        await tick()

        first.release()
        first.release() // double free attempt
        await tick()
        expect(second.state()).toBe('acquired')
        // Only ONE slot was freed: third must still be queued.
        expect(third.state()).toBe('pending')
        expect(semaphore.activeCount()).toBe(1)
    })

    it('clamps limits below 1 so the queue can never deadlock', async () => {
        const semaphore = new Semaphore(() => 0)
        const first = track(semaphore.acquire())
        await tick()
        expect(first.state()).toBe('acquired')
        expect(semaphore.activeCount()).toBe(1)
    })
})

describe('Semaphore abort handling', () => {
    it('rejects immediately when the signal is already aborted', async () => {
        const semaphore = new Semaphore(() => 1)
        const controller = new AbortController()
        controller.abort()
        let rejected = false
        try {
            await semaphore.acquire(controller.signal)
        } catch {
            rejected = true
        }
        expect(rejected).toBeTrue()
        expect(semaphore.activeCount()).toBe(0)
        expect(semaphore.queuedCount()).toBe(0)
    })

    it('removes an aborted waiter from the queue without consuming a permit', async () => {
        const semaphore = new Semaphore(() => 1)
        const holder = track(semaphore.acquire())
        const abortable = new AbortController()
        const aborted = track(semaphore.acquire(abortable.signal))
        const survivor = track(semaphore.acquire())
        await tick()
        expect(semaphore.queuedCount()).toBe(2)

        abortable.abort()
        await tick()
        expect(aborted.state()).toBe('rejected')
        expect(semaphore.queuedCount()).toBe(1) // waiter left the queue immediately

        holder.release()
        await tick()
        // The permit skipped the aborted waiter and went to the survivor.
        expect(survivor.state()).toBe('acquired')
        expect(semaphore.activeCount()).toBe(1)
    })

    it('ignores an abort that fires after admission — the permit stands', async () => {
        const semaphore = new Semaphore(() => 1)
        const abortable = new AbortController()
        const holder = track(semaphore.acquire(abortable.signal))
        await tick()
        expect(holder.state()).toBe('acquired')

        abortable.abort()
        await tick()
        expect(semaphore.activeCount()).toBe(1) // still held: abort after admission is a no-op

        holder.release()
        expect(semaphore.activeCount()).toBe(0)
    })
})

describe('Semaphore dynamic limit', () => {
    it('applies a raised limit to subsequent admissions, FIFO preserved', async () => {
        let limit = 1
        const semaphore = new Semaphore(() => limit)
        const first = track(semaphore.acquire())
        const second = track(semaphore.acquire())
        await tick()
        expect(second.state()).toBe('pending')

        limit = 3
        // The limit is read at admission decisions (acquire/release): the next
        // acquire drains the queue under the new limit — FIFO, no queue-jumping.
        const third = track(semaphore.acquire())
        await tick()
        expect(second.state()).toBe('acquired')
        expect(third.state()).toBe('acquired')
        expect(semaphore.activeCount()).toBe(3)
        first.release()
        second.release()
        third.release()
    })

    it('never revokes held permits when the limit is lowered', async () => {
        let limit = 3
        const semaphore = new Semaphore(() => limit)
        const held = [
            track(semaphore.acquire()),
            track(semaphore.acquire()),
            track(semaphore.acquire())
        ]
        await tick()
        expect(semaphore.activeCount()).toBe(3)

        limit = 1
        const queued = track(semaphore.acquire())
        await tick()
        expect(queued.state()).toBe('pending') // over the new limit: must wait
        expect(semaphore.activeCount()).toBe(3) // in-flight permits untouched

        // Releases drain down to the new limit before admitting the waiter.
        held[0]?.release()
        await tick()
        expect(queued.state()).toBe('pending') // 2 active >= limit 1
        held[1]?.release()
        await tick()
        expect(queued.state()).toBe('pending') // 1 active >= limit 1
        held[2]?.release()
        await tick()
        expect(queued.state()).toBe('acquired') // 0 active < limit 1
    })
})
