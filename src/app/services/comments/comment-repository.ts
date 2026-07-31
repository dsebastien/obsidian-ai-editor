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
 * A write that fails re-arms itself with a backoff instead of waiting for the
 * next mutation: a transient failure (a sync client holding the file, a full
 * disk) must not turn into "nothing is written for the rest of the session"
 * the moment the user stops adding comments. Repeated failures escalate to the
 * glue, which tells the user — nobody reads a console.
 *
 * ## Corruption
 *
 * A store that cannot be read is PRESERVED (copied aside), never overwritten,
 * and the load reports what happened so the user can be told. If the copy
 * itself fails, the repository refuses to write for the rest of the session:
 * losing the file is worse than losing the session's comments.
 *
 * ## The two windows where the store is not the only copy
 *
 * 1. **An interrupted write.** `writeStoreFile` may have to remove the store
 *    before renaming the temp file over it, so there is a moment where the
 *    ONLY copy of every comment is `comments.json.tmp`. `load()` is therefore
 *    the recovery point: a missing store with a readable temp beside it is an
 *    interrupted write, not a first run, and is adopted rather than reported
 *    as `missing` (which is deliberately silent).
 * 2. **Another writer.** The file syncs, so another device — or another
 *    Obsidian instance on this one — can replace it while this session holds
 *    the whole store in memory. Every write therefore re-reads the file first
 *    and refuses to overwrite content this session has not seen: the two sides
 *    are UNIONED by comment id (this session wins a shared id, the other
 *    writer's additions are adopted) and the glue is told. A blind overwrite
 *    would silently revert whatever the other device parked.
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
 * Where a store is preserved before anything can overwrite it. Timestamped so
 * a second incident never overwrites the evidence of the first, and suffixed
 * `.json` so the user can open it in anything. `label` names WHY it was kept —
 * `corrupt` for an unreadable file, `conflict` for one another writer changed.
 */
export function backupPathFor(storePath: string, stamp: string, label = 'corrupt'): string {
    const base = storePath.replace(/\.json$/, '')
    return `${base}.${label}-${stamp}.json`
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
    /**
     * The store was gone but its temp file was there: a write was interrupted
     * and the comments were recovered from it. Never silent — a `missing`
     * store is reported as a first run, and this is not one.
     */
    | 'recovered'
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
    /**
     * Reports that writes have failed {@link WRITE_ALARM_FAILURES} times in a
     * row. The glue raises a Notice: a user whose comments have stopped being
     * saved must not have to open the console to find out.
     */
    readonly onWriteStalled?: (failures: number, message: string) => void
    /**
     * Reports that the file on disk had changed underneath this session and
     * the two sides were merged rather than overwritten (see the module doc).
     * `adopted` is how many comments came from the other writer.
     */
    readonly onExternalChange?: (adopted: number, backupPath: string | null) => void
}

/** Consecutive write failures before the user is told, not just the log. */
export const WRITE_ALARM_FAILURES = 3

/** Cap on the exponential backoff between write retries. */
const MAX_RETRY_BACKOFF_FACTOR = 16

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
    /** The write currently running, so `flush()` can await it (never a guess). */
    private inFlight: Promise<void> | null = null
    /** A change landed while a write was in flight: exactly one follow-up. */
    private rewriteQueued = false
    private disposed = false
    /** Consecutive failed writes, for the backoff and the alarm. */
    private writeFailures = 0
    /**
     * The exact bytes this session last saw on disk (read at load, replaced by
     * every successful write). Anything else means another writer got there.
     */
    private lastSeenText: string | null = null

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
        // No store, but the temp file the atomic write stages through is
        // still there: a write was interrupted in the one window where the
        // temp holds the ONLY copy. Recover from it rather than reporting a
        // first run — `missing` is deliberately silent, and silence here would
        // present every durable comment in the vault as never having existed.
        let recovered = false
        if (text === null) {
            text = await this.readTemp()
            if (text === null) {
                return this.report('missing', 0, [], [], null)
            }
            recovered = true
        }
        this.lastSeenText = text

        // Not even JSON: nothing to salvage, and `loadCommentStore` is never
        // asked to interpret garbage it was not given.
        let loaded: LoadedStore
        try {
            loaded = loadCommentStore(JSON.parse(text))
        } catch {
            loaded = { store: null, dropped: [], unreadable: true, interrupted: [] }
        }

        if (loaded.store) {
            // Merged, not `set` over: a vault event that landed while this
            // read was in flight has already mutated the map, and overwriting
            // it here would undo the rename or delete it applied.
            this.mergeIn(loaded.store)
        }

        if (!loaded.unreadable && loaded.dropped.length === 0) {
            if (recovered) {
                // Put the recovered payload back where the store belongs.
                this.markDirty()
                return this.report('recovered', this.count(), [], loaded.interrupted, null)
            }
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
     * per-note cap still holds, and the overflow is REPORTED — the count comes
     * back so the glue can tell the user. Dropping a user's parked questions
     * because a rename landed on an occupied path is exactly the silent
     * deletion this module forbids everywhere else (Business Rules #13).
     *
     * @returns how many comments the cap dropped (0 on the normal path).
     */
    noteRenamed(oldPath: string, newPath: string): number {
        if (oldPath === newPath) {
            return 0
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
            return 0
        }
        let dropped = 0
        for (const [from, to] of moves) {
            const moved = this.notes.get(from) ?? []
            this.notes.delete(from)
            const existing = this.notes.get(to) ?? []
            const merged = [...existing, ...moved]
            dropped += Math.max(0, merged.length - MAX_COMMENTS_PER_NOTE)
            this.notes.set(to, merged.slice(0, MAX_COMMENTS_PER_NOTE))
        }
        this.markDirty()
        return dropped
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
        return this.timer !== null || this.inFlight !== null || this.rewriteQueued || this.dirty
    }

    /** Whether writes are disabled for this session (unpreservable corruption). */
    isReadOnly(): boolean {
        return this.readOnly
    }

    /**
     * Writes immediately if anything is pending. Called on unload — which is
     * synchronous in Obsidian, so the caller can only fire-and-forget it; the
     * short debounce is what keeps the exposure small.
     *
     * A write already in flight is AWAITED rather than skipped: returning
     * before the follow-up has even started would make the contract ("writes
     * immediately if anything is pending") false in exactly the case that
     * matters — the debounce firing moments before quit. Awaiting it is
     * enough, because its own loop picks up whatever queued behind it. Exactly
     * one write is started here, so a failing adapter cannot spin the unload
     * path — the re-armed retry covers a session that keeps running.
     */
    async flush(): Promise<void> {
        this.cancelTimer()
        if (this.readOnly || this.disposed) {
            return
        }
        const inFlight = this.inFlight
        if (inFlight) {
            await inFlight
            return
        }
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
     *
     * Returns the promise of the write that will cover the caller's changes —
     * the in-flight one when there is one, since its loop picks the queued
     * follow-up up before it resolves.
     */
    private persist(): Promise<void> {
        if (this.readOnly || this.disposed) {
            return Promise.resolve()
        }
        const inFlight = this.inFlight
        if (inFlight) {
            this.rewriteQueued = true
            return inFlight
        }
        const promise = this.runWrites().finally(() => {
            this.inFlight = null
        })
        this.inFlight = promise
        return promise
    }

    private async runWrites(): Promise<void> {
        do {
            this.rewriteQueued = false
            this.dirty = false
            // A mutation that landed during the previous iteration armed a
            // deferred write; this loop is already covering it.
            this.cancelTimer()
            try {
                if ((await this.reconcileExternalChange()) === 'refuse') {
                    // Another writer's file could not be read OR preserved.
                    // Overwriting it would destroy comments nothing else
                    // holds, so this session stops writing instead.
                    this.dirty = true
                    return
                }
                const payload = `${JSON.stringify(this.snapshot(), null, 2)}\n`
                await this.writeStoreFile(payload)
                this.lastSeenText = payload
                this.writeFailures = 0
            } catch (error) {
                // Keep the changes dirty AND re-arm: waiting for the next
                // mutation would mean a transient failure silently ends
                // persistence for a session where the user stops commenting.
                this.dirty = true
                this.noteWriteFailure(error)
                return
            }
            // Mutations that landed WHILE this write was in flight are folded
            // into exactly one more write — never one per mutation.
        } while (this.dirty || this.rewriteQueued)
    }

    /** Logs a failed write, re-arms it with a backoff, and escalates repeats. */
    private noteWriteFailure(error: unknown): void {
        const message = error instanceof Error ? error.message : String(error)
        this.writeFailures += 1
        this.deps.onWriteError?.(message)
        if (this.writeFailures >= WRITE_ALARM_FAILURES) {
            this.deps.onWriteStalled?.(this.writeFailures, message)
        }
        if (this.readOnly || this.disposed) {
            return
        }
        const factor = Math.min(2 ** (this.writeFailures - 1), MAX_RETRY_BACKOFF_FACTOR)
        this.cancelTimer()
        this.timer = this.deps.setTimer(() => {
            this.timer = null
            void this.persist()
        }, this.saveDelayMs * factor)
    }

    /**
     * Refuses to overwrite a store this session has not seen.
     *
     * The file syncs (module doc), so another device — or another Obsidian
     * instance — can replace it between our load and our write. The two sides
     * are UNIONED by comment id: this session wins a shared id (it is the one
     * whose job actually ran) and every comment only the other writer has is
     * adopted. A union never loses a parked question; propagating the other
     * side's deletions would, and a delete is one click away anyway.
     */
    private async reconcileExternalChange(): Promise<'ok' | 'refuse'> {
        let current: string | null
        try {
            current = await this.deps.storage.read(this.deps.storePath)
        } catch {
            // We cannot tell what is there. Proceed: `writeStoreFile` stages
            // through a temp file, so the worst case is the one we already
            // accept, and refusing here would strand every write behind a
            // read that may never succeed.
            return 'ok'
        }
        if (current === null || current === this.lastSeenText) {
            return 'ok'
        }
        let parsed: LoadedStore
        try {
            parsed = loadCommentStore(JSON.parse(current))
        } catch {
            parsed = { store: null, dropped: [], unreadable: true, interrupted: [] }
        }
        // Anything we cannot fold in has to survive as a file before we write.
        const needsBackup = parsed.store === null || parsed.unreadable || parsed.dropped.length > 0
        let backupPath: string | null = null
        if (needsBackup) {
            backupPath = await this.preserve(current, 'conflict')
            if (backupPath === null) {
                this.readOnly = true
                return 'refuse'
            }
        }
        const adopted = parsed.store === null ? 0 : this.mergeIn(parsed.store)
        this.lastSeenText = current
        this.deps.onExternalChange?.(adopted, backupPath)
        return 'ok'
    }

    /**
     * Folds a store read from disk into memory, keyed by comment id. Only ever
     * ADDS: this session's copy of a shared id is the fresher one.
     *
     * @returns how many comments were adopted.
     */
    private mergeIn(store: CommentStore): number {
        let adopted = 0
        for (const [path, incoming] of Object.entries(store.notes)) {
            const existing = this.notes.get(path) ?? []
            const known = new Set(existing.map((entry) => entry.id))
            const merged = [...existing]
            for (const comment of incoming) {
                if (known.has(comment.id) || merged.length >= MAX_COMMENTS_PER_NOTE) {
                    continue
                }
                merged.push(comment)
                adopted += 1
            }
            if (merged.length > 0) {
                this.notes.set(path, merged)
            }
        }
        return adopted
    }

    /** The staged payload of an interrupted write, when there is one. */
    private async readTemp(): Promise<string | null> {
        try {
            return await this.deps.storage.read(`${this.deps.storePath}${TEMP_SUFFIX}`)
        } catch {
            return null
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
    private async preserve(text: string, label = 'corrupt'): Promise<string | null> {
        const base = backupPathFor(this.deps.storePath, formatBackupStamp(this.now()), label)
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
    if (report.status === 'recovered') {
        const count = report.comments
        return `Editor AI Daemons: the last save of the margin comments was interrupted. ${count} ${
            count === 1 ? 'comment was' : 'comments were'
        } recovered.`
    }
    const preserved =
        report.backupPath === null
            ? 'The file could not be preserved, so comments will not be saved this session.'
            : `The previous file was kept at ${report.backupPath}.`
    if (report.status === 'unreadable') {
        return `Editor AI Daemons: the margin comment store could not be read. ${preserved}`
    }
    const count = report.dropped.length
    return `Editor AI Daemons: ${count} margin comment ${count === 1 ? 'entry was' : 'entries were'} invalid and could not be loaded. ${preserved}`
}

/** Count of comments a load report says survived (for logs). */
export function commentStoreLoadSummary(report: CommentStoreLoadReport): string {
    return `comments=${report.comments} status=${report.status} dropped=${report.dropped.length} interrupted=${report.interrupted.length}`
}
