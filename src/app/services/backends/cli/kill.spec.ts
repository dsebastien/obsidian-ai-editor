import { describe, expect, it } from 'bun:test'
import { runKillEscalation } from './kill'
import type { KillEscalationInput } from './kill'

/**
 * The escalation state machine, driven by injected liveness so every branch
 * is deterministic. The real POSIX process-group path is exercised end to end
 * in `spawn.spec.ts` against a sleeping grandchild.
 */

interface Scenario {
    /** Liveness answers, consumed in order; the last one repeats. */
    readonly alive: readonly boolean[]
    readonly sent: string[]
    readonly input: KillEscalationInput
}

function scenario(alive: readonly boolean[]): Scenario {
    const sent: string[] = []
    let index = 0
    const input: KillEscalationInput = {
        send: (signal) => {
            sent.push(signal)
            return Promise.resolve()
        },
        isAlive: () => {
            const value = alive[Math.min(index, alive.length - 1)] ?? false
            index += 1
            return value
        },
        graceMs: 100,
        pollMs: 25,
        sleep: () => Promise.resolve()
    }
    return { alive, sent, input }
}

describe('runKillEscalation', () => {
    it('never signals a process that is already gone', async () => {
        const { sent, input } = scenario([false])
        expect(await runKillEscalation(input)).toBe('already-gone')
        expect(sent).toEqual([])
    })

    it('stops at the graceful signal when the tree dies', async () => {
        const { sent, input } = scenario([true, false])
        expect(await runKillEscalation(input)).toBe('terminated')
        expect(sent).toEqual(['graceful'])
    })

    it('escalates when the tool ignores the graceful signal', async () => {
        // Alive through the whole first grace window, gone in the second.
        const { sent, input } = scenario([true, true, true, true, true, true, false])
        expect(await runKillEscalation(input)).toBe('force-terminated')
        expect(sent).toEqual(['graceful', 'forced'])
    })

    it('reports a tree that survived both signals instead of claiming success', async () => {
        const { sent, input } = scenario([true])
        expect(await runKillEscalation(input)).toBe('survived')
        expect(sent).toEqual(['graceful', 'forced'])
    })

    it('gives the tool the whole grace period before forcing', async () => {
        const slept: number[] = []
        let calls = 0
        const input: KillEscalationInput = {
            send: () => Promise.resolve(),
            isAlive: () => {
                calls += 1
                // Alive for the first window, dead once forced.
                return calls <= 6
            },
            graceMs: 100,
            pollMs: 25,
            sleep: (ms) => {
                slept.push(ms)
                return Promise.resolve()
            }
        }
        expect(await runKillEscalation(input)).toBe('force-terminated')
        expect(slept.slice(0, 4)).toEqual([25, 25, 25, 25])
    })

    it('never waits longer than the grace period per stage', async () => {
        const slept: number[] = []
        const input: KillEscalationInput = {
            send: () => Promise.resolve(),
            isAlive: () => true,
            graceMs: 60,
            pollMs: 25,
            sleep: (ms) => {
                slept.push(ms)
                return Promise.resolve()
            }
        }
        await runKillEscalation(input)
        // 25 + 25 + 10 per stage — the last step is clamped to the budget.
        expect(slept).toEqual([25, 25, 10, 25, 25, 10])
    })
})
