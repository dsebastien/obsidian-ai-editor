import { describe, expect, it } from 'bun:test'
import type { FindingStatus } from '../services/orchestration/finding-store'
import {
    cycleFinding,
    navigableEditorFindings,
    navigableFindings,
    stepFinding,
    triageCurrent,
    triageStep
} from './finding-navigation'
import type {
    EditorScopedSourceFinding,
    NavigationSourceFinding,
    NavigationTarget
} from './finding-navigation'

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
// navigableEditorFindings — chip-scoped filtering
// ---------------------------------------------------------------------------

function makeEditorFinding(overrides: {
    id: string
    editorId: string
    from?: number
    status?: FindingStatus
    anchored?: boolean
    stale?: boolean
}): EditorScopedSourceFinding {
    return { ...makeFinding(overrides), editorId: overrides.editorId }
}

describe('navigableEditorFindings', () => {
    it('returns an empty list when the editor has no findings', () => {
        expect(navigableEditorFindings([], 'e-1')).toEqual([])
        expect(
            navigableEditorFindings([makeEditorFinding({ id: 'a', editorId: 'other' })], 'e-1')
        ).toEqual([])
    })

    it('keeps only the given editor, ordered by anchor position', () => {
        const result = navigableEditorFindings(
            [
                makeEditorFinding({ id: 'theirs', editorId: 'other', from: 5 }),
                makeEditorFinding({ id: 'late', editorId: 'e-1', from: 40 }),
                makeEditorFinding({ id: 'early', editorId: 'e-1', from: 10 })
            ],
            'e-1'
        )
        expect(result.map((entry) => entry.id)).toEqual(['early', 'late'])
    })

    it('applies the revealability rules within the editor scope', () => {
        const result = navigableEditorFindings(
            [
                makeEditorFinding({ id: 'dismissed', editorId: 'e-1', status: 'dismissed' }),
                makeEditorFinding({ id: 'unanchored', editorId: 'e-1', anchored: false }),
                makeEditorFinding({ id: 'stale', editorId: 'e-1', from: 5, stale: true }),
                makeEditorFinding({ id: 'live', editorId: 'e-1', from: 30 })
            ],
            'e-1'
        )
        expect(result.map((entry) => entry.id)).toEqual(['live'])
    })
})

// ---------------------------------------------------------------------------
// cycleFinding — chip-click cycling with wrap-around
// ---------------------------------------------------------------------------

describe('cycleFinding', () => {
    const ordered = [target('a', 10), target('b', 20), target('c', 30)]

    it('returns null with nothing to cycle', () => {
        expect(cycleFinding([], null)).toBeNull()
        expect(cycleFinding([], 'a')).toBeNull()
    })

    it('starts at the FIRST finding without memory', () => {
        expect(cycleFinding(ordered, null)?.id).toBe('a')
    })

    it('steps to the finding after the remembered one', () => {
        expect(cycleFinding(ordered, 'a')?.id).toBe('b')
        expect(cycleFinding(ordered, 'b')?.id).toBe('c')
    })

    it('wraps from the last finding back to the first', () => {
        expect(cycleFinding(ordered, 'c')?.id).toBe('a')
    })

    it('restarts at the first when the remembered finding left the cycle set', () => {
        // Accepted/dismissed/stale findings drop out of the navigable list.
        expect(cycleFinding(ordered, 'gone')?.id).toBe('a')
    })

    it('cycles a single finding onto itself', () => {
        const single = [target('only', 10)]
        expect(cycleFinding(single, null)?.id).toBe('only')
        expect(cycleFinding(single, 'only')?.id).toBe('only')
    })

    it('visits every finding in anchor order over repeated clicks', () => {
        const visited: string[] = []
        let last: string | null = null
        for (let i = 0; i < 4; i += 1) {
            const next = cycleFinding(ordered, last)
            if (!next) {
                break
            }
            visited.push(next.id)
            last = next.id
        }
        expect(visited).toEqual(['a', 'b', 'c', 'a'])
    })
})

// ---------------------------------------------------------------------------
// triageStep — memory-based stepping (the shared engine)
// ---------------------------------------------------------------------------

describe('triageStep', () => {
    const ordered = [target('a', 10), target('b', 20), target('c', 30)]

    it('returns null with nothing to step through', () => {
        expect(triageStep([], null, 'next')).toBeNull()
        expect(triageStep([], { id: 'a', from: 10 }, 'prev')).toBeNull()
    })

    it('starts at the first (next) / last (prev) target without memory', () => {
        expect(triageStep(ordered, null, 'next')?.id).toBe('a')
        expect(triageStep(ordered, null, 'prev')?.id).toBe('c')
    })

    it('steps to the neighbor of a remembered target in anchor order', () => {
        expect(triageStep(ordered, { id: 'a', from: 10 }, 'next')?.id).toBe('b')
        expect(triageStep(ordered, { id: 'b', from: 20 }, 'next')?.id).toBe('c')
        expect(triageStep(ordered, { id: 'c', from: 30 }, 'prev')?.id).toBe('b')
        expect(triageStep(ordered, { id: 'b', from: 20 }, 'prev')?.id).toBe('a')
    })

    it('wraps around at both ends', () => {
        expect(triageStep(ordered, { id: 'c', from: 30 }, 'next')?.id).toBe('a')
        expect(triageStep(ordered, { id: 'a', from: 10 }, 'prev')?.id).toBe('c')
    })

    it('steps a single target onto itself', () => {
        const single = [target('only', 10)]
        expect(triageStep(single, { id: 'only', from: 10 }, 'next')?.id).toBe('only')
        expect(triageStep(single, { id: 'only', from: 10 }, 'prev')?.id).toBe('only')
    })

    it('auto-advances past an evicted target onto the next remaining one', () => {
        // 'b' was accepted/dismissed: next from its old position lands on
        // the finding that followed it — the triage loop's auto-advance.
        const remaining = [target('a', 10), target('c', 30)]
        expect(triageStep(remaining, { id: 'b', from: 20 }, 'next')?.id).toBe('c')
    })

    it('lands on a target sitting exactly at the evicted position (next)', () => {
        // Two findings started at the same offset; judging one must land on
        // its same-position sibling, not skip past it.
        const remaining = [target('a', 10), target('sibling', 20), target('c', 30)]
        expect(triageStep(remaining, { id: 'gone', from: 20 }, 'next')?.id).toBe('sibling')
    })

    it('wraps to the first when the evicted target was the last one', () => {
        const remaining = [target('a', 10), target('b', 20)]
        expect(triageStep(remaining, { id: 'c', from: 30 }, 'next')?.id).toBe('a')
    })

    it('prev from an evicted target lands on the last one strictly before it', () => {
        const remaining = [target('a', 10), target('c', 30)]
        expect(triageStep(remaining, { id: 'b', from: 20 }, 'prev')?.id).toBe('a')
        // A sibling at the evicted position is NOT "before" it.
        const siblings = [target('sibling', 20), target('c', 30)]
        expect(triageStep(siblings, { id: 'gone', from: 20 }, 'prev')?.id).toBe('c')
    })

    it('wraps to the last when the evicted target was the first one', () => {
        const remaining = [target('b', 20), target('c', 30)]
        expect(triageStep(remaining, { id: 'a', from: 10 }, 'prev')?.id).toBe('c')
    })

    it('interleaves findings from multiple editors purely by anchor order', () => {
        // The triage set spans ALL editors: build it through the real
        // pipeline (navigableFindings over mixed-editor findings) and step
        // across the interleave.
        const mixed = navigableFindings([
            makeEditorFinding({ id: 'hater-1', editorId: 'hater', from: 25 }),
            makeEditorFinding({ id: 'style-1', editorId: 'style', from: 10 }),
            makeEditorFinding({ id: 'hater-2', editorId: 'hater', from: 40 }),
            makeEditorFinding({ id: 'style-2', editorId: 'style', from: 30 })
        ])
        expect(mixed.map((entry) => entry.id)).toEqual(['style-1', 'hater-1', 'style-2', 'hater-2'])
        expect(triageStep(mixed, { id: 'style-1', from: 10 }, 'next')?.id).toBe('hater-1')
        expect(triageStep(mixed, { id: 'hater-1', from: 25 }, 'next')?.id).toBe('style-2')
        expect(triageStep(mixed, { id: 'style-2', from: 30 }, 'prev')?.id).toBe('hater-1')
    })

    it('walks the full loop: next → judge (evict) → auto-advance → wrap', () => {
        // Simulates the triage loop over three findings judged in order.
        let targets = [target('a', 10), target('b', 20), target('c', 30)]
        const visited: string[] = []
        let memory: { id: string; from: number } | null = null
        while (targets.length > 0) {
            const current = triageStep(targets, memory, 'next')
            if (!current) {
                break
            }
            visited.push(current.id)
            memory = { id: current.id, from: current.from }
            targets = targets.filter((entry) => entry.id !== current.id) // judged
        }
        expect(visited).toEqual(['a', 'b', 'c'])
        expect(triageStep(targets, memory, 'next')).toBeNull()
    })
})

// ---------------------------------------------------------------------------
// triageCurrent — cursor validity
// ---------------------------------------------------------------------------

describe('triageCurrent', () => {
    const ordered = [target('a', 10), target('b', 20)]

    it('returns null without memory', () => {
        expect(triageCurrent(ordered, null)).toBeNull()
    })

    it('returns the remembered target while it is still navigable', () => {
        expect(triageCurrent(ordered, { id: 'b', from: 20 })).toEqual(target('b', 20))
    })

    it('returns null once the remembered finding left the set (stale/terminal)', () => {
        expect(triageCurrent(ordered, { id: 'gone', from: 15 })).toBeNull()
        expect(triageCurrent([], { id: 'a', from: 10 })).toBeNull()
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
