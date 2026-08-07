import type { Severity, TriageDecision } from '../../domain/operations/contract'
import type { ThreadMessage } from '../../domain/operations/thread'
import { remapPathUnder } from '../../domain/path-scope'

/**
 * Session-scoped triage journal — the input side of the per-editor learning
 * loop (issue #4).
 *
 * Records every finding the user decides on (accept / reject / dismiss /
 * concede), per editor, so an explicit "Distill editor learnings" command can
 * later turn the session's decisions into editor memory. Three deliberate
 * properties:
 *
 * - **In-memory only, never persisted.** Events quote note content;
 *   persisting them would need a durable-history-style opt-in (out of scope
 *   for issue #4). A reload starts the journal empty. Business Rules #22.
 * - **Clipped at the door.** Quotes, critiques and thread messages are cut
 *   to fixed lengths on `record` — the journal is a compressed signal, not
 *   an archive; the archive is `HistoryService` (BR #19: history is never a
 *   participant, so distillation reads THIS, not history).
 * - **Bounded.** A per-editor FIFO ring caps at {@link MEMORY_JOURNAL_CAP}
 *   events; the oldest events fall off first. 200 matches the distillation
 *   request contract's `events` max, so a full ring ships whole.
 *
 * Events are cleared per editor only when a distilled memory is SAVED
 * (`clear`), never on request start — a failed distillation must not eat the
 * session's signal.
 */

/** Per-editor event cap (matches `distillMemoryRequestSchema`'s events max). */
export const MEMORY_JOURNAL_CAP = 200

/** Clip bounds applied on `record` (issue #4 spec). */
export const JOURNAL_QUOTE_MAX = 300
export const JOURNAL_CRITIQUE_MAX = 500
export const JOURNAL_THREAD_MESSAGE_MAX = 300

export interface MemoryJournalEventInput {
    readonly editorId: string
    /**
     * Note the finding was made on; re-checked against exclusions at consume
     * time (BR #7). Follows vault renames (`filesRenamedUnder`) so the
     * consume-time check sees the note's CURRENT path.
     */
    readonly notePath: string
    readonly quote: string
    readonly critique: string
    readonly severity: Severity
    readonly decision: TriageDecision
    /** Completed push-back thread (conceded findings carry the argument). */
    readonly thread: readonly ThreadMessage[]
}

export interface MemoryJournalEvent extends MemoryJournalEventInput {
    /**
     * Journal-assigned identity, strictly increasing across ALL editors.
     * Clearing goes by seq high-water mark, never by count: when a full
     * 200-event ring is snapshotted for distillation and a new decision
     * evicts the oldest snapshotted event mid-flight, a clear-by-count
     * would eat the new, never-snapshotted decision.
     */
    readonly seq: number
}

function clip(text: string, max: number): string {
    return text.length > max ? text.slice(0, max) : text
}

export class MemoryJournal {
    private readonly events = new Map<string, MemoryJournalEvent[]>()
    private nextSeq = 1

    /** Records one decision, clipped; drops the oldest event past the cap. */
    record(event: MemoryJournalEventInput): void {
        const clipped: MemoryJournalEvent = {
            editorId: event.editorId,
            notePath: event.notePath,
            quote: clip(event.quote, JOURNAL_QUOTE_MAX),
            critique: clip(event.critique, JOURNAL_CRITIQUE_MAX),
            severity: event.severity,
            decision: event.decision,
            thread: event.thread.map((message) => ({
                role: message.role,
                content: clip(message.content, JOURNAL_THREAD_MESSAGE_MAX)
            })),
            seq: this.nextSeq++
        }
        const ring = this.events.get(event.editorId)
        if (ring === undefined) {
            this.events.set(event.editorId, [clipped])
            return
        }
        ring.push(clipped)
        if (ring.length > MEMORY_JOURNAL_CAP) {
            ring.splice(0, ring.length - MEMORY_JOURNAL_CAP)
        }
    }

    /** Snapshot of one editor's events, oldest first. Does NOT clear. */
    eventsFor(editorId: string): readonly MemoryJournalEvent[] {
        return [...(this.events.get(editorId) ?? [])]
    }

    countFor(editorId: string): number {
        return this.events.get(editorId)?.length ?? 0
    }

    /**
     * Clears one editor's events. Called by the save path AFTER a distilled
     * memory was confirmed and written — never earlier.
     *
     * `upToSeq` consumes only events the distillation actually SNAPSHOTTED
     * (their `seq` is at or below the snapshot's newest): decisions recorded
     * while the request was in flight — or while the review modal sat open —
     * survive for the next distillation. Identity-based, not count-based: a
     * full ring can evict a SNAPSHOTTED event when a mid-flight decision
     * arrives, and a count-based clear would then eat the new decision.
     */
    clear(editorId: string, upToSeq?: number): void {
        if (upToSeq === undefined) {
            this.events.delete(editorId)
            return
        }
        const ring = this.events.get(editorId)
        if (ring === undefined) {
            return
        }
        const survivors = ring.filter((event) => event.seq > upToSeq)
        if (survivors.length === 0) {
            this.events.delete(editorId)
            return
        }
        ring.splice(0, ring.length, ...survivors)
    }

    /**
     * Follows a vault rename (file or folder): every event recorded on the
     * old path — or under the old folder — moves to the new path, keeping
     * its identity. Without this, consume-time exclusion filtering (BR #7)
     * checks a path that no longer exists: a note moved INTO an excluded
     * folder would keep its events eligible under folder-only exclusion
     * configs, and a benign rename would fail events closed (metadata on a
     * dead path resolves to null) — losing signal either way.
     */
    filesRenamedUnder(oldPath: string, newPath: string): void {
        for (const ring of this.events.values()) {
            for (let i = 0; i < ring.length; i++) {
                const event = ring[i]
                if (event === undefined) {
                    continue
                }
                const remapped = remapPathUnder(event.notePath, oldPath, newPath)
                if (remapped !== null) {
                    ring[i] = { ...event, notePath: remapped }
                }
            }
        }
    }
}
