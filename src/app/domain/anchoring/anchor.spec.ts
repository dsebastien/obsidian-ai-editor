import { describe, expect, it } from 'bun:test'
import {
    createAnchor,
    mapAnchorThroughChange,
    mapAnchorThroughChanges,
    verifyPrecondition,
    type TextChange
} from './anchor'

// Document: "0123456789", anchor on "345" → [3, 6)
const anchor = createAnchor(3, 6)

describe('mapAnchorThroughChange', () => {
    it('ignores changes entirely after the anchor', () => {
        const change: TextChange = { from: 7, to: 9, insertedLength: 5 }
        expect(mapAnchorThroughChange(anchor, change)).toEqual(anchor)
    })

    it('shifts for insertions before the anchor', () => {
        const change: TextChange = { from: 1, to: 1, insertedLength: 4 }
        expect(mapAnchorThroughChange(anchor, change)).toEqual({
            from: 7,
            to: 10,
            state: 'anchored'
        })
    })

    it('shifts for deletions before the anchor', () => {
        const change: TextChange = { from: 0, to: 2, insertedLength: 0 }
        expect(mapAnchorThroughChange(anchor, change)).toEqual({
            from: 1,
            to: 4,
            state: 'anchored'
        })
    })

    it('treats an insertion exactly at the anchor start as before (shifts)', () => {
        const change: TextChange = { from: 3, to: 3, insertedLength: 2 }
        expect(mapAnchorThroughChange(anchor, change)).toEqual({
            from: 5,
            to: 8,
            state: 'anchored'
        })
    })

    it('treats an insertion exactly at the anchor end as after (no-op)', () => {
        const change: TextChange = { from: 6, to: 6, insertedLength: 2 }
        expect(mapAnchorThroughChange(anchor, change)).toEqual(anchor)
    })

    it('marks overlapping edits stale', () => {
        const change: TextChange = { from: 4, to: 5, insertedLength: 3 }
        const mapped = mapAnchorThroughChange(anchor, change)
        expect(mapped.state).toEqual('stale')
    })

    it('marks edits spanning the whole anchor stale', () => {
        const change: TextChange = { from: 2, to: 8, insertedLength: 1 }
        const mapped = mapAnchorThroughChange(anchor, change)
        expect(mapped.state).toEqual('stale')
    })

    it('marks a deletion crossing the anchor start stale', () => {
        const change: TextChange = { from: 1, to: 4, insertedLength: 0 }
        const mapped = mapAnchorThroughChange(anchor, change)
        expect(mapped.state).toEqual('stale')
    })

    it('keeps stale state once stale', () => {
        const stale = mapAnchorThroughChange(anchor, { from: 4, to: 5, insertedLength: 0 })
        const after = mapAnchorThroughChange(stale, { from: 0, to: 0, insertedLength: 3 })
        expect(after.state).toEqual('stale')
    })
})

describe('mapAnchorThroughChanges', () => {
    it('applies multiple pre-change-coordinate changes in order', () => {
        // "0123456789" → insert "ab" at 0, delete [7,9) → both before/after anchor
        const changes: TextChange[] = [
            { from: 0, to: 0, insertedLength: 2 },
            { from: 7, to: 9, insertedLength: 0 }
        ]
        const mapped = mapAnchorThroughChanges(anchor, changes)
        expect(mapped).toEqual({ from: 5, to: 8, state: 'anchored' })
    })

    it('handles an empty change list', () => {
        expect(mapAnchorThroughChanges(anchor, [])).toEqual(anchor)
    })

    it('goes stale when any change in the list overlaps', () => {
        const changes: TextChange[] = [
            { from: 0, to: 0, insertedLength: 1 },
            { from: 4, to: 5, insertedLength: 0 }
        ]
        expect(mapAnchorThroughChanges(anchor, changes).state).toEqual('stale')
    })
})

describe('verifyPrecondition', () => {
    const doc = 'The quick brown fox'

    it('accepts when the anchored text matches', () => {
        const a = createAnchor(4, 9)
        expect(verifyPrecondition(doc, a, 'quick')).toBeTrue()
    })

    it('rejects when the text drifted', () => {
        const a = createAnchor(4, 9)
        expect(verifyPrecondition(doc, a, 'slow!')).toBeFalse()
    })

    it('rejects stale anchors regardless of text', () => {
        const stale = { from: 4, to: 9, state: 'stale' as const }
        expect(verifyPrecondition(doc, stale, 'quick')).toBeFalse()
    })

    it('rejects out-of-bounds anchors', () => {
        const a = createAnchor(15, 99)
        expect(verifyPrecondition(doc, a, 'fox')).toBeFalse()
    })
})
