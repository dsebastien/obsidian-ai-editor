import { describe, expect, it } from 'bun:test'
import { TriageCursorStore } from './triage-cursor'

describe('TriageCursorStore', () => {
    const runA = { run: 'a' }
    const runB = { run: 'b' }

    it('returns null for a file without a cursor', () => {
        const store = new TriageCursorStore()
        expect(store.get('note.md', runA)).toBeNull()
        expect(store.has('note.md')).toBe(false)
    })

    it('round-trips a cursor under the same run token', () => {
        const store = new TriageCursorStore()
        store.set('note.md', runA, { id: 'f-1', from: 12 })
        expect(store.get('note.md', runA)).toEqual({ id: 'f-1', from: 12 })
        expect(store.has('note.md')).toBe(true)
    })

    it('evicts on run-token mismatch (run replaced or discarded)', () => {
        const store = new TriageCursorStore()
        store.set('note.md', runA, { id: 'f-1', from: 12 })
        expect(store.get('note.md', runB)).toBeNull()
        // Evicted for good: the original token no longer finds it either.
        expect(store.get('note.md', runA)).toBeNull()
        expect(store.has('note.md')).toBe(false)
    })

    it('keeps files independent', () => {
        const store = new TriageCursorStore()
        store.set('one.md', runA, { id: 'f-1', from: 1 })
        store.set('two.md', runB, { id: 'f-2', from: 2 })
        expect(store.get('one.md', runA)).toEqual({ id: 'f-1', from: 1 })
        expect(store.get('two.md', runB)).toEqual({ id: 'f-2', from: 2 })
        store.clear('one.md')
        expect(store.get('one.md', runA)).toBeNull()
        expect(store.get('two.md', runB)).toEqual({ id: 'f-2', from: 2 })
    })

    it('overwrites the cursor for the same file', () => {
        const store = new TriageCursorStore()
        store.set('note.md', runA, { id: 'f-1', from: 1 })
        store.set('note.md', runA, { id: 'f-2', from: 9 })
        expect(store.get('note.md', runA)).toEqual({ id: 'f-2', from: 9 })
    })

    it('clearUnder sweeps a renamed/deleted folder, sparing prefix look-alikes', () => {
        const store = new TriageCursorStore()
        store.set('Notes/A.md', runA, { id: 'f-1', from: 1 })
        store.set('Notes/Sub/B.md', runA, { id: 'f-2', from: 2 })
        store.set('NotesArchive/C.md', runA, { id: 'f-3', from: 3 })
        store.clearUnder('Notes')
        expect(store.has('Notes/A.md')).toBe(false)
        expect(store.has('Notes/Sub/B.md')).toBe(false)
        expect(store.has('NotesArchive/C.md')).toBe(true)
    })

    it('clearAll empties every file', () => {
        const store = new TriageCursorStore()
        store.set('one.md', runA, { id: 'f-1', from: 1 })
        store.set('two.md', runA, { id: 'f-2', from: 2 })
        store.clearAll()
        expect(store.has('one.md')).toBe(false)
        expect(store.has('two.md')).toBe(false)
    })
})
