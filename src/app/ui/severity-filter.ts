import type { Severity } from '../domain/operations/contract'

/**
 * Severity filter (plan M4 "Bulk triage": severity filter): a per-file VIEW
 * state deciding which findings the interaction surfaces show. Filtered-out
 * findings stay in the `FindingStore` untouched — the filter is a lens, never
 * a mutation.
 *
 * Scope of the lens (decided 2026-07-30, stage D slice 2):
 * - respected by the editor decorations, the side-panel finding list,
 *   keyboard triage stepping, rail-chip cycling and the bulk operations
 *   (accepting something the user cannot see would be a silent mutation);
 * - NOT respected by run-report surfaces — the rail chip count and the panel
 *   section status keep reporting what the editor actually found, and the
 *   panel's filter control says how many findings it is hiding.
 *
 * The cycle is `all → warnings and suggestions → warnings only → all`:
 * severities in increasing importance, so repeatedly triggering the command
 * narrows the noise and comes back.
 */

export type SeverityFilterMode = 'all' | 'warning-and-suggestion' | 'warning'

/** Cycle order of the `filter-severity` command and the panel control. */
export const SEVERITY_FILTER_CYCLE: readonly SeverityFilterMode[] = [
    'all',
    'warning-and-suggestion',
    'warning'
]

export const DEFAULT_SEVERITY_FILTER: SeverityFilterMode = 'all'

/** The next mode in the cycle (wraps back to `all`). */
export function nextSeverityFilterMode(mode: SeverityFilterMode): SeverityFilterMode {
    const index = SEVERITY_FILTER_CYCLE.indexOf(mode)
    return (
        SEVERITY_FILTER_CYCLE[(index + 1) % SEVERITY_FILTER_CYCLE.length] ?? DEFAULT_SEVERITY_FILTER
    )
}

/** Whether a finding of this severity is visible under the given mode. */
export function passesSeverityFilter(mode: SeverityFilterMode, severity: Severity): boolean {
    switch (mode) {
        case 'all':
            return true
        case 'warning-and-suggestion':
            return severity === 'warning' || severity === 'suggestion'
        case 'warning':
            return severity === 'warning'
    }
}

/** Control label (sentence case) naming what is currently shown. */
export function severityFilterLabel(mode: SeverityFilterMode): string {
    switch (mode) {
        case 'all':
            return 'All severities'
        case 'warning-and-suggestion':
            return 'Warnings and suggestions'
        case 'warning':
            return 'Warnings only'
    }
}

/** Notice text for the `filter-severity` command (its only feedback). */
export function severityFilterNotice(mode: SeverityFilterMode, hidden: number): string {
    const label = severityFilterLabel(mode)
    if (hidden === 0) {
        return `Findings: ${label.toLowerCase()}.`
    }
    return `Findings: ${label.toLowerCase()} — ${hidden} hidden.`
}

/**
 * Per-file filter state. Survives runs on purpose: the lens the user chose is
 * about the note, not about one review. Cleared on rename/delete (the run is
 * discarded too) and on dispose.
 */
export class SeverityFilterStore {
    private readonly byFile = new Map<string, SeverityFilterMode>()

    get(filePath: string): SeverityFilterMode {
        return this.byFile.get(filePath) ?? DEFAULT_SEVERITY_FILTER
    }

    /** Advances the file's filter and returns the new mode. */
    cycle(filePath: string): SeverityFilterMode {
        const next = nextSeverityFilterMode(this.get(filePath))
        if (next === DEFAULT_SEVERITY_FILTER) {
            this.byFile.delete(filePath)
        } else {
            this.byFile.set(filePath, next)
        }
        return next
    }

    clear(filePath: string): void {
        this.byFile.delete(filePath)
    }

    clearAll(): void {
        this.byFile.clear()
    }
}
