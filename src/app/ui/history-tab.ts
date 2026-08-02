import type { HistoryEntry, HistoryEntryKind } from '../domain/history/history-entry'

/**
 * History tab model (issue #21): pure grouping/filtering over the note's
 * history entries — day groups (most recent first), with kind and editor
 * filters derived from what is actually present. The DOM half lives in
 * `side-panel.ts`; everything decision-shaped is here and spec-pinned.
 */

export interface HistoryFilters {
    /** Empty set = no filter (everything shown). */
    readonly kinds: ReadonlySet<HistoryEntryKind>
    readonly editorNames: ReadonlySet<string>
}

export const NO_HISTORY_FILTERS: HistoryFilters = {
    kinds: new Set(),
    editorNames: new Set()
}

export interface HistoryDayGroup {
    /** Human day label ("Today", "Yesterday", or a locale date). */
    readonly label: string
    readonly entries: readonly HistoryEntry[]
}

export const HISTORY_KIND_LABELS: Record<HistoryEntryKind, string> = {
    finding: 'Findings',
    thread: 'Replies',
    scorecard: 'Scorecards',
    transform: 'Transforms'
}

/** The kinds present in the entries, in a stable display order. */
export function availableKinds(entries: readonly HistoryEntry[]): HistoryEntryKind[] {
    const present = new Set(entries.map((entry) => entry.kind))
    return (Object.keys(HISTORY_KIND_LABELS) as HistoryEntryKind[]).filter((kind) =>
        present.has(kind)
    )
}

/** The editor names present, alphabetical. */
export function availableEditors(entries: readonly HistoryEntry[]): string[] {
    return [...new Set(entries.map((entry) => entry.editorName))].sort((a, b) => a.localeCompare(b))
}

export function applyFilters(
    entries: readonly HistoryEntry[],
    filters: HistoryFilters
): HistoryEntry[] {
    return entries.filter(
        (entry) =>
            (filters.kinds.size === 0 || filters.kinds.has(entry.kind)) &&
            (filters.editorNames.size === 0 || filters.editorNames.has(entry.editorName))
    )
}

/**
 * Groups (already-sorted, newest-first) entries by calendar day, most recent
 * day first. `now` is injected so the "Today"/"Yesterday" labels are pure.
 */
export function groupByDay(entries: readonly HistoryEntry[], now: number): HistoryDayGroup[] {
    const groups: { key: string; label: string; entries: HistoryEntry[] }[] = []
    for (const entry of entries) {
        const key = dayKey(entry.at)
        const last = groups.at(-1)
        if (last && last.key === key) {
            last.entries.push(entry)
        } else {
            groups.push({ key, label: dayLabel(entry.at, now), entries: [entry] })
        }
    }
    return groups.map(({ label, entries: dayEntries }) => ({ label, entries: dayEntries }))
}

function dayKey(at: number): string {
    const date = new Date(at)
    return `${String(date.getFullYear())}-${String(date.getMonth())}-${String(date.getDate())}`
}

function dayLabel(at: number, now: number): string {
    const key = dayKey(at)
    if (key === dayKey(now)) {
        return 'Today'
    }
    if (key === dayKey(now - 24 * 60 * 60 * 1_000)) {
        return 'Yesterday'
    }
    return new Date(at).toLocaleDateString(undefined, {
        year: 'numeric',
        month: 'short',
        day: 'numeric'
    })
}

/** "14:32"-style time for an entry row (locale-aware). */
export function entryTime(at: number): string {
    return new Date(at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
}
