import { TRANSFER_SECTIONS, sectionCountLabel } from '../domain/settings/settings-transfer'
import type {
    ExportBackendRisk,
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
export const DEFAULT_EXPORT_PATH = 'editor-ai-daemons-settings.json'

/** A typed export path, or the reason the typed one cannot be written. */
export type ExportPath =
    | { readonly ok: true; readonly path: string }
    | { readonly ok: false; readonly message: string }

/**
 * Normalizes a user-typed vault path: trimmed, backslashes folded to `/`, no
 * leading slash, `.json` appended when missing (the file is JSON, and a `.md`
 * extension would make Obsidian open it as a note). An empty or slash-only
 * value falls back to the default name rather than failing the write.
 *
 * Traversal is REFUSED rather than normalized away. `vault.create` joins the
 * path onto the vault's base path and the adapter resolves `..`, so a typed
 * `../editor-ai-daemons-settings.json` writes outside the vault — past Obsidian's
 * sandbox and past the caller's `getAbstractFileByPath` existence check, which
 * only ever sees in-vault paths and would therefore skip the overwrite
 * confirmation for exactly the files least safe to overwrite silently.
 */
export function normalizeExportPath(raw: string): ExportPath {
    let path = raw.trim().replace(/\\/g, '/')
    while (path.startsWith('/')) {
        path = path.slice(1)
    }
    if (path.length === 0 || path.endsWith('/')) {
        path = `${path}${DEFAULT_EXPORT_PATH}`
    } else if (!path.toLowerCase().endsWith('.json')) {
        path = `${path}.json`
    }
    if (path.split('/').some((segment) => segment === '.' || segment === '..')) {
        return {
            ok: false,
            message: 'The export path must stay inside the vault — remove the “..” segments.'
        }
    }
    return { ok: true, path }
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

/** Always stated on the export dialog: the key FIELD is never in the file. */
export const EXPORT_KEY_NOTICE =
    'The API key field is never exported. Whoever imports this file enters their own.'

/**
 * Shown when the selected backends carry a field that can still hold a
 * credential. The blanket "no secrets in here" claim was wrong: `baseUrl` and
 * `extraBodyJson` travel verbatim because they configure the request, and a
 * gateway URL of the form `https://gw.example/v1?api-key=…` (or an
 * `extraBodyJson` holding the token for a host that takes it in the body) is a
 * credential the export dialog must not describe as safe to share.
 */
export function exportRiskLines(risks: readonly ExportBackendRisk[]): string[] {
    if (risks.length === 0) {
        return []
    }
    const lines = [
        'Check these before sharing the file — these fields are exported as they are, because they configure the request:'
    ]
    for (const risk of risks) {
        const reasons = risk.risks.map((kind) =>
            kind === 'base-url-credentials'
                ? 'its base URL looks like it carries a key or a password'
                : 'it has a custom request body'
        )
        lines.push(`${risk.label} — ${reasons.join(', ')}.`)
    }
    return lines
}

/** Always stated on the import summary: keys have to be re-entered. */
export const IMPORT_KEY_NOTICE =
    'API keys are never imported, and imported backends arrive switched off — open the Backends tab, check where each one points, enter your key, and enable it.'

/**
 * Where each imported backend would send your notes. Shown BEFORE the import
 * is committed: a backend is a destination, the counts alone never say which
 * one, and stripping the key is no protection (Ollama needs none, and an
 * OpenAI-compatible host takes any key the user later enters).
 */
export function importDestinationLines(plan: SettingsImportPlan): string[] {
    return plan.additions.backends.map((backend) => {
        if (backend.family !== 'api') {
            return `${backend.label} — local command (${backend.kind}), disabled.`
        }
        const destination =
            backend.baseUrl.trim().length > 0 ? backend.baseUrl.trim() : `${backend.kind} default`
        const extra = backend.extraBodyJson.trim().length > 0 ? ', custom request body' : ''
        return `${backend.label} — ${backend.kind}, sends to ${destination}${extra}.`
    })
}

/**
 * Stated whenever the import brings editors that would join reviews. An editor
 * arrives enabled with the review capability on, and a review runs EVERY such
 * editor unless a rule assigns one — so an imported editor is not an inert
 * entry in a list, it is a participant that sees the note and its attachments.
 */
export function importParticipationLine(plan: SettingsImportPlan): string | null {
    const count = plan.additions.editors.filter(
        (editor) => editor.enabled && editor.capabilities.review
    ).length
    if (count === 0) {
        return null
    }
    return count === 1
        ? '1 imported editor is enabled and will take part in every review of every note.'
        : `${count} imported editors are enabled and will take part in every review of every note.`
}

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
        case 'backend-disabled':
            return `${adjustment.label} — imported switched off; enable it in the Backends tab once you have checked where it points.`
        case 'cli-consent-cleared':
            return `${adjustment.label} — consent to launch a program cannot be imported; you will be asked on this machine.`
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
