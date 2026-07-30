import type { PluginSettingsV1 } from '../domain/settings/settings-schema'
import type { ContextPreview, ContextPreviewResult } from '../services/context-preview-service'
import { sectionStatusLabel } from '../services/context/context-budget'
import type { ContextSection } from '../services/context/context-budget'
import type { ResolvedAction } from '../services/actions/action-resolution'
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

/** One entry of the preview's editor picker. */
export interface PreviewEditorChoice {
    readonly id: string
    readonly name: string
}

/** One entry of the preview's action picker (`id === null` = plain review). */
export interface PreviewActionChoice {
    readonly id: string | null
    readonly name: string
}

/** The picker entry for "no action" — a plain review of the note. */
export const PREVIEW_NO_ACTION: PreviewActionChoice = { id: null, name: 'Review (no action)' }

/**
 * The action picker's entries: a plain review first, then every DISPATCHABLE
 * bound action, in settings order.
 *
 * This picker exists because an action's instruction is content that leaves the
 * vault and the preview could not show it: a custom action inlines its
 * referenced notes into the instruction, so up to `CUSTOM_INSTRUCTION_MAX_CHARS`
 * of vault text can ride a run that the "what will be sent" surface described
 * without them.
 */
export function previewActionChoices(actions: readonly ResolvedAction[]): PreviewActionChoice[] {
    return [
        PREVIEW_NO_ACTION,
        ...actions.map((action) => ({ id: action.bindingId, name: action.label }))
    ]
}

/**
 * Editors the picker offers: the ENABLED ones, in settings order. A disabled
 * editor never runs, so "what would it send" has no honest answer. The
 * settings dialog's own Preview button bypasses this and previews the editor
 * being edited whatever its state — there the question is about the draft, not
 * about the next run.
 */
export function previewEditorChoices(settings: PluginSettingsV1): PreviewEditorChoice[] {
    return settings.editors
        .filter((editor) => editor.enabled)
        .map((editor) => ({ id: editor.id, name: editor.name }))
}

/**
 * What a refusal reads as in the modal. Kept here so the two refusals stay
 * distinguishable in words, not just in a status string: `excluded` is fixed in
 * the Behavior tab, `rule-disabled` in the Rules tab.
 */
export function refusalMessage(result: Exclude<ContextPreviewResult, { status: 'ready' }>): string {
    switch (result.status) {
        case 'excluded':
            return `Nothing would be sent: ${result.notePath} is excluded from AI processing. Change that in the Behavior tab's privacy exclusions.`
        case 'rule-disabled':
            return `Nothing would be sent: the binding rule "${result.ruleLabel}" switches AI Editor off for this note. Change that in the Rules tab.`
        case 'note-unreadable':
            return `Nothing to preview: ${result.notePath} could not be read.`
        case 'editor-missing':
            return 'Nothing to preview: this editor no longer exists.'
        case 'action-unavailable':
            return `Nothing would be sent: ${result.label} cannot run — it was removed, or every note its instruction references is missing or excluded.`
    }
}

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
    const instruction = preview.instruction
    if (instruction !== null) {
        // An action's instruction is content leaving the vault — a custom one
        // inlines its referenced notes — and it is NOT part of the budget, so
        // it gets its own line rather than hiding inside the totals.
        lines.push(
            instruction.inSystemPrompt
                ? `Instruction (${instruction.label}): ${formatChars(instruction.text.length)}, appended to the system prompt below.`
                : `Instruction (${instruction.label}): ${formatChars(instruction.text.length)}, sent with the request — not part of the system prompt, and not counted in the budget above.`
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
    const instruction = preview.instruction
    return [
        `AI Editor — what will be sent`,
        `Editor: ${preview.editorName}`,
        `Note: ${preview.notePath}`,
        ...(instruction === null ? [] : [`Action: ${instruction.label}`]),
        '',
        ...previewSummaryLines(preview),
        '',
        'Sections:',
        ...rows,
        // A transform/generate instruction is never inside the system prompt,
        // so pasting the prompt alone would not reproduce the request.
        ...(instruction === null || instruction.inSystemPrompt
            ? []
            : ['', 'Instruction:', instruction.text]),
        '',
        'System prompt:',
        preview.systemPrompt
    ].join('\n')
}
