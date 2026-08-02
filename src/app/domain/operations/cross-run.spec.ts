import { describe, expect, it } from 'bun:test'
import type { RawFinding } from './contract'
import { anchorsOverlap, observationIdentity } from './cross-run'

function raw(overrides: Partial<RawFinding> = {}): RawFinding {
    return {
        quote: 'quick brown',
        critique: 'Too generic',
        edits: [{ op: 'replace', text: 'swift auburn' }],
        invalidProposal: false,
        severity: 'suggestion',
        evidence: [],
        ...overrides
    }
}

describe('observationIdentity', () => {
    it('is stable across identical observations', () => {
        expect(observationIdentity(raw())).toEqual(observationIdentity(raw()))
    })

    it('excludes proposal content — a rephrased edit is the same observation (design §9)', () => {
        const a = observationIdentity(raw({ edits: [{ op: 'replace', text: 'swift auburn' }] }))
        const b = observationIdentity(raw({ edits: [{ op: 'delete' }] }))
        const c = observationIdentity(raw({ edits: [] }))
        expect(a).toEqual(b)
        expect(b).toEqual(c)
    })

    it('excludes severity — a re-run that re-grades is still the same observation', () => {
        expect(observationIdentity(raw({ severity: 'warning' }))).toEqual(
            observationIdentity(raw({ severity: 'suggestion' }))
        )
    })

    it('distinguishes quote, critique and every locating hint', () => {
        const base = observationIdentity(raw())
        expect(observationIdentity(raw({ quote: 'lazy dog' }))).not.toEqual(base)
        expect(observationIdentity(raw({ critique: 'Other objection' }))).not.toEqual(base)
        expect(observationIdentity(raw({ occurrence: 2 }))).not.toEqual(base)
        expect(observationIdentity(raw({ prefix: 'The ' }))).not.toEqual(base)
        expect(observationIdentity(raw({ suffix: ' fox' }))).not.toEqual(base)
    })

    it('treats absent and default hints alike', () => {
        expect(observationIdentity(raw({ prefix: undefined, suffix: undefined }))).toEqual(
            observationIdentity(raw({ prefix: '', suffix: '' }))
        )
    })
})

describe('anchorsOverlap', () => {
    it('detects plain overlap and containment', () => {
        expect(anchorsOverlap({ from: 0, to: 10 }, { from: 5, to: 15 })).toBeTrue()
        expect(anchorsOverlap({ from: 5, to: 15 }, { from: 0, to: 10 })).toBeTrue()
        expect(anchorsOverlap({ from: 0, to: 20 }, { from: 5, to: 10 })).toBeTrue()
    })

    it('rejects disjoint and merely touching non-empty spans', () => {
        expect(anchorsOverlap({ from: 0, to: 5 }, { from: 10, to: 15 })).toBeFalse()
        // Touching is adjacency, not overlap — two findings on adjacent
        // sentences are different observations.
        expect(anchorsOverlap({ from: 0, to: 5 }, { from: 5, to: 10 })).toBeFalse()
    })

    it('counts an empty span (insertion point) as overlapping what it touches', () => {
        expect(anchorsOverlap({ from: 5, to: 5 }, { from: 0, to: 10 })).toBeTrue()
        expect(anchorsOverlap({ from: 0, to: 10 }, { from: 10, to: 10 })).toBeTrue()
        expect(anchorsOverlap({ from: 12, to: 12 }, { from: 0, to: 10 })).toBeFalse()
    })
})
