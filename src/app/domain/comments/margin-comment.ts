import { z } from 'zod'
import { rawFindingSchema } from '../operations/contract'

/**
 * Durable margin comments (plan §5.5 / M8): the one thing in this plugin that
 * OUTLIVES a session.
 *
 * A margin comment is a job the user parked on a span — "check this claim",
 * "is this too long?" — that an editor answers in the background. The user
 * closes Obsidian, reopens it, and the comment is still there, still anchored
 * in the margin. That is the whole point, and it dictates the shape:
 *
 * - **Locating hints, never offsets.** A comment persists `quote` +
 *   `prefix`/`suffix`/`occurrence` — the same vocabulary a finding carries —
 *   and is RE-ANCHORED against the live note text on load (see
 *   `reanchorComment`). Offsets are deliberately absent from the schema: the
 *   note may have been edited by another device, another plugin, or the user
 *   in a different app while Obsidian was closed, and a stored offset would
 *   look authoritative while pointing at unrelated text (Business Rules
 *   #3/#4).
 * - **Nothing is silently dropped.** A quote that no longer resolves makes the
 *   comment ORPHANED — kept, shown with its quote, not deleted. Deleting a
 *   user's parked question because their edit moved a word would be the worst
 *   possible failure mode for a feature whose promise is persistence.
 * - **No fake resumption.** A comment persisted as `submitted`/`running` was
 *   in flight when the session ended; nothing resumes it, so it loads back as
 *   `interrupted` and the UI offers Retry (plan M8).
 *
 * Storage location and write discipline live in
 * `services/comments/comment-repository.ts`; this module owns the shape, the
 * defensive load and the status vocabulary.
 */

/**
 * Bumped whenever the persisted shape changes. There are no users yet, so
 * there are no migrations (plan §0 no-users policy) — the field ships anyway
 * because after release a migration hook needs somewhere to read the version
 * from, and adding it later would mean guessing at unversioned files.
 */
export const COMMENT_STORE_SCHEMA_VERSION = 1

/** Mirrors the operation contract's caps so a comment cannot outgrow a finding. */
const QUOTE_MAX = 2_000
const SHORT_TEXT_MAX = 10_000

/**
 * Per-note cap. A margin comment is a triage artifact, not note content: a
 * note accumulating hundreds of them is a runaway, and the store is read
 * whole on every load. The cap bounds the pathological case without bounding
 * the vault (the number of NOTES is deliberately uncapped — it grows with the
 * vault, which is the user's business).
 */
export const MAX_COMMENTS_PER_NOTE = 500

/**
 * Lifecycle of one comment.
 *
 * `submitted` and `running` are IN-FLIGHT: they only ever describe the current
 * session. Reading either back from disk means the session died mid-job, which
 * `loadCommentStore` normalizes to `interrupted` — the store never claims a
 * job is running that nothing is running.
 */
export const marginCommentStatusSchema = z.enum([
    /** Queued: recorded, backend request not started yet. */
    'submitted',
    /** A backend request is in flight for it. */
    'running',
    /** Was in flight when the session ended. Offers Retry, never resumes. */
    'interrupted',
    /** The editor answered. */
    'done',
    /** The user closed it without acting. Kept so it is not re-asked. */
    'dismissed'
])
export type MarginCommentStatus = z.infer<typeof marginCommentStatusSchema>

/** In-flight statuses — impossible to still be true at load time. */
const IN_FLIGHT_STATUSES: readonly MarginCommentStatus[] = ['submitted', 'running']

export const marginCommentSchema = z.object({
    id: z.string().min(1).max(200),
    /** Verbatim span text at creation time — the primary locating hint. */
    quote: z.string().min(1).max(QUOTE_MAX),
    /** Text immediately before the quote, for occurrence disambiguation. */
    prefix: z.string().max(200).optional(),
    /** Text immediately after the quote, for occurrence disambiguation. */
    suffix: z.string().max(200).optional(),
    /** 0-based occurrence index when the quote appeared multiple times. */
    occurrence: z.number().int().min(0).max(1_000).optional(),
    /** What the user asked about this span. */
    instruction: z.string().min(1).max(SHORT_TEXT_MAX),
    /** Editor entity that owns the job. */
    editorId: z.string().min(1).max(200),
    /**
     * The editor's name AS IT WAS when the comment was created. Denormalized
     * on purpose: a comment can outlive the editor entity by months, and
     * "answered by <deleted editor>" beats a dangling id in the margin.
     */
    editorName: z.string().max(200).default(''),
    status: marginCommentStatusSchema,
    /** Unix ms. */
    createdAt: z.number().int().min(0),
    /** Unix ms of the last status/result change. */
    updatedAt: z.number().int().min(0),
    /** What the editor reported, once it answered. */
    findings: z.array(rawFindingSchema).max(200).default([]),
    /** Note-level answer when the editor replied without pinning a span. */
    reply: z.string().max(SHORT_TEXT_MAX).optional(),
    /** Redacted failure message when the job ended badly (Business Rules #12). */
    error: z.string().max(2_000).optional()
})
export type MarginComment = z.infer<typeof marginCommentSchema>

/**
 * The whole sidecar file: a schema version plus comments keyed by
 * vault-relative note path.
 *
 * Keyed by path — not by a note id — because Obsidian has no stable note
 * identity: the path IS the identity, which is why rename/delete handling is a
 * first-class concern of the repository rather than an afterthought.
 */
export const commentStoreSchema = z.object({
    schemaVersion: z.number().int().min(1),
    notes: z.record(
        z.string().min(1).max(1_000),
        z.array(marginCommentSchema).max(MAX_COMMENTS_PER_NOTE)
    )
})
export type CommentStore = z.infer<typeof commentStoreSchema>

export const EMPTY_COMMENT_STORE: CommentStore = {
    schemaVersion: COMMENT_STORE_SCHEMA_VERSION,
    notes: {}
}

/** Outcome of reading a persisted store. */
export interface LoadedCommentStore {
    readonly store: CommentStore
    /**
     * Entries that failed validation and were left out, as `path` or
     * `path[index]`. Non-empty means the file on disk holds data the loaded
     * store does not — the caller MUST preserve a copy before writing over it.
     */
    readonly dropped: readonly string[]
    /**
     * True when nothing at all could be read as a store (not an object, no
     * usable `notes`). Same obligation as `dropped`: preserve, then report.
     */
    readonly unreadable: boolean
    /** Ids normalized from an in-flight status to `interrupted` (plan M8). */
    readonly interrupted: readonly string[]
}

/**
 * Parses a persisted store defensively — never throws.
 *
 * Salvage granularity is ONE COMMENT: a single malformed entry must not cost
 * the user every other comment in the vault, and a malformed note entry must
 * not cost the other notes. Same reasoning as the settings loader, applied to
 * data the user cannot retype (they wrote the instruction, the editor wrote
 * the answer).
 *
 * `raw` is whatever `JSON.parse` produced; a file that is not even JSON is the
 * repository's problem (it holds the bytes it must preserve).
 */
export function loadCommentStore(raw: unknown): LoadedCommentStore {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
        return { store: EMPTY_COMMENT_STORE, dropped: [], unreadable: true, interrupted: [] }
    }
    const source = raw as Record<string, unknown>
    const rawNotes = source['notes']
    if (typeof rawNotes !== 'object' || rawNotes === null || Array.isArray(rawNotes)) {
        return { store: EMPTY_COMMENT_STORE, dropped: [], unreadable: true, interrupted: [] }
    }

    const dropped: string[] = []
    const interrupted: string[] = []
    const notes: Record<string, MarginComment[]> = {}

    for (const [path, value] of Object.entries(rawNotes as Record<string, unknown>)) {
        if (path.length === 0 || path.length > 1_000) {
            dropped.push(path)
            continue
        }
        if (!Array.isArray(value)) {
            dropped.push(path)
            continue
        }
        const kept: MarginComment[] = []
        value.forEach((element, index) => {
            const parsed = marginCommentSchema.safeParse(element)
            if (!parsed.success) {
                dropped.push(`${path}[${index}]`)
                return
            }
            if (kept.length >= MAX_COMMENTS_PER_NOTE) {
                dropped.push(`${path}[${index}]`)
                return
            }
            const comment = normalizeLoadedStatus(parsed.data, interrupted)
            kept.push(comment)
        })
        if (kept.length > 0) {
            notes[path] = kept
        }
    }

    return {
        store: { schemaVersion: COMMENT_STORE_SCHEMA_VERSION, notes },
        dropped,
        unreadable: false,
        interrupted
    }
}

/**
 * A job cannot still be in flight in a session that has not started yet.
 * Reading `submitted`/`running` back from disk means the previous session
 * ended mid-job, so the comment becomes `interrupted` — the state the UI
 * offers Retry from. Never resumed automatically: a resumed request is a
 * backend call the user did not authorize in this session (Business Rule #1).
 */
function normalizeLoadedStatus(comment: MarginComment, interrupted: string[]): MarginComment {
    if (!IN_FLIGHT_STATUSES.includes(comment.status)) {
        return comment
    }
    interrupted.push(comment.id)
    return { ...comment, status: 'interrupted' }
}

/** Total comments across every note in a store. */
export function countComments(store: CommentStore): number {
    return Object.values(store.notes).reduce((total, comments) => total + comments.length, 0)
}
