import { describe, expect, it } from 'bun:test'
import { newlyStaleIds, staleIds } from './stale-diff'
import type { StaleDiffFinding } from './stale-diff'

function anchored(id: string): StaleDiffFinding {
    return { id, anchor: { state: 'anchored' } }
}

function stale(id: string): StaleDiffFinding {
    return { id, anchor: { state: 'stale' } }
}

function unanchored(id: string): StaleDiffFinding {
    return { id, anchor: null }
}

describe('staleIds', () => {
    it('is empty for no findings', () => {
        expect(staleIds([]).size).toBe(0)
    })

    it('collects only stale anchors', () => {
        const ids = staleIds([anchored('a'), stale('b'), unanchored('c'), stale('d')])
        expect([...ids].sort()).toEqual(['b', 'd'])
    })

    it('never treats unanchored findings as stale', () => {
        expect(staleIds([unanchored('a')]).size).toBe(0)
    })
})

describe('newlyStaleIds', () => {
    it('returns findings that transitioned to stale', () => {
        const before = staleIds([anchored('a'), anchored('b')])
        expect(newlyStaleIds(before, [stale('a'), anchored('b')])).toEqual(['a'])
    })

    it('excludes findings that were already stale before the batch', () => {
        const before = staleIds([stale('a'), anchored('b')])
        expect(newlyStaleIds(before, [stale('a'), stale('b')])).toEqual(['b'])
    })

    it('returns nothing when no anchor changed state', () => {
        const before = staleIds([anchored('a'), stale('b'), unanchored('c')])
        expect(newlyStaleIds(before, [anchored('a'), stale('b'), unanchored('c')])).toEqual([])
    })

    it('ignores unanchored findings after the batch', () => {
        expect(newlyStaleIds(new Set(), [unanchored('a')])).toEqual([])
    })

    it('reports a finding unknown before the batch when it arrives stale', () => {
        // A late finding replayed onto the edit history can enter stale; it
        // was never in the before set, so it belongs in the payload.
        expect(newlyStaleIds(new Set(), [stale('late')])).toEqual(['late'])
    })

    it('preserves the arrival order of `after`', () => {
        const before = new Set<string>()
        expect(newlyStaleIds(before, [stale('z'), anchored('m'), stale('a')])).toEqual(['z', 'a'])
    })
})
