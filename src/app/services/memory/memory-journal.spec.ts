import { describe, expect, it } from 'bun:test'
import {
    JOURNAL_CRITIQUE_MAX,
    JOURNAL_QUOTE_MAX,
    JOURNAL_THREAD_MESSAGE_MAX,
    MEMORY_JOURNAL_CAP,
    MemoryJournal
} from './memory-journal'
import type { MemoryJournalEventInput } from './memory-journal'

function makeEvent(overrides: Partial<MemoryJournalEventInput> = {}): MemoryJournalEventInput {
    return {
        editorId: 'editor-1',
        notePath: 'Notes/Test.md',
        quote: 'quick brown',
        critique: 'Too generic',
        severity: 'suggestion',
        decision: 'accepted',
        thread: [],
        ...overrides
    }
}

describe('MemoryJournal.record', () => {
    it('clips quote, critique and thread messages at the door', () => {
        const journal = new MemoryJournal()
        journal.record(
            makeEvent({
                quote: 'q'.repeat(JOURNAL_QUOTE_MAX + 50),
                critique: 'c'.repeat(JOURNAL_CRITIQUE_MAX + 50),
                thread: [
                    { role: 'user', content: 'm'.repeat(JOURNAL_THREAD_MESSAGE_MAX + 50) },
                    { role: 'editor', content: 'short reply' }
                ]
            })
        )
        const [event] = journal.eventsFor('editor-1')
        expect(event?.quote).toHaveLength(JOURNAL_QUOTE_MAX)
        expect(event?.critique).toHaveLength(JOURNAL_CRITIQUE_MAX)
        expect(event?.thread[0]?.content).toHaveLength(JOURNAL_THREAD_MESSAGE_MAX)
        expect(event?.thread[1]?.content).toEqual('short reply')
    })

    it('keeps events under the clip bounds untouched, adding only the seq identity', () => {
        const journal = new MemoryJournal()
        journal.record(makeEvent())
        expect(journal.eventsFor('editor-1')[0]).toEqual({ ...makeEvent(), seq: 1 })
    })

    it('assigns strictly increasing seq identities across editors', () => {
        const journal = new MemoryJournal()
        journal.record(makeEvent({ editorId: 'a' }))
        journal.record(makeEvent({ editorId: 'b' }))
        journal.record(makeEvent({ editorId: 'a' }))
        expect(journal.eventsFor('a').map((event) => event.seq)).toEqual([1, 3])
        expect(journal.eventsFor('b').map((event) => event.seq)).toEqual([2])
    })

    it('caps per editor at the FIFO ring size, dropping the oldest', () => {
        const journal = new MemoryJournal()
        for (let i = 0; i < MEMORY_JOURNAL_CAP + 5; i++) {
            journal.record(makeEvent({ critique: `critique ${i}` }))
        }
        const events = journal.eventsFor('editor-1')
        expect(events).toHaveLength(MEMORY_JOURNAL_CAP)
        // The 5 oldest fell off; the newest survived.
        expect(events[0]?.critique).toEqual('critique 5')
        expect(events[events.length - 1]?.critique).toEqual(`critique ${MEMORY_JOURNAL_CAP + 4}`)
    })
})

describe('MemoryJournal reads and clearing', () => {
    it('isolates editors from each other', () => {
        const journal = new MemoryJournal()
        journal.record(makeEvent({ editorId: 'a' }))
        journal.record(makeEvent({ editorId: 'b' }))
        journal.record(makeEvent({ editorId: 'a' }))
        expect(journal.countFor('a')).toEqual(2)
        expect(journal.countFor('b')).toEqual(1)
        expect(journal.countFor('missing')).toEqual(0)
        journal.clear('a')
        expect(journal.countFor('a')).toEqual(0)
        expect(journal.countFor('b')).toEqual(1)
    })

    it('eventsFor does NOT clear — only clear() does (save-time semantics)', () => {
        const journal = new MemoryJournal()
        journal.record(makeEvent())
        expect(journal.eventsFor('editor-1')).toHaveLength(1)
        // A failed distillation re-reads the same events.
        expect(journal.eventsFor('editor-1')).toHaveLength(1)
        journal.clear('editor-1')
        expect(journal.eventsFor('editor-1')).toHaveLength(0)
    })

    it('eventsFor returns a snapshot, not the live ring', () => {
        const journal = new MemoryJournal()
        journal.record(makeEvent())
        const snapshot = journal.eventsFor('editor-1')
        journal.clear('editor-1')
        expect(snapshot).toHaveLength(1)
    })

    it('clear(upToSeq) consumes only snapshotted events — mid-flight decisions survive', () => {
        const journal = new MemoryJournal()
        journal.record(makeEvent({ critique: 'snapshotted 1' }))
        journal.record(makeEvent({ critique: 'snapshotted 2' }))
        const snapshot = journal.eventsFor('editor-1')
        const highWater = snapshot[snapshot.length - 1]?.seq ?? 0
        // Recorded while the distillation request / review modal was pending.
        journal.record(makeEvent({ critique: 'recorded during flight' }))
        journal.clear('editor-1', highWater)
        const events = journal.eventsFor('editor-1')
        expect(events).toHaveLength(1)
        expect(events[0]?.critique).toEqual('recorded during flight')
    })

    it('a full-ring snapshot eviction cannot eat a mid-flight decision (identity, not count)', () => {
        const journal = new MemoryJournal()
        for (let i = 0; i < MEMORY_JOURNAL_CAP; i++) {
            journal.record(makeEvent({ critique: `snapshotted ${i}` }))
        }
        const snapshot = journal.eventsFor('editor-1')
        expect(snapshot).toHaveLength(MEMORY_JOURNAL_CAP)
        const highWater = snapshot[snapshot.length - 1]?.seq ?? 0
        // Mid-flight decision: the full ring evicts the OLDEST snapshotted
        // event to admit it. A count-based clear of 200 would now remove all
        // 200 remaining entries — including this never-snapshotted one.
        journal.record(makeEvent({ critique: 'recorded during flight' }))
        journal.clear('editor-1', highWater)
        const events = journal.eventsFor('editor-1')
        expect(events).toHaveLength(1)
        expect(events[0]?.critique).toEqual('recorded during flight')
    })

    it('clear(upToSeq) covering the whole ring empties it', () => {
        const journal = new MemoryJournal()
        journal.record(makeEvent())
        journal.clear('editor-1', 999)
        expect(journal.countFor('editor-1')).toEqual(0)
    })

    it('clear(upToSeq) on an unknown editor is a no-op', () => {
        const journal = new MemoryJournal()
        journal.clear('missing', 3)
        expect(journal.countFor('missing')).toEqual(0)
    })
})

describe('MemoryJournal.filesRenamedUnder', () => {
    it('remaps a renamed note across every editor, preserving identity', () => {
        const journal = new MemoryJournal()
        journal.record(makeEvent({ editorId: 'a', notePath: 'Notes/A.md' }))
        journal.record(makeEvent({ editorId: 'b', notePath: 'Notes/A.md' }))
        journal.record(makeEvent({ editorId: 'a', notePath: 'Notes/Other.md' }))
        journal.filesRenamedUnder('Notes/A.md', 'Moved/A.md')
        expect(journal.eventsFor('a').map((event) => event.notePath)).toEqual([
            'Moved/A.md',
            'Notes/Other.md'
        ])
        expect(journal.eventsFor('b').map((event) => event.notePath)).toEqual(['Moved/A.md'])
        // Identity survives the remap — the save-time clear still matches.
        expect(journal.eventsFor('a').map((event) => event.seq)).toEqual([1, 3])
    })

    it('remaps notes under a renamed folder (folder renames emit no per-child events)', () => {
        const journal = new MemoryJournal()
        journal.record(makeEvent({ notePath: 'Notes/Sub/Deep.md' }))
        journal.filesRenamedUnder('Notes', 'Private')
        expect(journal.eventsFor('editor-1')[0]?.notePath).toEqual('Private/Sub/Deep.md')
    })

    it('leaves sibling paths that merely share a prefix alone', () => {
        const journal = new MemoryJournal()
        journal.record(makeEvent({ notePath: 'Notes A/File.md' }))
        journal.filesRenamedUnder('Notes', 'Moved')
        expect(journal.eventsFor('editor-1')[0]?.notePath).toEqual('Notes A/File.md')
    })
})
