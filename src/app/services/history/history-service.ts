import { generateId } from '../../domain/ids'
import type {
    HistoryEntry,
    HistoryEntryKind,
    HistoryEdit
} from '../../domain/history/history-entry'
import {
    applyRetention,
    clip,
    HISTORY_EDITS_MAX,
    HISTORY_QUOTE_MAX,
    HISTORY_TEXT_MAX
} from '../../domain/history/history-entry'
import { deleteKeysUnder } from '../../domain/path-scope'

/**
 * Session history (issue #21, level 1): every finding, thread reply and panel
 * scorecard the plugin produced this session, browsable after the run that
 * produced them is gone. In-memory by default; the durable layer
 * (`history-repository.ts`, level 2) hydrates and persists THIS store when
 * the setting is on — the service does not know which mode it is in.
 *
 * Privacy: `isRecordable` is consulted on EVERY record — an excluded or
 * rule-disabled note gets no history, ever (same absolute rule as requests,
 * Business Rules #7). Verbatim repeats are skipped via the entry `key`
 * (#19's observation identity), so daemon-mode re-runs that keep saying the
 * same thing do not grow the store.
 */

export interface RecordInput {
    readonly filePath: string
    readonly editorId: string
    readonly editorName: string
    readonly kind: HistoryEntryKind
    readonly key?: string
    readonly quote?: string
    readonly text?: string
    readonly edits?: readonly HistoryEdit[]
    readonly label?: string
}

export interface HistoryServiceOptions {
    /** Privacy gate, consulted per record (BR #7 applies to history too). */
    readonly isRecordable: (filePath: string) => boolean
    readonly now?: () => number
    /** Fired once per mutation — the panel refresh and the durable saver. */
    readonly onChange?: () => void
}

export class HistoryService {
    private entries: HistoryEntry[] = []
    private readonly isRecordable: (filePath: string) => boolean
    private readonly now: () => number
    private readonly onChange: (() => void) | undefined

    constructor(options: HistoryServiceOptions) {
        this.isRecordable = options.isRecordable
        this.now = options.now ?? ((): number => Date.now())
        this.onChange = options.onChange
    }

    record(input: RecordInput): void {
        if (!this.isRecordable(input.filePath)) {
            return
        }
        const entry: HistoryEntry = {
            id: generateId(),
            at: this.now(),
            filePath: input.filePath,
            editorId: input.editorId,
            editorName: input.editorName,
            kind: input.kind,
            key: input.key ?? '',
            quote: clip(input.quote ?? '', HISTORY_QUOTE_MAX),
            text: clip(input.text ?? '', HISTORY_TEXT_MAX),
            edits: (input.edits ?? [])
                .slice(0, HISTORY_EDITS_MAX)
                .map((edit) => ({ op: edit.op, text: clip(edit.text, HISTORY_QUOTE_MAX) })),
            label: input.label ?? ''
        }
        if (entry.key.length > 0 && this.isVerbatimRepeat(entry)) {
            return
        }
        this.entries.push(entry)
        this.entries = applyRetention(this.entries, this.now())
        this.onChange?.()
    }

    /** Newest first, for one file. */
    listForFile(filePath: string): readonly HistoryEntry[] {
        return this.entries
            .filter((entry) => entry.filePath === filePath)
            .sort((a, b) => b.at - a.at)
    }

    /** Total entries currently held (settings/clear copy). */
    size(): number {
        return this.entries.length
    }

    clearFile(filePath: string): void {
        const before = this.entries.length
        this.entries = this.entries.filter((entry) => entry.filePath !== filePath)
        if (this.entries.length !== before) {
            this.onChange?.()
        }
    }

    clearAll(): void {
        if (this.entries.length === 0) {
            return
        }
        this.entries = []
        this.onChange?.()
    }

    /** Vault rename: history follows the note (same rule as comments). */
    renameFile(oldPath: string, newPath: string): void {
        let changed = false
        this.entries = this.entries.map((entry) => {
            if (entry.filePath !== oldPath) {
                return entry
            }
            changed = true
            return { ...entry, filePath: newPath }
        })
        if (changed) {
            this.onChange?.()
        }
    }

    /** Vault delete of a file or folder: its history goes with it. */
    deleteUnder(path: string): void {
        const keep = new Map(this.entries.map((entry) => [entry.filePath, true]))
        deleteKeysUnder(keep, path)
        const before = this.entries.length
        this.entries = this.entries.filter((entry) => keep.has(entry.filePath))
        if (this.entries.length !== before) {
            this.onChange?.()
        }
    }

    /** Durable layer: full snapshot for persistence (already retained). */
    serialize(): readonly HistoryEntry[] {
        return [...this.entries]
    }

    /** Durable layer: load persisted entries (retention re-applied). */
    hydrate(entries: readonly HistoryEntry[]): void {
        this.entries = applyRetention([...this.entries, ...entries], this.now())
        this.onChange?.()
    }

    /**
     * A repeat is skipped only when the file's MOST RECENT entry with the
     * same observation key and editor says exactly the same thing — a re-run
     * that reworded or re-proposed still records (the change is the point of
     * a history).
     */
    private isVerbatimRepeat(entry: HistoryEntry): boolean {
        for (let i = this.entries.length - 1; i >= 0; i--) {
            const existing = this.entries[i]
            if (
                existing === undefined ||
                existing.filePath !== entry.filePath ||
                existing.editorId !== entry.editorId ||
                existing.key !== entry.key ||
                existing.kind !== entry.kind
            ) {
                continue
            }
            return (
                existing.quote === entry.quote &&
                existing.text === entry.text &&
                existing.label === entry.label &&
                JSON.stringify(existing.edits) === JSON.stringify(entry.edits)
            )
        }
        return false
    }
}
