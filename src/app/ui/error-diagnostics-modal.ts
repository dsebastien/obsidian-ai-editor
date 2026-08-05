import { Modal, Notice } from 'obsidian'
import type { App } from 'obsidian'
import type { OperationErrorDiagnostics } from '../domain/operations/contract'

/**
 * "Show details" modal for a failed run (issue #39): the captured output of a
 * CLI tool that failed, rendered ONLY because the user asked for it.
 *
 * This is the explicit-gesture surface the contract's `diagnostics` field
 * demands. The content can quote the tool's configuration — and a tool's
 * configuration can hold its credentials — which is why it is never in the
 * error message, never in a Notice, and why the modal leads with a caveat
 * instead of the content being pasted straight into a bug report. The copy
 * button exists because a bug report is still exactly where this text should
 * end up once the user has read it and redacted what is theirs.
 *
 * Render-only by construction: the modal receives the diagnostics object and
 * a label, calls `reveal()` once, and decides nothing.
 */
export class ErrorDiagnosticsModal extends Modal {
    private readonly diagnostics: OperationErrorDiagnostics
    private readonly sourceLabel: string

    constructor(app: App, sourceLabel: string, diagnostics: OperationErrorDiagnostics) {
        super(app)
        this.diagnostics = diagnostics
        this.sourceLabel = sourceLabel
    }

    override onOpen(): void {
        this.titleEl.setText(`Failure details — ${this.sourceLabel}`)
        this.modalEl.addClass('editor-ai-diagnostics-modal')
        const content = this.diagnostics.reveal()
        this.contentEl.createEl('p', {
            cls: 'editor-ai-diagnostics-caveat',
            text:
                'This is the raw output of the tool that failed. It can include the ' +
                'configuration the tool was given — check for anything sensitive before ' +
                'sharing it.'
        })
        this.contentEl.createEl('pre', {
            cls: 'editor-ai-diagnostics-content',
            text: content
        })
        const copyEl = this.contentEl.createEl('button', {
            cls: 'editor-ai-diagnostics-copy',
            text: 'Copy details'
        })
        copyEl.addEventListener('click', () => {
            void navigator.clipboard.writeText(content).then(() => {
                new Notice('Failure details copied.')
            })
        })
    }

    override onClose(): void {
        this.contentEl.empty()
    }
}
