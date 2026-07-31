import { describe, expect, it } from 'bun:test'
import { MAX_COMMENTS_PER_NOTE, marginCommentSchema } from '../../domain/comments/margin-comment'
import type { MarginComment } from '../../domain/comments/margin-comment'
import {
    backupPathFor,
    commentStoreLoadNotice,
    commentStorePathIn,
    DEFAULT_COMMENT_SAVE_DELAY_MS,
    formatBackupStamp,
    MarginCommentRepository
} from './comment-repository'
import type { CommentStorageAdapter } from './comment-repository'

// A deliberately NON-default config folder: the store path is derived from
// the plugin's own directory, never from a hardcoded `.obsidian`.
const PLUGIN_DIR = 'my-config/plugins/editor-ai-daemons'
const STORE_PATH = `${PLUGIN_DIR}/comments.json`
const TEMP_PATH = `${STORE_PATH}.tmp`

function comment(overrides: Partial<MarginComment> = {}): MarginComment {
    return marginCommentSchema.parse({
        id: 'c1',
        quote: 'the quick brown fox',
        instruction: 'Too cliché?',
        editorId: 'editor-1',
        status: 'done',
        createdAt: 1,
        updatedAt: 2,
        ...overrides
    })
}

/** In-memory filesystem recording every call, with per-operation failure hooks. */
class FakeStorage implements CommentStorageAdapter {
    readonly files = new Map<string, string>()
    readonly calls: string[] = []
    /** Paths whose `rename` must reject (simulates a Windows-style adapter). */
    renameFailsOnto = new Set<string>()
    failWrites = new Set<string>()
    failReads = false

    read(path: string): Promise<string | null> {
        this.calls.push(`read:${path}`)
        if (this.failReads) {
            return Promise.reject(new Error('EACCES'))
        }
        return Promise.resolve(this.files.get(path) ?? null)
    }

    write(path: string, data: string): Promise<void> {
        this.calls.push(`write:${path}`)
        if (this.failWrites.has(path)) {
            return Promise.reject(new Error('ENOSPC'))
        }
        this.files.set(path, data)
        return Promise.resolve()
    }

    exists(path: string): Promise<boolean> {
        return Promise.resolve(this.files.has(path))
    }

    rename(from: string, to: string): Promise<void> {
        this.calls.push(`rename:${from}->${to}`)
        if (this.renameFailsOnto.has(to) && this.files.has(to)) {
            return Promise.reject(new Error('EEXIST'))
        }
        const data = this.files.get(from)
        if (data === undefined) {
            return Promise.reject(new Error('ENOENT'))
        }
        this.files.delete(from)
        this.files.set(to, data)
        return Promise.resolve()
    }

    remove(path: string): Promise<void> {
        this.calls.push(`remove:${path}`)
        this.files.delete(path)
        return Promise.resolve()
    }
}

/**
 * Lets every queued microtask run. Deliberately not a fixed number of
 * `await Promise.resolve()` hops: a write now re-reads the store before
 * overwriting it (see `reconcileExternalChange`), so counting awaits would
 * couple every spec to the number of adapter calls one write makes.
 */
async function settle(): Promise<void> {
    for (let i = 0; i < 12; i++) {
        await Promise.resolve()
    }
}

/** Manual clock: nothing fires until the spec says so. */
class FakeTimers {
    private handle = 0
    private readonly pending = new Map<number, () => void>()

    readonly set = (callback: () => void, _ms: number): number => {
        this.handle += 1
        this.pending.set(this.handle, callback)
        return this.handle
    }

    readonly clear = (handle: number): void => {
        this.pending.delete(handle)
    }

    get armed(): number {
        return this.pending.size
    }

    /** Fires everything armed, in arming order. */
    runAll(): void {
        const callbacks = [...this.pending.values()]
        this.pending.clear()
        for (const callback of callbacks) {
            callback()
        }
    }
}

interface Harness {
    readonly repository: MarginCommentRepository
    readonly storage: FakeStorage
    readonly timers: FakeTimers
    readonly errors: string[]
    readonly stalls: { failures: number; message: string }[]
    readonly merges: { adopted: number; backupPath: string | null }[]
    /** Delays the repository asked for, in order (backoff assertions). */
    readonly delays: number[]
}

function harness(options: { readonly initial?: string; readonly now?: number } = {}): Harness {
    const storage = new FakeStorage()
    if (options.initial !== undefined) {
        storage.files.set(STORE_PATH, options.initial)
    }
    const timers = new FakeTimers()
    const errors: string[] = []
    const stalls: { failures: number; message: string }[] = []
    const merges: { adopted: number; backupPath: string | null }[] = []
    const delays: number[] = []
    const repository = new MarginCommentRepository({
        storage,
        storePath: STORE_PATH,
        setTimer: (callback, ms) => {
            delays.push(ms)
            return timers.set(callback, ms)
        },
        clearTimer: timers.clear,
        now: () => options.now ?? 1_700_000_000_000,
        onWriteError: (message) => errors.push(message),
        onWriteStalled: (failures, message) => stalls.push({ failures, message }),
        onExternalChange: (adopted, backupPath) => merges.push({ adopted, backupPath })
    })
    return { repository, storage, timers, errors, stalls, merges, delays }
}

function storedFile(storage: FakeStorage): { notes: Record<string, MarginComment[]> } {
    return JSON.parse(storage.files.get(STORE_PATH) ?? '{}') as {
        notes: Record<string, MarginComment[]>
    }
}

describe('store paths', () => {
    it('puts the store in the plugin data folder, not next to the notes', () => {
        expect(commentStorePathIn(PLUGIN_DIR)).toEqual(STORE_PATH)
        expect(commentStorePathIn(`${PLUGIN_DIR}/`)).toEqual(STORE_PATH)
    })

    it('names a corruption backup so a second one never overwrites the first', () => {
        expect(backupPathFor(STORE_PATH, '20260730-101500')).toEqual(
            `${PLUGIN_DIR}/comments.corrupt-20260730-101500.json`
        )
        expect(formatBackupStamp(Date.UTC(2026, 6, 30, 10, 15, 0))).toEqual('20260730-101500')
        expect(formatBackupStamp(Date.UTC(2026, 0, 2, 3, 4, 5))).toEqual('20260102-030405')
    })
})

describe('loading', () => {
    it('reports a missing store as missing, not as an error', async () => {
        const { repository } = harness()
        const report = await repository.load()
        expect(report.status).toEqual('missing')
        expect(report.comments).toEqual(0)
        expect(report.readOnly).toBe(false)
        expect(commentStoreLoadNotice(report)).toBeNull()
    })

    it('loads a clean store into memory without writing anything back', async () => {
        const { repository, storage, timers } = harness({
            initial: JSON.stringify({ schemaVersion: 1, notes: { 'A.md': [comment()] } })
        })
        const report = await repository.load()
        expect(report.status).toEqual('ok')
        expect(report.comments).toEqual(1)
        expect(repository.listFor('A.md').map((entry) => entry.id)).toEqual(['c1'])
        expect(timers.armed).toEqual(0)
        expect(storage.calls.filter((call) => call.startsWith('write'))).toEqual([])
    })

    it('reports interrupted jobs so the UI can offer Retry', async () => {
        const { repository } = harness({
            initial: JSON.stringify({
                schemaVersion: 1,
                notes: { 'A.md': [comment({ id: 'x', status: 'running' })] }
            })
        })
        const report = await repository.load()
        expect(report.interrupted).toEqual(['x'])
        expect(repository.listFor('A.md')[0]?.status).toEqual('interrupted')
    })

    it('loads only once — a second call never re-reads the disk', async () => {
        const { repository, storage } = harness({
            initial: JSON.stringify({ schemaVersion: 1, notes: {} })
        })
        await repository.load()
        await repository.load()
        expect(storage.calls.filter((call) => call.startsWith('read'))).toHaveLength(1)
    })
})

describe('corruption recovery', () => {
    it('preserves an unparseable store instead of overwriting it, and still loads', async () => {
        const { repository, storage } = harness({ initial: '{ this is not json' })
        const report = await repository.load()
        expect(report.status).toEqual('unreadable')
        expect(report.readOnly).toBe(false)
        expect(report.backupPath).not.toBeNull()
        expect(storage.files.get(report.backupPath ?? '')).toEqual('{ this is not json')
        // The corrupt file itself is untouched until something writes.
        expect(storage.files.get(STORE_PATH)).toEqual('{ this is not json')
        expect(commentStoreLoadNotice(report)).toContain('could not be read')
    })

    it('preserves a partially-invalid store and rewrites the salvaged form', async () => {
        const { repository, storage, timers } = harness({
            initial: JSON.stringify({
                schemaVersion: 1,
                notes: { 'A.md': [comment({ id: 'good' }), { id: 'broken' }] }
            })
        })
        const report = await repository.load()
        expect(report.status).toEqual('salvaged')
        expect(report.dropped).toEqual(['A.md[1]'])
        expect(storage.files.get(report.backupPath ?? '')).toContain('broken')
        expect(commentStoreLoadNotice(report)).toContain('1 margin comment entry was invalid')
        // A write was scheduled (not performed) so the cleaned store lands
        // only after the original is safely aside.
        expect(timers.armed).toEqual(1)
        timers.runAll()
        await settle()
        expect(storedFile(storage).notes['A.md']?.map((entry) => entry.id)).toEqual(['good'])
    })

    it('refuses to write for the rest of the session when the corrupt file cannot be preserved', async () => {
        const { repository, storage, timers } = harness({ initial: '{ broken' })
        storage.failWrites.add(backupPathFor(STORE_PATH, formatBackupStamp(1_700_000_000_000)))
        const report = await repository.load()
        expect(report.status).toEqual('unreadable')
        expect(report.readOnly).toBe(true)
        expect(repository.isReadOnly()).toBe(true)
        expect(commentStoreLoadNotice(report)).toContain('could not be preserved')

        repository.upsert('A.md', comment())
        expect(timers.armed).toEqual(0)
        await repository.flush()
        expect(storage.files.get(STORE_PATH)).toEqual('{ broken')
    })

    it('never overwrites an existing backup — it takes the next free name', async () => {
        const { repository, storage } = harness({ initial: '{ broken' })
        const taken = backupPathFor(STORE_PATH, formatBackupStamp(1_700_000_000_000))
        storage.files.set(taken, 'an earlier corruption')
        const report = await repository.load()
        expect(report.backupPath).toEqual(taken.replace(/\.json$/, '-1.json'))
        expect(storage.files.get(taken)).toEqual('an earlier corruption')
    })

    it('goes read-only when the store cannot even be read', async () => {
        const { repository, storage } = harness()
        storage.failReads = true
        const report = await repository.load()
        expect(report.status).toEqual('unreadable')
        expect(report.readOnly).toBe(true)
    })
})

describe('write discipline', () => {
    it('debounces: many mutations arm exactly one deferred write', async () => {
        const { repository, storage, timers } = harness()
        await repository.load()
        repository.upsert('A.md', comment({ id: 'a' }))
        repository.upsert('A.md', comment({ id: 'b' }))
        repository.upsert('B.md', comment({ id: 'c' }))
        expect(timers.armed).toEqual(1)
        expect(storage.files.has(STORE_PATH)).toBe(false)

        timers.runAll()
        await settle()
        const file = storedFile(storage)
        expect(Object.keys(file.notes).sort()).toEqual(['A.md', 'B.md'])
        expect(file.notes['A.md']?.map((entry) => entry.id)).toEqual(['a', 'b'])
    })

    it('uses the documented default delay', async () => {
        const storage = new FakeStorage()
        const delays: number[] = []
        const repository = new MarginCommentRepository({
            storage,
            storePath: STORE_PATH,
            setTimer: (_callback, ms) => {
                delays.push(ms)
                return 1
            },
            clearTimer: () => undefined
        })
        await repository.load()
        repository.upsert('A.md', comment())
        expect(delays).toEqual([DEFAULT_COMMENT_SAVE_DELAY_MS])
    })

    it('writes through a temp file and renames it over the store', async () => {
        const { repository, storage, timers } = harness()
        await repository.load()
        repository.upsert('A.md', comment())
        timers.runAll()
        await settle()
        expect(storage.calls).toContain(`write:${TEMP_PATH}`)
        expect(storage.calls).toContain(`rename:${TEMP_PATH}->${STORE_PATH}`)
        expect(storage.files.has(TEMP_PATH)).toBe(false)
        expect(storage.calls.indexOf(`write:${TEMP_PATH}`)).toBeLessThan(
            storage.calls.indexOf(`rename:${TEMP_PATH}->${STORE_PATH}`)
        )
    })

    it('falls back to remove-then-rename when the adapter refuses to replace', async () => {
        const { repository, storage } = harness({
            initial: JSON.stringify({ schemaVersion: 1, notes: {} })
        })
        storage.renameFailsOnto.add(STORE_PATH)
        await repository.load()
        repository.upsert('A.md', comment())
        await repository.flush()
        expect(storage.calls).toContain(`remove:${STORE_PATH}`)
        expect(Object.keys(storedFile(storage).notes)).toEqual(['A.md'])
    })

    it('keeps changes pending when the write fails, and reports why', async () => {
        const { repository, storage, errors } = harness()
        await repository.load()
        storage.failWrites.add(TEMP_PATH)
        repository.upsert('A.md', comment())
        await repository.flush()
        expect(errors).toEqual(['ENOSPC'])
        expect(repository.hasPendingWrite()).toBe(true)

        storage.failWrites.clear()
        await repository.flush()
        expect(Object.keys(storedFile(storage).notes)).toEqual(['A.md'])
    })

    it('flush is a no-op when nothing changed', async () => {
        const { repository, storage } = harness()
        await repository.load()
        await repository.flush()
        expect(storage.calls.filter((call) => call.startsWith('write'))).toEqual([])
    })

    it('coalesces a change made during a write into exactly one follow-up write', async () => {
        const { repository, storage, timers } = harness()
        await repository.load()
        repository.upsert('A.md', comment({ id: 'a' }))
        // Mutate while the first write is still in flight (the fake storage
        // resolves on a microtask, so this lands mid-persist).
        const flushed = repository.flush()
        repository.upsert('A.md', comment({ id: 'b' }))
        repository.upsert('A.md', comment({ id: 'c' }))
        await flushed
        expect(storage.calls.filter((call) => call === `write:${TEMP_PATH}`).length).toEqual(2)
        expect(storedFile(storage).notes['A.md']?.map((entry) => entry.id)).toEqual(['a', 'b', 'c'])
        expect(timers.armed).toBeLessThanOrEqual(1)
    })

    it('dispose cancels the pending write', async () => {
        const { repository, storage, timers } = harness()
        await repository.load()
        repository.upsert('A.md', comment())
        repository.dispose()
        expect(timers.armed).toEqual(0)
        timers.runAll()
        await Promise.resolve()
        expect(storage.files.has(STORE_PATH)).toBe(false)
    })
})

describe('mutations', () => {
    it('replaces a comment in place so a status change keeps its position', async () => {
        const { repository } = harness()
        await repository.load()
        repository.upsert('A.md', comment({ id: 'a' }))
        repository.upsert('A.md', comment({ id: 'b' }))
        repository.upsert('A.md', comment({ id: 'a', status: 'dismissed' }))
        expect(repository.listFor('A.md').map((entry) => [entry.id, entry.status])).toEqual([
            ['a', 'dismissed'],
            ['b', 'done']
        ])
    })

    it('drops the note key when its last comment goes', async () => {
        const { repository } = harness()
        await repository.load()
        repository.upsert('A.md', comment({ id: 'a' }))
        expect(repository.remove('A.md', 'nope')).toBe(false)
        expect(repository.remove('A.md', 'a')).toBe(true)
        expect(repository.notePaths()).toEqual([])
    })
})

describe('rename and delete', () => {
    it('moves a renamed note’s comments with it', async () => {
        const { repository } = harness()
        await repository.load()
        repository.upsert('Drafts/Post.md', comment({ id: 'a' }))
        repository.noteRenamed('Drafts/Post.md', 'Published/Post.md')
        expect(repository.listFor('Drafts/Post.md')).toEqual([])
        expect(repository.listFor('Published/Post.md').map((entry) => entry.id)).toEqual(['a'])
    })

    it('moves every comment under a renamed FOLDER', async () => {
        const { repository } = harness()
        await repository.load()
        repository.upsert('Drafts/One.md', comment({ id: 'a' }))
        repository.upsert('Drafts/Deep/Two.md', comment({ id: 'b' }))
        repository.upsert('Draftsmanship.md', comment({ id: 'c' }))
        repository.noteRenamed('Drafts', 'Archive')
        expect([...repository.notePaths()].sort()).toEqual([
            'Archive/Deep/Two.md',
            'Archive/One.md',
            // A sibling whose path merely STARTS with the folder name is untouched.
            'Draftsmanship.md'
        ])
    })

    it('is a no-op when nothing matches, and never schedules a write for it', async () => {
        const { repository, timers } = harness()
        await repository.load()
        repository.upsert('A.md', comment())
        timers.runAll()
        await settle()
        repository.noteRenamed('Unrelated.md', 'Other.md')
        repository.noteRenamed('A.md', 'A.md')
        expect(timers.armed).toEqual(0)
    })

    it('merges into a destination that already has comments, keeping its own first', async () => {
        const { repository } = harness()
        await repository.load()
        repository.upsert('A.md', comment({ id: 'from-a' }))
        repository.upsert('B.md', comment({ id: 'from-b' }))
        repository.noteRenamed('A.md', 'B.md')
        expect(repository.listFor('B.md').map((entry) => entry.id)).toEqual(['from-b', 'from-a'])
    })

    it('drops a deleted note’s comments (no tombstone — see noteDeleted)', async () => {
        const { repository, storage, timers } = harness()
        await repository.load()
        repository.upsert('A.md', comment({ id: 'a' }))
        repository.upsert('B.md', comment({ id: 'b' }))
        repository.noteDeleted('A.md')
        expect(repository.notePaths()).toEqual(['B.md'])
        timers.runAll()
        await settle()
        expect(Object.keys(storedFile(storage).notes)).toEqual(['B.md'])
    })

    it('drops everything under a deleted folder', async () => {
        const { repository } = harness()
        await repository.load()
        repository.upsert('Drafts/One.md', comment({ id: 'a' }))
        repository.upsert('Drafts/Deep/Two.md', comment({ id: 'b' }))
        repository.upsert('Draftsmanship.md', comment({ id: 'c' }))
        repository.noteDeleted('Drafts')
        expect(repository.notePaths()).toEqual(['Draftsmanship.md'])
    })

    it('deleting an unknown note schedules nothing', async () => {
        const { repository, timers } = harness()
        await repository.load()
        repository.noteDeleted('Nowhere.md')
        expect(timers.armed).toEqual(0)
    })
})

describe('interrupted-write recovery', () => {
    it('adopts the temp file when the store is gone, and says so', async () => {
        const { repository, storage, timers } = harness()
        // Exactly the state a crash between `remove` and `rename` leaves: no
        // store, and the full payload staged in the temp file.
        storage.files.set(
            TEMP_PATH,
            JSON.stringify({ schemaVersion: 1, notes: { 'A.md': [comment({ id: 'parked' })] } })
        )
        const report = await repository.load()
        expect(report.status).toEqual('recovered')
        expect(report.comments).toEqual(1)
        expect(repository.listFor('A.md').map((entry) => entry.id)).toEqual(['parked'])
        // Never silent: a `missing` store renders no Notice, and this is not a
        // first run — it is every durable comment in the vault.
        expect(commentStoreLoadNotice(report)).toContain('interrupted')
        // And the store file is put back.
        expect(timers.armed).toEqual(1)
        timers.runAll()
        await settle()
        expect(storedFile(storage).notes['A.md']?.map((entry) => entry.id)).toEqual(['parked'])
    })

    it('still reports a genuine first run as missing', async () => {
        const { repository } = harness()
        const report = await repository.load()
        expect(report.status).toEqual('missing')
        expect(commentStoreLoadNotice(report)).toBeNull()
    })

    it('preserves an unreadable temp file rather than pretending it is a first run', async () => {
        const { repository, storage } = harness()
        storage.files.set(TEMP_PATH, '{ half-written')
        const report = await repository.load()
        expect(report.status).toEqual('unreadable')
        expect(storage.files.get(report.backupPath ?? '')).toEqual('{ half-written')
    })
})

describe('another writer', () => {
    it('merges a store changed underneath the session instead of reverting it', async () => {
        const { repository, storage, merges } = harness({
            initial: JSON.stringify({ schemaVersion: 1, notes: { 'A.md': [comment({ id: 'a' })] } })
        })
        await repository.load()
        repository.upsert('A.md', comment({ id: 'mine' }))
        // Another device syncs its own copy in while this session holds the
        // whole store in memory.
        storage.files.set(
            STORE_PATH,
            JSON.stringify({
                schemaVersion: 1,
                notes: {
                    'A.md': [comment({ id: 'a' }), comment({ id: 'theirs' })],
                    'B.md': [comment({ id: 'other-note' })]
                }
            })
        )
        await repository.flush()
        expect(merges).toEqual([{ adopted: 2, backupPath: null }])
        expect(storedFile(storage).notes['A.md']?.map((entry) => entry.id)).toEqual([
            'a',
            'mine',
            'theirs'
        ])
        expect(storedFile(storage).notes['B.md']?.map((entry) => entry.id)).toEqual(['other-note'])
    })

    it('never resurrects what THIS session deleted (the file is what we last wrote)', async () => {
        const { repository, storage, merges } = harness()
        await repository.load()
        repository.upsert('A.md', comment({ id: 'a' }))
        repository.upsert('A.md', comment({ id: 'b' }))
        await repository.flush()
        repository.remove('A.md', 'b')
        await repository.flush()
        expect(merges).toEqual([])
        expect(storedFile(storage).notes['A.md']?.map((entry) => entry.id)).toEqual(['a'])
    })

    it('refuses to overwrite a foreign file it cannot read AND cannot preserve', async () => {
        const { repository, storage } = harness()
        await repository.load()
        repository.upsert('A.md', comment({ id: 'a' }))
        storage.files.set(STORE_PATH, '{ not json')
        storage.failWrites.add(
            backupPathFor(STORE_PATH, formatBackupStamp(1_700_000_000_000), 'conflict')
        )
        await repository.flush()
        expect(repository.isReadOnly()).toBe(true)
        expect(storage.files.get(STORE_PATH)).toEqual('{ not json')
    })
})

describe('write failures re-arm themselves', () => {
    it('retries with a backoff instead of waiting for the next mutation', async () => {
        const { repository, storage, timers, delays, errors } = harness()
        await repository.load()
        storage.failWrites.add(TEMP_PATH)
        repository.upsert('A.md', comment())
        timers.runAll()
        await settle()
        expect(errors).toEqual(['ENOSPC'])
        // Re-armed on its own: nothing else in the session has to happen.
        expect(timers.armed).toEqual(1)
        expect(delays).toEqual([DEFAULT_COMMENT_SAVE_DELAY_MS, DEFAULT_COMMENT_SAVE_DELAY_MS])

        timers.runAll()
        await settle()
        expect(delays[2]).toEqual(DEFAULT_COMMENT_SAVE_DELAY_MS * 2)

        storage.failWrites.clear()
        timers.runAll()
        await settle()
        expect(Object.keys(storedFile(storage).notes)).toEqual(['A.md'])
        expect(timers.armed).toEqual(0)
    })

    it('tells the user after repeated failures — not only the log', async () => {
        const { repository, storage, timers, stalls } = harness()
        await repository.load()
        storage.failWrites.add(TEMP_PATH)
        storage.failWrites.add(STORE_PATH)
        repository.upsert('A.md', comment())
        for (let attempt = 0; attempt < 3; attempt++) {
            timers.runAll()
            await settle()
        }
        expect(stalls).toEqual([{ failures: 3, message: 'ENOSPC' }])
    })
})

describe('flush waits for the write that is actually running', () => {
    it('does not resolve before an in-flight write has landed', async () => {
        const { repository, storage, timers } = harness()
        await repository.load()
        repository.upsert('A.md', comment())
        // The debounce fires moments before the unload flush.
        timers.runAll()
        expect(storage.files.has(STORE_PATH)).toBe(false)
        await repository.flush()
        expect(Object.keys(storedFile(storage).notes)).toEqual(['A.md'])
    })
})

describe('rename overflow is reported, never silent', () => {
    it('returns how many comments the cap dropped on a merge', async () => {
        const { repository } = harness()
        await repository.load()
        for (let index = 0; index < MAX_COMMENTS_PER_NOTE; index++) {
            repository.upsert('B.md', comment({ id: `b${index}` }))
        }
        repository.upsert('A.md', comment({ id: 'moved' }))
        expect(repository.noteRenamed('A.md', 'B.md')).toEqual(1)
        expect(repository.noteRenamed('B.md', 'C.md')).toEqual(0)
    })
})
