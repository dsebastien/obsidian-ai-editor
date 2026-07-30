import { Modal, Notice, Setting } from 'obsidian'
import type { App } from 'obsidian'
import type { ContextPreviewResult } from '../services/context-preview-service'
import {
    previewClipboardText,
    previewSummaryLines,
    refusalMessage,
    sectionRows
} from './context-preview-model'
import type { PreviewEditorChoice } from './context-preview-model'

/**
 * "What will be sent" modal (plan M5): shows the ACTUAL assembled context for
 * one editor and one note — total and per-section character counts, what the
 * budget truncated or dropped, and the verbatim system prompt — read-only,
 * with a copy button.
 *
 * Two invariants this class exists to keep:
 * - **It never sends anything.** There is no dispatch path in here; the
 *   injected `resolve` callback is `previewEditorContext`, which builds the
 *   prompt and returns it.
 * - **It renders, it does not decide.** Every string comes from
 *   `context-preview-model.ts` and every number from the assembler's budget
 *   report, so what the user reads is what the request carries.
 *
 * Thin glue by construction: picker → resolve → render. Re-resolving on every
 * picker change is deliberate — each editor has its own persona, voice-profile
 * opt-in and linked-note settings, so there is no shared result to cache, and
 * a stale panel here would be a lie.
 */
export class ContextPreviewModal extends Modal {
    private readonly choices: readonly PreviewEditorChoice[]
    private readonly resolve: (editorId: string) => Promise<ContextPreviewResult>
    private readonly notePath: string
    private selectedEditorId: string
    private bodyEl: HTMLElement | null = null
    private latest: ContextPreviewResult | null = null
    /** Guards against an out-of-order resolve landing after a newer one. */
    private renderToken = 0

    constructor(
        app: App,
        input: {
            readonly notePath: string
            readonly choices: readonly PreviewEditorChoice[]
            readonly resolve: (editorId: string) => Promise<ContextPreviewResult>
        }
    ) {
        super(app)
        this.notePath = input.notePath
        this.choices = input.choices
        this.resolve = input.resolve
        this.selectedEditorId = input.choices[0]?.id ?? ''
    }

    override onOpen(): void {
        this.setTitle('What will be sent')
        this.modalEl.addClass('ai-editor-modal')
        this.modalEl.addClass('ai-editor-preview-modal')

        this.contentEl.createEl('p', {
            cls: 'ai-editor-preview-note',
            text: `Note: ${this.notePath}`
        })

        const editorSetting = new Setting(this.contentEl).setName('Editor')
        const single = this.choices.length === 1 ? this.choices[0] : undefined
        if (single) {
            editorSetting.controlEl.createSpan({
                cls: 'ai-editor-ask-single-editor',
                text: single.name
            })
        } else {
            editorSetting.addDropdown((dropdown) => {
                for (const choice of this.choices) {
                    dropdown.addOption(choice.id, choice.name)
                }
                dropdown.setValue(this.selectedEditorId).onChange((value) => {
                    this.selectedEditorId = value
                    void this.load()
                })
            })
        }

        this.bodyEl = this.contentEl.createDiv({ cls: 'ai-editor-preview-body' })

        new Setting(this.contentEl)
            .addButton((button) => {
                button.setButtonText('Copy').onClick(() => this.copy())
            })
            .addButton((button) => {
                button
                    .setButtonText('Close')
                    .setCta()
                    .onClick(() => this.close())
            })

        void this.load()
    }

    override onClose(): void {
        this.bodyEl = null
        this.latest = null
        this.contentEl.empty()
    }

    private async load(): Promise<void> {
        const token = ++this.renderToken
        const body = this.bodyEl
        if (!body) {
            return
        }
        body.empty()
        body.createEl('p', { cls: 'ai-editor-preview-status', text: 'Assembling…' })
        const result = await this.resolve(this.selectedEditorId)
        if (token !== this.renderToken || this.bodyEl !== body) {
            return // a newer selection already took over, or the modal closed
        }
        this.latest = result
        this.render(body, result)
    }

    private render(body: HTMLElement, result: ContextPreviewResult): void {
        body.empty()
        if (result.status !== 'ready') {
            body.createEl('p', {
                cls: 'ai-editor-preview-refusal',
                text: refusalMessage(result)
            })
            return
        }
        const preview = result.preview

        const summary = body.createEl('ul', { cls: 'ai-editor-preview-summary' })
        for (const line of previewSummaryLines(preview)) {
            summary.createEl('li', { text: line })
        }

        body.createEl('h4', { text: 'Sections' })
        const list = body.createDiv({ cls: 'ai-editor-preview-sections' })
        for (const row of sectionRows(preview)) {
            const rowEl = list.createDiv({
                cls: `ai-editor-preview-row ai-editor-preview-row-${row.status}`
            })
            rowEl.createSpan({ cls: 'ai-editor-preview-row-name', text: row.name })
            rowEl.createSpan({ cls: 'ai-editor-preview-row-detail', text: row.detail })
        }

        body.createEl('h4', { text: 'System prompt' })
        // A scrollable region must be keyboard reachable (WCAG 2.1.1), and the
        // accessible name has to say WHOSE prompt it is — the picker above can
        // change it.
        body.createEl('pre', {
            cls: 'ai-editor-preview-prompt',
            text: preview.systemPrompt,
            attr: {
                'tabindex': '0',
                'aria-label': `System prompt sent to ${preview.editorName}`
            }
        })
    }

    private copy(): void {
        const result = this.latest
        if (result === null) {
            return
        }
        const text =
            result.status === 'ready'
                ? previewClipboardText(result.preview)
                : refusalMessage(result)
        void navigator.clipboard
            .writeText(text)
            .then(() => {
                new Notice('Copied what would be sent.')
            })
            .catch(() => {
                new Notice('Could not copy to the clipboard.')
            })
    }
}
