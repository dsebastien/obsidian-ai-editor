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

    it('re-binds to a new run token so the cursor survives a re-review (issue #19)', () => {
        const store = new TriageCursorStore()
        store.set('note.md', runA, { id: 'f-1', from: 12 })
        // Carryover keeps finding ids alive across runs: the cursor follows
        // the replacement run instead of resetting the user's triage position.
        expect(store.get('note.md', runB)).toEqual({ id: 'f-1', from: 12 })
        expect(store.has('note.md')).toBe(true)
        // Re-bound for good: it now belongs to the new run.
        expect(store.get('note.md', runB)).toEqual({ id: 'f-1', from: 12 })
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

    it('renameUnder moves cursors with the note — same run token, position intact (issue #47)', () => {
        const store = new TriageCursorStore()
        store.set('Notes/A.md', runA, { id: 'f-1', from: 12 })
        store.set('Notes/Sub/B.md', runA, { id: 'f-2', from: 2 })
        store.set('NotesArchive/C.md', runB, { id: 'f-3', from: 3 })
        store.renameUnder('Notes', 'Moved')
        expect(store.has('Notes/A.md')).toBe(false)
        // The run survives a rename as the same handle, so the token matches.
        expect(store.get('Moved/A.md', runA)).toEqual({ id: 'f-1', from: 12 })
        expect(store.get('Moved/Sub/B.md', runA)).toEqual({ id: 'f-2', from: 2 })
        expect(store.get('NotesArchive/C.md', runB)).toEqual({ id: 'f-3', from: 3 })
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
