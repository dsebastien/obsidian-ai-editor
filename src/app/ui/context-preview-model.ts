import type { ContextPreview } from '../services/context-preview-service'
import { sectionStatusLabel } from '../services/context/context-budget'
import type { ContextSection } from '../services/context/context-budget'
import { skipReasonLabel } from '../services/review-service'

/**
 * Pure presentation for the "what will be sent" preview: the summary lines,
 * the per-section rows, and the clipboard payload. The modal
 * (`context-preview-modal.ts`) is DOM glue over these functions and decides
 * nothing itself.
 *
 * Numbers are formatted here, once, with an explicit grouping separator rather
 * than `toLocaleString` — a spec that passes in one locale and fails in
 * another is worse than no spec, and a trust surface must read identically
 * wherever it is opened.
 */

/** Groups an integer in threes with thin, unambiguous separators. */
export function formatCount(value: number): string {
    const digits = Math.trunc(Math.abs(value)).toString()
    const groups: string[] = []
    for (let end = digits.length; end > 0; end -= 3) {
        groups.unshift(digits.slice(Math.max(0, end - 3), end))
    }
    return `${value < 0 ? '-' : ''}${groups.join(' ')}`
}

/** `12 345 characters` / `1 character`. */
export function formatChars(value: number): string {
    return `${formatCount(value)} ${value === 1 ? 'character' : 'characters'}`
}

/**
 * Header lines, in order. Every line is a fact about THIS assembly; nothing is
 * hedged and nothing is omitted when it is bad news.
 */
export function previewSummaryLines(preview: ContextPreview): string[] {
    const { budget } = preview
    const lines = [
        `Total: ${formatChars(budget.totalChars)} of a ${formatCount(budget.budgetChars)} character budget.`,
        `Sections: ${formatCount(preview.sections.length)}.`
    ]
    if (budget.truncatedPaths.length > 0) {
        lines.push(
            `Truncated to fit: ${formatCount(budget.truncatedPaths.length)} — ${budget.truncatedPaths.join(', ')}.`
        )
    }
    if (budget.droppedPaths.length > 0) {
        lines.push(
            `Dropped, budget exhausted: ${formatCount(budget.droppedPaths.length)} — ${budget.droppedPaths.join(', ')}.`
        )
    }
    if (budget.overBudgetChars > 0) {
        // The system prompt and the reviewed note are never truncated, so this
        // request goes out over budget. Say it plainly; do not imply a fix
        // that does not exist.
        lines.push(
            `Over budget by ${formatChars(budget.overBudgetChars)}: the system prompt and the reviewed note are never truncated, so this request exceeds the budget. Raise the context budget or review a shorter note.`
        )
    }
    if (preview.backendLabel !== null) {
        lines.push(`Backend: ${preview.backendLabel}.`)
    } else if (preview.backendIssue !== null) {
        lines.push(`This editor cannot run: ${skipReasonLabel(preview.backendIssue)}.`)
    }
    return lines
}

/** One row of the section table: what it is, and what the budget did to it. */
export interface SectionRow {
    readonly name: string
    readonly detail: string
    readonly status: ContextSection['status']
}

export function sectionRows(preview: ContextPreview): SectionRow[] {
    return preview.sections.map((section) => ({
        name: section.path === null ? section.label : `${section.label} — ${section.path}`,
        detail:
            section.status === 'sent'
                ? formatChars(section.sentChars)
                : `${formatChars(section.sentChars)} of ${formatCount(section.sourceChars)} — ${sectionStatusLabel(section.status)}`,
        status: section.status
    }))
}

/**
 * The clipboard payload: the summary, the section table, then the verbatim
 * system prompt. The prompt goes last and unmodified so pasting it into
 * another tool reproduces the request rather than a description of it.
 */
export function previewClipboardText(preview: ContextPreview): string {
    const rows = sectionRows(preview).map((row) => `- ${row.name}: ${row.detail}`)
    return [
        `AI Editor — what will be sent`,
        `Editor: ${preview.editorName}`,
        `Note: ${preview.notePath}`,
        '',
        ...previewSummaryLines(preview),
        '',
        'Sections:',
        ...rows,
        '',
        'System prompt:',
        preview.systemPrompt
    ].join('\n')
}
