import type { HistoryEntry } from '../../domain/history/history-entry'
import type { CommentStorageAdapter } from '../comments/comment-repository'

/**
 * Durable history sidecar (issue #21, level 2): persists the
 * `HistoryService` snapshot to ONE file in the plugin's data folder,
 * with the comment store's write discipline in its SIMPLIFIED form:
 *
 * - debounced, single-flight saves (one write in flight, one queued);
 * - staged atomic-ish writes (temp file, then swap), with temp recovery on
 *   load — an interrupted write never loses more than the debounce window;
 * - an unreadable store is PRESERVED as a timestamped backup and reported,
 *   never overwritten silently.
 *
 * Deliberately NOT carried over from comments: cross-device merge. History
 * is an advisory archive — last writer wins, and the settings copy says the
 * file may sync. Anything stronger would re-implement the comment
 * repository for data that exists to be glanced at.
 *
 * Privacy: entries contain verbatim (clipped) quotes from notes — note
 * content in a plugin file. That is stated in the setting's copy and in
 * `docs/privacy-and-security.md`; the file is excluded from settings export
 * and clearable from the settings tab (issue #21's privacy rules).
 */

/** Store format marker + version (no migrations — no-users policy). */
export const HISTORY_STORE_FORMAT = 'editor-ai-daemons-history'
export const HISTORY_STORE_VERSION = 1

export const HISTORY_FILE_NAME = 'history.json'
const TEMP_SUFFIX = '.tmp'
const SAVE_DEBOUNCE_MS = 2_000

export function historyStorePathIn(dataDir: string): string {
    return `${dataDir}/${HISTORY_FILE_NAME}`
}

interface StoreShape {
    readonly format: string
    readonly version: number
    readonly entries: readonly HistoryEntry[]
}

export interface HistoryRepositoryOptions {
    readonly storage: CommentStorageAdapter
    readonly storePath: string
    readonly setTimer: (callback: () => void, ms: number) => number
    readonly clearTimer: (handle: number) => void
    readonly onWriteError: (message: string) => void
    /** An unreadable store was preserved at `backupPath` and replaced. */
    readonly onCorrupt: (backupPath: string) => void
    readonly now?: () => number
}

export class HistoryRepository {
    private readonly options: HistoryRepositoryOptions
    private timer: number | null = null
    private writing = false
    private queued: string | null = null
    private pending: string | null = null
    /**
     * Bumped by `clear()`: a write that started before the bump must not
     * finish after it — a resumed staged write would silently recreate the
     * file the user was just told is gone (adversarial review 2026-08-02).
     */
    private generation = 0

    constructor(options: HistoryRepositoryOptions) {
        this.options = options
    }

    /**
     * Loads the persisted entries. Recovery order: a temp file left by an
     * interrupted write is adopted when the main file is missing (the write
     * got as far as staging); an unreadable main file is moved aside as a
     * timestamped backup and reported. Never throws.
     */
    async load(): Promise<readonly HistoryEntry[]> {
        const { storage, storePath } = this.options
        const tempPath = storePath + TEMP_SUFFIX
        try {
            let text = await storage.read(storePath)
            if (text === null && (await storage.exists(tempPath))) {
                text = await storage.read(tempPath)
            }
            if (text === null) {
                return []
            }
            const parsed = JSON.parse(text) as Partial<StoreShape>
            if (parsed.format !== HISTORY_STORE_FORMAT || !Array.isArray(parsed.entries)) {
                throw new Error('unrecognized store shape')
            }
            return parsed.entries
                .map(normalizeEntry)
                .filter((entry): entry is HistoryEntry => entry !== null)
        } catch {
            const backupPath = `${storePath}.corrupt-${String(this.options.now?.() ?? Date.now())}`
            try {
                if (await storage.exists(storePath)) {
                    await storage.rename(storePath, backupPath)
                    this.options.onCorrupt(backupPath)
                }
            } catch {
                // The backup itself failed; the next save overwrites — the
                // caller was told nothing loaded either way.
            }
            return []
        }
    }

    /** Schedules a debounced save of the given snapshot (single-flight). */
    scheduleSave(entries: readonly HistoryEntry[]): void {
        const payload: StoreShape = {
            format: HISTORY_STORE_FORMAT,
            version: HISTORY_STORE_VERSION,
            entries
        }
        this.pending = JSON.stringify(payload)
        if (this.timer !== null) {
            return // an armed save picks up the newest pending snapshot
        }
        this.timer = this.options.setTimer(() => {
            this.timer = null
            void this.writePending()
        }, SAVE_DEBOUNCE_MS)
    }

    /** Cancels the debounce and writes NOW (plugin unload). */
    async flush(): Promise<void> {
        if (this.timer !== null) {
            this.options.clearTimer(this.timer)
            this.timer = null
        }
        await this.writePending()
    }

    /** Removes the store file (the settings tab's "Clear history"). */
    async clear(): Promise<void> {
        if (this.timer !== null) {
            this.options.clearTimer(this.timer)
            this.timer = null
        }
        this.pending = null
        this.queued = null
        this.generation += 1
        const { storage, storePath } = this.options
        try {
            if (await storage.exists(storePath)) {
                await storage.remove(storePath)
            }
            if (await storage.exists(storePath + TEMP_SUFFIX)) {
                await storage.remove(storePath + TEMP_SUFFIX)
            }
        } catch (cause) {
            this.options.onWriteError(cause instanceof Error ? cause.message : String(cause))
        }
    }

    private async writePending(): Promise<void> {
        const text = this.pending
        this.pending = null
        if (text === null) {
            return
        }
        if (this.writing) {
            this.queued = text
            return
        }
        this.writing = true
        const generation = this.generation
        try {
            const { storage, storePath } = this.options
            const tempPath = storePath + TEMP_SUFFIX
            // Stage, then swap: a crash mid-write leaves either the old file
            // (temp incomplete) or the staged temp (`load` recovers it) —
            // never a half-written store. A `clear()` racing this write wins:
            // the generation check refuses to recreate a cleared store.
            await storage.write(tempPath, text)
            if (generation !== this.generation) {
                await storage.remove(tempPath)
                return
            }
            if (await storage.exists(storePath)) {
                await storage.remove(storePath)
            }
            if (generation !== this.generation) {
                await storage.remove(tempPath)
                return
            }
            await storage.rename(tempPath, storePath)
        } catch (cause) {
            this.options.onWriteError(cause instanceof Error ? cause.message : String(cause))
        } finally {
            this.writing = false
            const queued = this.queued
            this.queued = null
            if (queued !== null) {
                this.pending = queued
                await this.writePending()
            }
        }
    }
}

const ENTRY_KINDS = new Set(['finding', 'thread', 'scorecard', 'transform'])

/**
 * Normalizes one persisted candidate into a fully-shaped entry, or null.
 * The file syncs and another writer may have produced partial objects — a
 * candidate that passes a shallow shape check but omits `quote`/`edits`/
 * `label` would crash the History rendering (adversarial review
 * 2026-08-02), so every optional-ish field is coerced to its empty form.
 */
function normalizeEntry(candidate: unknown): HistoryEntry | null {
    if (typeof candidate !== 'object' || candidate === null) {
        return null
    }
    const record = candidate as Record<string, unknown>
    if (
        typeof record['id'] !== 'string' ||
        typeof record['at'] !== 'number' ||
        typeof record['filePath'] !== 'string' ||
        typeof record['kind'] !== 'string' ||
        !ENTRY_KINDS.has(record['kind'])
    ) {
        return null
    }
    const text = (value: unknown): string => (typeof value === 'string' ? value : '')
    const edits = Array.isArray(record['edits'])
        ? record['edits']
              .filter(
                  (edit): edit is Record<string, unknown> =>
                      typeof edit === 'object' && edit !== null
              )
              .map((edit) => ({ op: text(edit['op']), text: text(edit['text']) }))
        : []
    return {
        id: record['id'],
        at: record['at'],
        filePath: record['filePath'],
        editorId: text(record['editorId']),
        editorName: text(record['editorName']),
        kind: record['kind'] as HistoryEntry['kind'],
        key: text(record['key']),
        quote: text(record['quote']),
        text: text(record['text']),
        edits,
        label: text(record['label'])
    }
}
