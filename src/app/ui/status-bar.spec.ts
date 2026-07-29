import { describe, expect, it } from 'bun:test'
import { findingCountLabel } from './status-bar'

describe('findingCountLabel', () => {
    it('hides at zero', () => {
        expect(findingCountLabel(0)).toBeNull()
    })

    it('hides for negative counts', () => {
        expect(findingCountLabel(-3)).toBeNull()
    })

    it('hides for non-finite counts', () => {
        expect(findingCountLabel(Number.NaN)).toBeNull()
        expect(findingCountLabel(Number.POSITIVE_INFINITY)).toBeNull()
    })

    it('hides for fractional counts below one', () => {
        expect(findingCountLabel(0.9)).toBeNull()
    })

    it('uses the singular form for one finding', () => {
        expect(findingCountLabel(1)).toBe('1 AI finding')
    })

    it('uses the plural form otherwise', () => {
        expect(findingCountLabel(2)).toBe('2 AI findings')
        expect(findingCountLabel(199)).toBe('199 AI findings')
    })

    it('floors fractional counts', () => {
        expect(findingCountLabel(2.9)).toBe('2 AI findings')
    })
})
