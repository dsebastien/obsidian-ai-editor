import {
    COMMENT_STORE_SCHEMA_VERSION,
    loadCommentStore,
    MAX_COMMENTS_PER_NOTE
} from '../../domain/comments/margin-comment'
import type { CommentStore, MarginComment } from '../../domain/comments/margin-comment'

/**
 * The durable margin-comment store (plan §5.5 / M8).
 *
 * ## Where it lives — decided
 *
 * ONE JSON file in the plugin's own data folder
 * (`<vault>/<configDir>/plugins/<plugin-id>/comments.json`), keyed by
 * vault-relative note path.
 *
 * The alternative — a sidecar file next to each note (`My note.comments.json`,
 * or a frontmatter block) — was rejected:
 *
 * - **The vault stays clean.** Not polluting the user's notes is a core
 *   promise of this plugin; it writes nothing into a note without a visible
 *   diff and an Accept. Scattering machine-written files through their folders
 *   is the same violation with extra steps: they show up in searches, in the
 *   file explorer, in every "all files" query, and in Git diffs of a vault the
 *   user versions.
 * - **Sync conflicts land where they hurt least.** Obsidian Sync, Syncthing
 *   and iCloud all conflict-copy per file. A conflicted `comments.json` costs
 *   plugin state; a conflicted sidecar next to a note pollutes the user's own
 *   working folder, and a frontmatter block would conflict the NOTE itself —
 *   turning a background comment into a merge conflict on the text the user is
 *   writing.
 * - **One file, one write.** A margin comment is triage state, not content:
 *   rename handling, corruption recovery and atomic writes are one code path
 *   instead of N, and re-anchoring reads the note text the editor already has
 *   open.
 *
 * It is deliberately NOT `data.json`: settings hold API keys and are rewritten
 * on every settings change, and comment traffic must not ride along with
 * either.
 *
 * ## Write discipline
 *
 * Debounced (never per keystroke, never per status tick), coalesced (at most
 * one write in flight, at most one queued behind it), and atomic-ish: the
 * payload goes to a temp file first and is renamed over the store, so a crash
 * mid-write leaves the previous store intact rather than a truncated one. When
 * the adapter refuses the rename the repository degrades in explicit steps
 * rather than silently — see `writeStoreFile`.
 *
 * ## Corruption
 *
 * A store that cannot be read is PRESERVED (copied aside), never overwritten,
 * and the load reports what happened so the user can be told. If the copy
 * itself fails, the repository refuses to write for the rest of the session:
 * losing the file is worse than losing the session's comments.
 */

/**
 * `loadCommentStore`'s result widened with the "not even JSON" case, where
 * there is no store at all to fall back on.
 */
interface LoadedStore {
    readonly store: CommentStore | null
    readonly dropped: readonly string[]
    readonly unreadable: boolean
    readonly interrupted: readonly string[]
}

/** Filename of the sidecar store inside the plugin data folder. */
export const COMMENT_STORE_FILENAME = 'comments.json'

/** Suffix of the temp file the atomic write stages through. */
const TEMP_SUFFIX = '.tmp'

/** Default debounce for deferred writes. */
export const DEFAULT_COMMENT_SAVE_DELAY_MS = 2_000

/** Vault-relative path of the store inside a plugin data folder. */
export function commentStorePathIn(pluginDir: string): string {
    const dir = pluginDir.replace(/\/+$/, '')
    return `${dir}/${COMMENT_STORE_FILENAME}`
}

/**
 * Where a corrupt store is preserved. Timestamped so a second corruption never
 * overwrites the evidence of the first, and suffixed `.json` so the user can
 * open it in anything.
 */
export function backupPathFor(storePath: string, stamp: string): string {
    const base = storePath.replace(/\.json$/, '')
    return `${base}.corrupt-${stamp}.json`
}

/** `YYYYMMDD-HHMMSS` in UTC — sortable, filename-safe, no locale surprises. */
export function formatBackupStamp(epochMs: number): string {
    const date = new Date(epochMs)
    const pad = (value: number, width = 2): string => String(value).padStart(width, '0')
    return [
        `${pad(date.getUTCFullYear(), 4)}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}`,
        `${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}`
    ].join('-')
}

/**
 * The filesystem seam. Deliberately tiny and Obsidian-free so every rule above
 * is spec-covered without a vault; `ui/comment-store.ts` implements it over
 * `Vault.adapter`.
 */
export interface CommentStorageAdapter {
    /** File contents, or `null` when it does not exist. */
    read(path: string): Promise<string | null>
    write(path: string, data: string): Promise<void>
    exists(path: string): Promise<boolean>
    /** May reject when the destination exists — the caller handles that. */
    rename(from: string, to: string): Promise<void>
    remove(path: string): Promise<void>
}

/** What a load did, in terms the user can be told about. */
export type CommentStoreLoadStatus =
    /** No store yet (first run, or nothing ever commented). */
    | 'missing'
    | 'ok'
    /** Read, but entries were left out — the file was preserved. */
    | 'salvaged'
    /** Not readable at all — the file was preserved and the store starts empty. */
    | 'unreadable'

export interface CommentStoreLoadReport {
    readonly status: CommentStoreLoadStatus
    /** Comments successfully loaded. */
    readonly comments: number
    /** Entries left out, as `path` or `path[index]`. */
    readonly dropped: readonly string[]
    /** Ids whose in-flight status became `interrupted` (plan M8). */
    readonly interrupted: readonly string[]
    /** Where the previous file was preserved, when it had to be. */
    readonly backupPath: string | null
    /**
     * True when writes are disabled for the rest of the session because a
     * corrupt file could NOT be preserved. Losing the user's parked questions
     * is worse than losing this session's.
     */
    readonly readOnly: boolean
}

export interface CommentRepositoryDeps {
    readonly storage: CommentStorageAdapter
    /** Vault-relative path of the store file (see `commentStorePathIn`). */
    readonly storePath: string
    /**
     * Timer seam. Services in this codebase never own real timers — the
     * Obsidian glue passes `window.setTimeout`/`window.clearTimeout`, specs
     * pass a fake clock so the debounce is deterministic.
     */
    readonly setTimer: (callback: () => void, ms: number) => number
    readonly clearTimer: (handle: number) => void
    readonly now?: () => number
    readonly saveDelayMs?: number
    /** Reports a write failure (the glue logs it). */
    readonly onWriteError?: (message: string) => void
}

/**
 * In-memory owner of the durable comments, with a debounced writer behind it.
 *
 * Reads are synchronous by design: the margin renders on every note open and
 * every refresh cycle, so it must never await disk. `load()` fills the memory
 * once at startup; everything after that mutates memory and schedules a write.
 */
export class MarginCommentRepository {
    private readonly deps: CommentRepositoryDeps
    private readonly notes = new Map<string, MarginComment[]>()
    private readonly saveDelayMs: number
    private readonly now: () => number

    private loaded = false
    private readOnly = false
    private dirty = false
    private timer: number | null = null
    private writing = false
    /** A change landed while a write was in flight: exactly one follow-up. */
    private rewriteQueued = false
    private disposed = false

    constructor(deps: CommentRepositoryDeps) {
        this.deps = deps
        this.saveDelayMs = deps.saveDelayMs ?? DEFAULT_COMMENT_SAVE_DELAY_MS
        this.now = deps.now ?? ((): number => Date.now())
    }

    /**
     * Reads the store from disk exactly once. Never throws: an unreadable
     * store degrades to an empty in-memory store plus a report, because a
     * broken sidecar must never stop the plugin from loading.
     */
    async load(): Promise<CommentStoreLoadReport> {
        if (this.loaded) {
            return this.report('ok', 0, [], [], null)
        }
        this.loaded = true
        let text: string | null = null
        try {
            text = await this.deps.storage.read(this.deps.storePath)
        } catch {
            // Unreadable for filesystem reasons (permissions, a directory in
            // its place): nothing to preserve — we hold no bytes — but the
            // session must not write over whatever is there.
            this.readOnly = true
            return this.report('unreadable', 0, [], [], null)
        }
        if (text === null) {
            return this.report('missing', 0, [], [], null)
        }

        // Not even JSON: nothing to salvage, and `loadCommentStore` is never
        // asked to interpret garbage it was not given.
        let loaded: LoadedStore
        try {
            loaded = loadCommentStore(JSON.parse(text))
        } catch {
            loaded = { store: null, dropped: [], unreadable: true, interrupted: [] }
        }

        if (loaded.store) {
            for (const [path, comments] of Object.entries(loaded.store.notes)) {
                this.notes.set(path, [...comments])
            }
        }

        if (!loaded.unreadable && loaded.dropped.length === 0) {
            return this.report('ok', this.count(), [], loaded.interrupted, null)
        }

        // The file on disk holds data this store does not. Preserve it BEFORE
        // anything can write, and if that is impossible, never write at all.
        const backupPath = await this.preserve(text)
        if (backupPath === null) {
            this.readOnly = true
        } else if (loaded.store) {
            // The salvaged store is rewritten in its cleaned form — but only
            // now that the original is safely aside.
            this.markDirty()
        }
        return this.report(
            loaded.unreadable ? 'unreadable' : 'salvaged',
            this.count(),
            loaded.dropped,
            loaded.interrupted,
            backupPath
        )
    }

    /** Comments stored for a note, in stored order. Empty when there are none. */
    listFor(notePath: string): readonly MarginComment[] {
        return this.notes.get(notePath) ?? []
    }

    /** Every note path that currently has comments. */
    notePaths(): readonly string[] {
        return [...this.notes.keys()]
    }

    /** Total comments across the vault. */
    count(): number {
        let total = 0
        for (const comments of this.notes.values()) {
            total += comments.length
        }
        return total
    }

    /**
     * Inserts a comment, or replaces the one with the same id in place (so a
     * status change keeps its position in the margin). Refused when the note
     * is at the cap — silently dropping the user's question would be worse
     * than telling the caller no.
     */
    upsert(notePath: string, comment: MarginComment): boolean {
        const comments = this.notes.get(notePath) ?? []
        const index = comments.findIndex((entry) => entry.id === comment.id)
        if (index === -1) {
            if (comments.length >= MAX_COMMENTS_PER_NOTE) {
                return false
            }
            comments.push(comment)
        } else {
            comments[index] = comment
        }
        this.notes.set(notePath, comments)
        this.markDirty()
        return true
    }

    /** Removes one comment; `false` when it was not there. */
    remove(notePath: string, commentId: string): boolean {
        const comments = this.notes.get(notePath)
        if (!comments) {
            return false
        }
        const next = comments.filter((entry) => entry.id !== commentId)
        if (next.length === comments.length) {
            return false
        }
        if (next.length === 0) {
            this.notes.delete(notePath)
        } else {
            this.notes.set(notePath, next)
        }
        this.markDirty()
        return true
    }

    /**
     * Follows a vault rename. Handles BOTH shapes without asking which one
     * Obsidian fired:
     *
     * - the note itself (`A.md` → `B.md`), and
     * - a FOLDER (`Drafts` → `Archive`), which moves every key underneath it.
     *
     * Doing both is idempotent — whichever event the vault emits, the other
     * pass finds nothing to do — and a folder rename that emitted no per-file
     * events would otherwise orphan every comment in it at once.
     *
     * A destination that already has comments keeps its own first and appends
     * the incoming ones (a sync-merge artifact, not a normal path); the
     * per-note cap still holds.
     */
    noteRenamed(oldPath: string, newPath: string): void {
        if (oldPath === newPath) {
            return
        }
        const moves: [string, string][] = []
        const prefix = `${oldPath}/`
        for (const path of this.notes.keys()) {
            if (path === oldPath) {
                moves.push([path, newPath])
            } else if (path.startsWith(prefix)) {
                moves.push([path, `${newPath}/${path.slice(prefix.length)}`])
            }
        }
        if (moves.length === 0) {
            return
        }
        for (const [from, to] of moves) {
            const moved = this.notes.get(from) ?? []
            this.notes.delete(from)
            const existing = this.notes.get(to) ?? []
            this.notes.set(to, [...existing, ...moved].slice(0, MAX_COMMENTS_PER_NOTE))
        }
        this.markDirty()
    }

    /**
     * Follows a vault delete: the note's comments go with it.
     *
     * **Decided, not defaulted.** The alternative is a tombstone that survives
     * the delete and reattaches if a note reappears at that path. Rejected:
     * the only thing a tombstone can key on is the PATH, so a note later
     * created at `Drafts/Post.md` would silently inherit comments written
     * about a different, deleted note — attaching a stranger's critique to the
     * user's text, which is exactly the failure mode this plugin's anchoring
     * rules exist to prevent (Business Rules #3/#4). It also grows without
     * bound, and buys back only the narrow case of a delete the user regrets:
     * Obsidian's own file recovery restores the note TEXT, never plugin state,
     * so the promise a tombstone appears to make is one it cannot keep.
     *
     * Also handles a FOLDER delete (same prefix reasoning as `noteRenamed`).
     */
    noteDeleted(path: string): void {
        const prefix = `${path}/`
        let changed = false
        for (const key of [...this.notes.keys()]) {
            if (key === path || key.startsWith(prefix)) {
                this.notes.delete(key)
                changed = true
            }
        }
        if (changed) {
            this.markDirty()
        }
    }

    /** Whether a deferred write is armed or in flight. */
    hasPendingWrite(): boolean {
        return this.timer !== null || this.writing || this.rewriteQueued || this.dirty
    }

    /** Whether writes are disabled for this session (unpreservable corruption). */
    isReadOnly(): boolean {
        return this.readOnly
    }

    /**
     * Writes immediately if anything is pending. Called on unload — which is
     * synchronous in Obsidian, so the caller can only fire-and-forget it; the
     * short debounce is what keeps the exposure small.
     */
    async flush(): Promise<void> {
        this.cancelTimer()
        if (!this.dirty && !this.rewriteQueued) {
            return
        }
        await this.persist()
    }

    /** Cancels the deferred write; nothing is written after this. */
    dispose(): void {
        this.disposed = true
        this.cancelTimer()
    }

    /** The current in-memory store, in the persisted shape. */
    snapshot(): CommentStore {
        const notes: Record<string, MarginComment[]> = {}
        for (const [path, comments] of this.notes) {
            notes[path] = [...comments]
        }
        return { schemaVersion: COMMENT_STORE_SCHEMA_VERSION, notes }
    }

    // -- internals ------------------------------------------------------------

    private markDirty(): void {
        if (this.readOnly || this.disposed) {
            return
        }
        this.dirty = true
        this.cancelTimer()
        this.timer = this.deps.setTimer(() => {
            this.timer = null
            void this.persist()
        }, this.saveDelayMs)
    }

    private cancelTimer(): void {
        if (this.timer !== null) {
            this.deps.clearTimer(this.timer)
            this.timer = null
        }
    }

    /**
     * Writes the store. At most one write is ever in flight; a change that
     * lands during one is coalesced into exactly ONE follow-up write, so a
     * burst of mutations can never queue a burst of disk writes.
     */
    private async persist(): Promise<void> {
        if (this.readOnly || this.disposed) {
            return
        }
        if (this.writing) {
            this.rewriteQueued = true
            return
        }
        this.writing = true
        try {
            do {
                this.rewriteQueued = false
                this.dirty = false
                // A mutation that landed during the previous iteration armed
                // a deferred write; this loop is already covering it.
                this.cancelTimer()
                const payload = `${JSON.stringify(this.snapshot(), null, 2)}\n`
                try {
                    await this.writeStoreFile(payload)
                } catch (error) {
                    // Keep the changes dirty so the next mutation (or flush)
                    // retries them; never lose them to a transient failure.
                    this.dirty = true
                    this.deps.onWriteError?.(error instanceof Error ? error.message : String(error))
                    return
                }
                // Mutations that landed WHILE this write was in flight are
                // folded into exactly one more write — never one per mutation.
            } while (this.dirty || this.rewriteQueued)
        } finally {
            this.writing = false
        }
    }

    /**
     * Atomic-ish write: stage the whole payload in a temp file, then rename it
     * over the store. A crash between the two leaves the PREVIOUS store intact
     * (plus a stray temp file) instead of a half-written one.
     *
     * Adapters differ on renaming onto an existing path (POSIX replaces,
     * Windows refuses), so the fallbacks are explicit and ordered by how much
     * they risk: remove-then-rename (the temp still holds the full payload if
     * it fails), then a direct overwrite (the last resort — the only shape
     * that can truncate).
     */
    private async writeStoreFile(payload: string): Promise<void> {
        const { storage, storePath } = this.deps
        const tempPath = `${storePath}${TEMP_SUFFIX}`
        await storage.write(tempPath, payload)
        try {
            await storage.rename(tempPath, storePath)
            return
        } catch {
            // The destination exists and this adapter will not replace it.
        }
        try {
            await storage.remove(storePath)
            await storage.rename(tempPath, storePath)
            return
        } catch {
            // Fall through to the direct write.
        }
        await storage.write(storePath, payload)
        try {
            await storage.remove(tempPath)
        } catch {
            // A leftover temp file is harmless; it is overwritten next time.
        }
    }

    /**
     * Copies the bytes we just read to a timestamped backup, never overwriting
     * an existing one. Returns the path, or `null` when nothing could be
     * preserved (which puts the repository in read-only mode).
     */
    private async preserve(text: string): Promise<string | null> {
        const base = backupPathFor(this.deps.storePath, formatBackupStamp(this.now()))
        for (let attempt = 0; attempt < 10; attempt++) {
            const candidate = attempt === 0 ? base : base.replace(/\.json$/, `-${attempt}.json`)
            try {
                if (await this.deps.storage.exists(candidate)) {
                    continue
                }
                await this.deps.storage.write(candidate, text)
                return candidate
            } catch {
                return null
            }
        }
        return null
    }

    private report(
        status: CommentStoreLoadStatus,
        comments: number,
        dropped: readonly string[],
        interrupted: readonly string[],
        backupPath: string | null
    ): CommentStoreLoadReport {
        return {
            status,
            comments,
            dropped: [...dropped],
            interrupted: [...interrupted],
            backupPath,
            readOnly: this.readOnly
        }
    }
}

/** Human-readable one-liner for a load report (Notice / log copy). */
export function commentStoreLoadNotice(report: CommentStoreLoadReport): string | null {
    if (report.status === 'ok' || report.status === 'missing') {
        return null
    }
    const preserved =
        report.backupPath === null
            ? 'The file could not be preserved, so comments will not be saved this session.'
            : `The previous file was kept at ${report.backupPath}.`
    if (report.status === 'unreadable') {
        return `AI Editor: the margin comment store could not be read. ${preserved}`
    }
    const count = report.dropped.length
    return `AI Editor: ${count} margin comment ${count === 1 ? 'entry was' : 'entries were'} invalid and could not be loaded. ${preserved}`
}

/** Count of comments a load report says survived (for logs). */
export function commentStoreLoadSummary(report: CommentStoreLoadReport): string {
    return `comments=${report.comments} status=${report.status} dropped=${report.dropped.length} interrupted=${report.interrupted.length}`
}
