import { describe, expect, it } from 'bun:test'
import type { HistoryEntry } from '../../domain/history/history-entry'
import type { CommentStorageAdapter } from '../comments/comment-repository'
import {
    HISTORY_STORE_FORMAT,
    HISTORY_STORE_VERSION,
    HistoryRepository,
    historyStorePathIn
} from './history-repository'

/** In-memory adapter + manual timer, so every path is deterministic. */
function harness(initialFiles: Record<string, string> = {}): {
    files: Map<string, string>
    repo: HistoryRepository
    fire: () => void
    errors: string[]
    corrupt: string[]
} {
    const files = new Map(Object.entries(initialFiles))
    const storage: CommentStorageAdapter = {
        read: (path) => Promise.resolve(files.get(path) ?? null),
        write: (path, data) => {
            files.set(path, data)
            return Promise.resolve()
        },
        exists: (path) => Promise.resolve(files.has(path)),
        rename: (from, to) => {
            const data = files.get(from)
            if (data === undefined) {
                return Promise.reject(new Error('missing'))
            }
            files.delete(from)
            files.set(to, data)
            return Promise.resolve()
        },
        remove: (path) => {
            files.delete(path)
            return Promise.resolve()
        }
    }
    let pending: (() => void) | null = null
    const errors: string[] = []
    const corrupt: string[] = []
    const repo = new HistoryRepository({
        storage,
        storePath: historyStorePathIn('plugins/x'),
        setTimer: (callback) => {
            pending = callback
            return 1
        },
        clearTimer: () => {
            pending = null
        },
        onWriteError: (message) => errors.push(message),
        onCorrupt: (path) => corrupt.push(path),
        now: () => 42
    })
    return {
        files,
        repo,
        fire: () => {
            const callback = pending
            pending = null
            callback?.()
        },
        errors,
        corrupt
    }
}

function entry(id: string): HistoryEntry {
    return {
        id,
        at: 1,
        filePath: 'a.md',
        editorId: 'e',
        editorName: 'E',
        kind: 'finding',
        key: '',
        quote: 'q',
        text: 't',
        edits: [],
        label: ''
    }
}

const STORE = historyStorePathIn('plugins/x')

describe('HistoryRepository (issue #21)', () => {
    it('round-trips entries through a debounced, staged write', async () => {
        const { repo, fire, files } = harness()
        repo.scheduleSave([entry('one')])
        expect(files.size).toBe(0) // debounced: nothing yet
        fire()
        await Promise.resolve()
        await Promise.resolve()
        const text = files.get(STORE)
        expect(text).toBeDefined()
        const parsed = JSON.parse(text ?? '') as {
            format: string
            version: number
            entries: unknown[]
        }
        expect(parsed.format).toBe(HISTORY_STORE_FORMAT)
        expect(parsed.version).toBe(HISTORY_STORE_VERSION)
        expect(parsed.entries).toHaveLength(1)
        expect(files.has(STORE + '.tmp')).toBeFalse() // staged temp swapped away
        expect(await repo.load()).toHaveLength(1)
    })

    it('coalesces saves: only the newest pending snapshot is written', async () => {
        const { repo, fire, files } = harness()
        repo.scheduleSave([entry('one')])
        repo.scheduleSave([entry('one'), entry('two')])
        fire()
        await Promise.resolve()
        await Promise.resolve()
        const parsed = JSON.parse(files.get(STORE) ?? '') as { entries: unknown[] }
        expect(parsed.entries).toHaveLength(2)
    })

    it('recovers a staged temp file when the main file is missing', async () => {
        const staged = JSON.stringify({
            format: HISTORY_STORE_FORMAT,
            version: HISTORY_STORE_VERSION,
            entries: [entry('staged')]
        })
        const { repo } = harness({ [STORE + '.tmp']: staged })
        expect(await repo.load()).toHaveLength(1)
    })

    it('preserves an unreadable store as a backup and starts fresh', async () => {
        const { repo, files, corrupt } = harness({ [STORE]: 'not json{{{' })
        expect(await repo.load()).toEqual([])
        expect(corrupt).toHaveLength(1)
        expect(files.has(STORE)).toBeFalse()
        expect([...files.keys()].some((key) => key.includes('.corrupt-'))).toBeTrue()
    })

    it('flush cancels the debounce and writes now; clear removes the files', async () => {
        const { repo, files } = harness()
        repo.scheduleSave([entry('one')])
        await repo.flush()
        expect(files.has(STORE)).toBeTrue()
        await repo.clear()
        expect(files.size).toBe(0)
    })

    it('drops malformed entries at load instead of failing the store', async () => {
        const text = JSON.stringify({
            format: HISTORY_STORE_FORMAT,
            version: HISTORY_STORE_VERSION,
            entries: [entry('good'), { nonsense: true }, 42]
        })
        const { repo } = harness({ [STORE]: text })
        expect(await repo.load()).toHaveLength(1)
    })
})
