import { TRANSFER_SECTIONS, sectionCountLabel } from '../domain/settings/settings-transfer'
import type {
    ImportAdjustment,
    ImportError,
    ImportRejection,
    SettingsImportPlan,
    TransferSection,
    TransferSelection
} from '../domain/settings/settings-transfer'

/**
 * Pure copy and input normalization for the import/export dialogs. Every
 * string a user reads about a transfer is built here, so the modals stay thin
 * glue and the wording is spec-covered — a confirmation the user is asked to
 * trust must not be assembled ad hoc in a click handler.
 */

const SECTION_TITLES: Record<TransferSection, string> = {
    backends: 'Backends',
    editors: 'Editors',
    panels: 'Panels',
    actions: 'Actions',
    rules: 'Rules',
    voiceProfile: 'Voice profile'
}

/** Checkbox label for a transfer section. */
export function sectionTitle(section: TransferSection): string {
    return SECTION_TITLES[section]
}

/** Default file name an export dialog opens with. */
export const DEFAULT_EXPORT_PATH = 'ai-editor-settings.json'

/**
 * Normalizes a user-typed vault path: trimmed, no leading slash, `.json`
 * appended when missing (the file is JSON, and a `.md` extension would make
 * Obsidian open it as a note). An empty or slash-only value falls back to the
 * default name rather than failing the write.
 */
export function normalizeExportPath(raw: string): string {
    let path = raw.trim()
    while (path.startsWith('/')) {
        path = path.slice(1)
    }
    if (path.length === 0 || path.endsWith('/')) {
        return `${path}${DEFAULT_EXPORT_PATH}`
    }
    return path.toLowerCase().endsWith('.json') ? path : `${path}.json`
}

/** Whether at least one section is selected (an empty export is not one). */
export function hasSelection(selection: TransferSelection): boolean {
    return TRANSFER_SECTIONS.some((section) => selection[section])
}

/**
 * What an export will contain — the one line the export dialog leads with, so
 * "nothing selected" is as visible as a populated selection.
 */
export function exportSummaryLine(
    counts: readonly { readonly section: TransferSection; readonly count: number }[]
): string {
    if (counts.length === 0) {
        return 'Nothing selected.'
    }
    const parts = counts.map((entry) => sectionCountLabel(entry.section, entry.count))
    return `Will export: ${parts.join(', ')}.`
}

/** Always stated on the export dialog: keys are never in the file. */
export const EXPORT_KEY_NOTICE =
    'API keys are never exported. Whoever imports this file enters their own.'

/** Always stated on the import summary: keys have to be re-entered. */
export const IMPORT_KEY_NOTICE =
    'API keys are never imported — open the Backends tab and enter yours before running anything.'

/**
 * The import confirmation summary, in reading order: what will be added, what
 * will be replaced, and what could not be kept. The caller shows these before
 * anything is written.
 */
export function importSummaryLines(plan: SettingsImportPlan): string[] {
    const lines: string[] = []
    if (plan.counts.length === 0) {
        lines.push('Nothing would be added.')
    } else {
        const parts = plan.counts
            .filter((entry) => entry.section !== 'voiceProfile')
            .map((entry) => sectionCountLabel(entry.section, entry.count))
        if (parts.length > 0) {
            lines.push(`Will be added: ${parts.join(', ')}.`)
        }
    }
    if (plan.voiceProfile !== null) {
        lines.push('Your voice profile will be REPLACED by the imported one.')
    }
    if (plan.rejected.length > 0) {
        lines.push(
            `${plan.rejected.length} ${plan.rejected.length === 1 ? 'entry' : 'entries'} will be skipped.`
        )
    }
    return lines
}

const REJECT_REASONS: Record<ImportRejection['reason'], string> = {
    'invalid': 'not valid for this version of the plugin',
    'no-member-editor': 'none of its member editors exist here',
    'already-bound': 'that action is already bound here',
    'section-full': 'no room left in this section'
}

/** One line per skipped entry: which one, and why. */
export function rejectionLine(rejection: ImportRejection): string {
    const name =
        rejection.label.length > 0
            ? `${sectionTitle(rejection.section)} “${rejection.label}”`
            : `${sectionTitle(rejection.section)} entry ${rejection.index + 1}`
    return `${name} — ${REJECT_REASONS[rejection.reason]}`
}

/** One line per reference the import had to change to stay coherent. */
export function adjustmentLine(adjustment: ImportAdjustment): string {
    switch (adjustment.kind) {
        case 'api-key-cleared':
            return `${adjustment.label} — its API key was not imported; enter yours.`
        case 'backend-cleared':
            return `${adjustment.label} — its backend is not in this file; it will use your default backend.`
        case 'target-cleared':
            return `${adjustment.label} — what it was bound to is not in this file; it will arrive unbound.`
        case 'members-dropped':
            return `${adjustment.label} — ${adjustment.count} member ${
                adjustment.count === 1 ? 'editor' : 'editors'
            } could not be found; the panel keeps the rest.`
        case 'voice-profile-replaced':
            return 'Voice profile — the imported one replaces yours.'
    }
}

/** Why a file could not be read as an import at all. */
export function importErrorMessage(error: ImportError): string {
    switch (error) {
        case 'not-json':
            return 'That is not valid JSON. Paste an exported file, or pick one from the vault.'
        case 'not-an-object':
            return 'That JSON is not an AI Editor export.'
        case 'no-sections':
            return 'That file carries no AI Editor settings — no backends, editors, panels, actions, rules, or voice profile.'
    }
}
