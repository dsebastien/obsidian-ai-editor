/**
 * History entries (issue #21): everything the editors have said, kept rather
 * than thrown away when the next run replaces it. The live view (#19 merge)
 * decides what is on screen NOW; history decides what is recoverable later.
 *
 * Growth is the design problem, so every free-text field is HARD-CLIPPED at
 * record time — an entry is a readable record of what was said, never a full
 * copy of the payload — and retention (`applyRetention`) bounds age, per-file
 * count and total count with visible defaults. Entries carry the observation
 * identity where one exists (#19's `observationIdentity`), so a re-run that
 * repeats itself verbatim records nothing new.
 */

export type HistoryEntryKind = 'finding' | 'thread' | 'scorecard' | 'transform'

/** Clip caps — chosen so a screenful of entries stays a screenful of text. */
export const HISTORY_QUOTE_MAX = 300
export const HISTORY_TEXT_MAX = 500
export const HISTORY_EDITS_MAX = 5

/** Retention defaults (issue #21 — decided up front, not discovered later). */
export const HISTORY_MAX_AGE_DAYS = 90
export const HISTORY_MAX_PER_FILE = 100
export const HISTORY_MAX_TOTAL = 2_000

export interface HistoryEdit {
    readonly op: string
    readonly text: string
}

export interface HistoryEntry {
    readonly id: string
    /** Epoch ms at record time. */
    readonly at: number
    readonly filePath: string
    /** Editor persona (empty for panel scorecards, which belong to a panel). */
    readonly editorId: string
    readonly editorName: string
    readonly kind: HistoryEntryKind
    /**
     * Cross-run observation identity for findings (#19); empty for kinds
     * that have no observation. Used to skip verbatim repeats.
     */
    readonly key: string
    /** The quoted span (findings/threads/transforms), clipped. */
    readonly quote: string
    /** The main text — critique, reply, scorecard rationale — clipped. */
    readonly text: string
    /** Proposed edits (findings), clipped and capped. */
    readonly edits: readonly HistoryEdit[]
    /** Severity / verdict / outcome label, kind-dependent (may be empty). */
    readonly label: string
}

export function clip(text: string, max: number): string {
    return text.length <= max ? text : `${text.slice(0, max - 1)}…`
}

/**
 * Applies the retention policy, newest kept first: entries older than
 * `maxAgeDays` go; then each file keeps its newest `maxPerFile`; then the
 * vault keeps its newest `maxTotal`. Pure — the caller supplies `now`.
 */
export function applyRetention(
    entries: readonly HistoryEntry[],
    now: number,
    limits = {
        maxAgeDays: HISTORY_MAX_AGE_DAYS,
        maxPerFile: HISTORY_MAX_PER_FILE,
        maxTotal: HISTORY_MAX_TOTAL
    }
): HistoryEntry[] {
    const cutoff = now - limits.maxAgeDays * 24 * 60 * 60 * 1_000
    const fresh = entries.filter((entry) => entry.at >= cutoff)
    const byFile = new Map<string, HistoryEntry[]>()
    for (const entry of fresh) {
        const list = byFile.get(entry.filePath)
        if (list) {
            list.push(entry)
        } else {
            byFile.set(entry.filePath, [entry])
        }
    }
    const kept: HistoryEntry[] = []
    for (const list of byFile.values()) {
        list.sort((a, b) => b.at - a.at)
        kept.push(...list.slice(0, limits.maxPerFile))
    }
    kept.sort((a, b) => b.at - a.at)
    return kept.slice(0, limits.maxTotal)
}
