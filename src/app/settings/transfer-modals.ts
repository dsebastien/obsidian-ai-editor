import { Modal, Notice, Setting, TFile, TFolder } from 'obsidian'
import type { App } from 'obsidian'
import {
    ALL_SECTIONS,
    TRANSFER_SECTIONS,
    exportCounts,
    exportSecretRisks,
    exportSettingsJson,
    importPlanIsEmpty,
    planImportFromJson
} from '../domain/settings/settings-transfer'
import type { SettingsImportPlan, TransferSection } from '../domain/settings/settings-transfer'
import type { PluginSettingsV1 } from '../domain/settings/settings-schema'
import { ConfirmModal } from './components'
import {
    DEFAULT_EXPORT_PATH,
    EXPORT_KEY_NOTICE,
    IMPORT_KEY_NOTICE,
    adjustmentLine,
    exportRiskLines,
    exportSummaryLine,
    hasSelection,
    importDestinationLines,
    importErrorMessage,
    importParticipationLine,
    importSummaryLines,
    normalizeExportPath,
    rejectionLine,
    sectionTitle
} from './transfer-model'

/**
 * Import/export dialogs (plan M5). Thin glue over `settings-transfer.ts` (what
 * a transfer IS) and `transfer-model.ts` (what the user reads): these classes
 * only wire checkboxes, read/write one vault file, and commit a confirmed plan
 * through the facade.
 *
 * Both dialogs state the API-key rule on screen, because "my keys are in this
 * file" is the one wrong assumption a user could act on by sharing it. The
 * export dialog additionally names any backend whose base URL or advanced
 * request body could still hold a credential, and the import dialog names the
 * HOST each imported backend points at — a file that adds a review
 * participant is a file that adds a destination for your notes.
 */

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export class ExportSettingsModal extends Modal {
    private readonly getSettings: () => PluginSettingsV1
    private readonly selection: Record<TransferSection, boolean> = { ...ALL_SECTIONS }
    private path = DEFAULT_EXPORT_PATH
    private summaryEl: HTMLElement | null = null
    private riskEl: HTMLElement | null = null

    constructor(app: App, getSettings: () => PluginSettingsV1) {
        super(app)
        this.getSettings = getSettings
    }

    override onOpen(): void {
        this.setTitle('Export settings')
        this.modalEl.addClass('ai-editor-modal')
        const { contentEl } = this

        contentEl.createEl('p', {
            text: 'Pick what to include. The file is plain JSON — keep it in the vault, or paste it into another vault.'
        })
        contentEl.createEl('p', { cls: 'ai-editor-transfer-notice', text: EXPORT_KEY_NOTICE })
        this.riskEl = contentEl.createDiv({ cls: 'ai-editor-transfer-risks' })

        for (const section of TRANSFER_SECTIONS) {
            new Setting(contentEl).setName(sectionTitle(section)).addToggle((toggle) => {
                toggle.setValue(this.selection[section])
                toggle.onChange((value) => {
                    this.selection[section] = value
                    this.renderSummary()
                })
            })
        }

        new Setting(contentEl)
            .setName('Vault path')
            .setDesc('Where to write the file, relative to the vault root.')
            .addText((text) => {
                text.setPlaceholder(DEFAULT_EXPORT_PATH)
                text.setValue(this.path)
                text.onChange((value) => {
                    this.path = value
                })
            })

        this.summaryEl = contentEl.createEl('p', { cls: 'ai-editor-transfer-summary' })
        this.renderSummary()

        new Setting(contentEl)
            .addButton((button) => {
                button.setButtonText('Cancel').onClick(() => this.close())
            })
            .addButton((button) => {
                button.setButtonText('Copy to clipboard').onClick(() => {
                    void this.copy()
                })
            })
            .addButton((button) => {
                button
                    .setButtonText('Save to vault')
                    .setCta()
                    .onClick(() => {
                        void this.save()
                    })
            })
    }

    override onClose(): void {
        this.summaryEl = null
        this.riskEl = null
        this.contentEl.empty()
    }

    private renderSummary(): void {
        const settings = this.getSettings()
        if (this.summaryEl) {
            this.summaryEl.setText(exportSummaryLine(exportCounts(settings, this.selection)))
        }
        if (this.riskEl) {
            this.riskEl.empty()
            for (const line of exportRiskLines(exportSecretRisks(settings, this.selection))) {
                this.riskEl.createEl('p', { cls: 'ai-editor-transfer-notice', text: line })
            }
        }
    }

    private json(): string | null {
        if (!hasSelection(this.selection)) {
            new Notice('Select at least one section to export.')
            return null
        }
        return exportSettingsJson(this.getSettings(), this.selection)
    }

    private async copy(): Promise<void> {
        const json = this.json()
        if (json === null) {
            return
        }
        try {
            await navigator.clipboard.writeText(json)
            new Notice('Settings copied to the clipboard.')
            this.close()
        } catch {
            new Notice('Could not copy to the clipboard.')
        }
    }

    private async save(): Promise<void> {
        const json = this.json()
        if (json === null) {
            return
        }
        const target = normalizeExportPath(this.path)
        if (!target.ok) {
            new Notice(target.message)
            return
        }
        const path = target.path
        const existing = this.app.vault.getAbstractFileByPath(path)
        if (existing instanceof TFolder) {
            new Notice(`${path} is a folder — pick a file name.`)
            return
        }
        if (existing instanceof TFile) {
            // Overwriting a file the user already has is never done silently.
            new ConfirmModal(this.app, {
                title: 'Overwrite file',
                message: `${path} already exists. Replace its contents with this export?`,
                impactLines: [],
                ctaLabel: 'Overwrite',
                onConfirm: () => {
                    void this.write(() => this.app.vault.modify(existing, json), path)
                }
            }).open()
            return
        }
        await this.write(async () => {
            await this.app.vault.create(path, json)
        }, path)
    }

    private async write(operation: () => Promise<unknown>, path: string): Promise<void> {
        try {
            await operation()
            new Notice(`Settings exported to ${path}.`)
            this.close()
        } catch {
            // Missing folder, permissions, sync conflict — all the same to the
            // user: the file was not written, and the dialog stays open.
            new Notice(`Could not write ${path}. Check the folder exists.`)
        }
    }
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

export class ImportSettingsModal extends Modal {
    private readonly getSettings: () => PluginSettingsV1
    private readonly commitPlan: (plan: SettingsImportPlan) => Promise<void>
    private text = ''
    private path = ''
    private plan: SettingsImportPlan | null = null
    private reviewEl: HTMLElement | null = null
    private importButtonEl: HTMLButtonElement | null = null

    constructor(
        app: App,
        input: {
            readonly getSettings: () => PluginSettingsV1
            readonly commitPlan: (plan: SettingsImportPlan) => Promise<void>
        }
    ) {
        super(app)
        this.getSettings = input.getSettings
        this.commitPlan = input.commitPlan
    }

    override onOpen(): void {
        this.setTitle('Import settings')
        this.modalEl.addClass('ai-editor-modal')
        const { contentEl } = this

        contentEl.createEl('p', {
            text: 'Imported entities are ADDED to what you already have, with new internal ids — nothing you configured is overwritten. You confirm a summary before anything is saved.'
        })

        new Setting(contentEl)
            .setName('Load from the vault')
            .setDesc('Path of an exported JSON file, relative to the vault root.')
            .addText((text) => {
                text.setPlaceholder(DEFAULT_EXPORT_PATH)
                text.onChange((value) => {
                    this.path = value
                })
            })
            .addButton((button) => {
                button.setButtonText('Load').onClick(() => {
                    void this.load()
                })
            })

        new Setting(contentEl)
            .setName('Or paste the JSON')
            .setClass('ai-editor-settings-textarea')
            .addTextArea((textArea) => {
                textArea.setPlaceholder('{ "format": "ai-editor-settings", … }')
                textArea.onChange((value) => {
                    this.text = value
                    this.review()
                })
            })

        this.reviewEl = contentEl.createDiv({ cls: 'ai-editor-transfer-review' })

        new Setting(contentEl)
            .addButton((button) => {
                button.setButtonText('Cancel').onClick(() => this.close())
            })
            .addButton((button) => {
                this.importButtonEl = button.buttonEl
                button
                    .setButtonText('Import')
                    .setCta()
                    .setDisabled(true)
                    .onClick(() => {
                        void this.commit()
                    })
            })
    }

    override onClose(): void {
        this.reviewEl = null
        this.importButtonEl = null
        this.plan = null
        this.contentEl.empty()
    }

    private async load(): Promise<void> {
        const target = normalizeExportPath(this.path)
        if (!target.ok) {
            new Notice(target.message)
            return
        }
        const path = target.path
        const file = this.app.vault.getFileByPath(path)
        if (!file) {
            new Notice(`No file at ${path}.`)
            return
        }
        try {
            this.text = await this.app.vault.read(file)
        } catch {
            new Notice(`Could not read ${path}.`)
            return
        }
        this.review()
    }

    /** Re-plans against the CURRENT settings on every input change. */
    private review(): void {
        const body = this.reviewEl
        if (!body) {
            return
        }
        body.empty()
        this.plan = null
        this.setImportEnabled(false)
        if (this.text.trim().length === 0) {
            return
        }
        const result = planImportFromJson(this.text, this.getSettings())
        if (!result.ok) {
            body.createEl('p', {
                cls: 'ai-editor-transfer-error',
                text: importErrorMessage(result.error)
            })
            return
        }
        const plan = result.plan
        const summary = body.createEl('ul', { cls: 'ai-editor-transfer-summary-list' })
        for (const line of importSummaryLines(plan)) {
            summary.createEl('li', { text: line })
        }
        // Where the notes would go, and who would see them — before the
        // confirmation, not after: counts alone never say which host a
        // backend points at, and an imported editor joins every review.
        const destinations = importDestinationLines(plan)
        if (destinations.length > 0) {
            body.createEl('h4', { text: 'Where these backends send your notes' })
            const list = body.createEl('ul', { cls: 'ai-editor-transfer-lines' })
            for (const line of destinations) {
                list.createEl('li', { text: line })
            }
        }
        const participation = importParticipationLine(plan)
        if (participation !== null) {
            body.createEl('p', { cls: 'ai-editor-transfer-notice', text: participation })
        }
        if (plan.adjustments.length > 0) {
            body.createEl('h4', { text: 'Adjusted' })
            const list = body.createEl('ul', { cls: 'ai-editor-transfer-lines' })
            for (const adjustment of plan.adjustments) {
                list.createEl('li', { text: adjustmentLine(adjustment) })
            }
        }
        if (plan.rejected.length > 0) {
            body.createEl('h4', { text: 'Skipped' })
            const list = body.createEl('ul', { cls: 'ai-editor-transfer-lines' })
            for (const rejection of plan.rejected) {
                list.createEl('li', { text: rejectionLine(rejection) })
            }
        }
        body.createEl('p', { cls: 'ai-editor-transfer-notice', text: IMPORT_KEY_NOTICE })
        if (importPlanIsEmpty(plan)) {
            // Nothing to confirm: a disabled CTA says that better than a
            // dialog that appears to succeed and changes nothing.
            return
        }
        this.plan = plan
        this.setImportEnabled(true)
    }

    private setImportEnabled(enabled: boolean): void {
        if (this.importButtonEl) {
            this.importButtonEl.disabled = !enabled
        }
    }

    private async commit(): Promise<void> {
        const plan = this.plan
        if (plan === null) {
            return
        }
        this.setImportEnabled(false)
        try {
            await this.commitPlan(plan)
        } catch {
            new Notice('AI Editor: failed to save the imported settings.')
            this.setImportEnabled(true)
            return
        }
        const added = plan.counts.reduce((total, entry) => total + entry.count, 0)
        new Notice(
            added > 0
                ? `Imported ${added} ${added === 1 ? 'entry' : 'entries'}. Check the Backends tab for API keys.`
                : 'Import applied.'
        )
        this.close()
    }
}
