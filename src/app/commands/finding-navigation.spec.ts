import { describe, expect, it } from 'bun:test'
import type { FindingStatus } from '../services/orchestration/finding-store'
import { navigableFindings, stepFinding } from './finding-navigation'
import type { NavigationSourceFinding, NavigationTarget } from './finding-navigation'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeFinding(overrides: {
    id: string
    from?: number
    to?: number
    status?: FindingStatus
    anchored?: boolean
    stale?: boolean
}): NavigationSourceFinding {
    const from = overrides.from ?? 0
    return {
        id: overrides.id,
        status: overrides.status ?? 'open',
        anchor:
            overrides.anchored === false
                ? null
                : {
                      from,
                      to: overrides.to ?? from + 5,
                      state: overrides.stale === true ? 'stale' : 'anchored'
                  }
    }
}

function target(id: string, from: number, to = from + 5): NavigationTarget {
    return { id, from, to }
}

// ---------------------------------------------------------------------------
// navigableFindings — filtering + ordering
// ---------------------------------------------------------------------------

describe('navigableFindings', () => {
    it('returns an empty list for no findings', () => {
        expect(navigableFindings([])).toEqual([])
    })

    it('keeps open and preview findings with a live anchor', () => {
        const result = navigableFindings([
            makeFinding({ id: 'a', from: 10 }),
            makeFinding({ id: 'b', from: 20, status: 'preview' })
        ])
        expect(result.map((entry) => entry.id)).toEqual(['a', 'b'])
    })

    it('excludes terminal findings', () => {
        const terminal: FindingStatus[] = ['accepted', 'rejected', 'dismissed', 'superseded']
        const findings = terminal.map((status, index) =>
            makeFinding({ id: `t-${status}`, from: index * 10, status })
        )
        expect(navigableFindings(findings)).toEqual([])
    })

    it('excludes unanchored and stale findings', () => {
        const result = navigableFindings([
            makeFinding({ id: 'unanchored', anchored: false }),
            makeFinding({ id: 'stale', from: 5, stale: true }),
            makeFinding({ id: 'live', from: 30 })
        ])
        expect(result.map((entry) => entry.id)).toEqual(['live'])
    })

    it('orders by anchor start regardless of arrival order', () => {
        const result = navigableFindings([
            makeFinding({ id: 'late', from: 40 }),
            makeFinding({ id: 'early', from: 5 }),
            makeFinding({ id: 'middle', from: 20 })
        ])
        expect(result.map((entry) => entry.id)).toEqual(['early', 'middle', 'late'])
    })

    it('breaks position ties by anchor end, then id', () => {
        const result = navigableFindings([
            makeFinding({ id: 'b', from: 10, to: 15 }),
            makeFinding({ id: 'a', from: 10, to: 15 }),
            makeFinding({ id: 'wide', from: 10, to: 30 })
        ])
        expect(result.map((entry) => entry.id)).toEqual(['a', 'b', 'wide'])
    })

    it('carries the anchor range into the target', () => {
        const result = navigableFindings([makeFinding({ id: 'a', from: 7, to: 12 })])
        expect(result).toEqual([{ id: 'a', from: 7, to: 12 }])
    })
})

// ---------------------------------------------------------------------------
// stepFinding — cursor-relative stepping with wrap-around
// ---------------------------------------------------------------------------

describe('stepFinding', () => {
    const ordered = [target('a', 10), target('b', 20), target('c', 30)]

    it('returns null when there is nothing to navigate', () => {
        expect(stepFinding([], null, 'next')).toBeNull()
        expect(stepFinding([], 15, 'prev')).toBeNull()
    })

    it('starts at the first (next) / last (prev) finding without a cursor', () => {
        expect(stepFinding(ordered, null, 'next')?.id).toBe('a')
        expect(stepFinding(ordered, null, 'prev')?.id).toBe('c')
    })

    it('next picks the first finding strictly after the cursor', () => {
        expect(stepFinding(ordered, 15, 'next')?.id).toBe('b')
        expect(stepFinding(ordered, 20, 'next')?.id).toBe('c')
    })

    it('prev picks the last finding strictly before the cursor', () => {
        expect(stepFinding(ordered, 25, 'prev')?.id).toBe('b')
        expect(stepFinding(ordered, 20, 'prev')?.id).toBe('a')
    })

    it('wraps around at the document edges', () => {
        expect(stepFinding(ordered, 30, 'next')?.id).toBe('a')
        expect(stepFinding(ordered, 35, 'next')?.id).toBe('a')
        expect(stepFinding(ordered, 10, 'prev')?.id).toBe('c')
        expect(stepFinding(ordered, 5, 'prev')?.id).toBe('c')
    })

    it('cycles through all findings on repeated next steps', () => {
        const visited: string[] = []
        let cursor: number | null = null
        for (let i = 0; i < 4; i += 1) {
            const next = stepFinding(ordered, cursor, 'next')
            if (!next) {
                break
            }
            visited.push(next.id)
            cursor = next.from // reveal leaves the cursor on the target start
        }
        expect(visited).toEqual(['a', 'b', 'c', 'a'])
    })

    it('steps over a single finding by wrapping onto itself', () => {
        const single = [target('only', 10)]
        expect(stepFinding(single, 10, 'next')?.id).toBe('only')
        expect(stepFinding(single, 10, 'prev')?.id).toBe('only')
    })
})
