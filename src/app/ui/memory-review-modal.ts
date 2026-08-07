import { Modal, Notice, Setting } from 'obsidian'
import type { App, ButtonComponent } from 'obsidian'
import { MEMORY_TEXT_MAX } from '../domain/operations/contract'

/**
 * Confirmation modal for a distilled editor memory (issue #4).
 *
 * Business Rules #2/#22: no AI output is written anywhere without the user
 * seeing — and being able to amend — the exact text. The proposal arrives in
 * an editable textarea; the previous memory is shown collapsed for
 * comparison; only Save persists, through the narrow seam the caller injects
 * (`onSave` — a settings write or a memory-note write, never both, and never
 * the whole settings facade).
 *
 * The caller clears the triage journal in `onSave` AFTER the write succeeds —
 * Cancel (or a failed save) keeps the session's signal intact.
 */
export interface MemoryReviewModalInput {
    readonly editorName: string
    /** Where a save lands, for the modal's subtitle ("Plugin settings" / a note path). */
    readonly destinationLabel: string
    /** How many triage decisions fed the distillation. */
    readonly eventCount: number
    readonly previousMemory: string
    readonly proposedMemory: string
    /** Persists the (possibly amended) memory. Rejections surface as a Notice. */
    readonly onSave: (memory: string) => Promise<void>
    /** Fires when the modal closes, saved or not (in-flight bookkeeping). */
    readonly onDone?: () => void
}

/**
 * Runs `notify` after `pending` settles — immediately when nothing is
 * pending. Success and failure both notify (the caller is bookkeeping, not
 * error handling), and a rejected promise is swallowed here because the
 * save path already awaited and reported it.
 *
 * This is the modal's in-flight-guard discipline (`onDone` releases the
 * command's per-editor guard): closing the modal DURING a slow save must
 * not release the guard while the journal is still populated — a second
 * distillation could launch, paying for the same events again and stacking
 * a second modal over a write still landing.
 */
export function notifyAfterSettled(
    pending: Promise<void> | null,
    notify: (() => void) | undefined
): void {
    if (pending === null) {
        notify?.()
        return
    }
    void pending.then(
        () => notify?.(),
        () => notify?.()
    )
}

export class MemoryReviewModal extends Modal {
    private textareaEl: HTMLTextAreaElement | null = null
    private saveButton: ButtonComponent | null = null
    private saving = false
    /** The in-flight (or last) save; `onClose` defers `onDone` until it settles. */
    private savePromise: Promise<void> | null = null

    constructor(
        app: App,
        private readonly input: MemoryReviewModalInput
    ) {
        super(app)
    }

    override onOpen(): void {
        this.setTitle(`Learned memory: ${this.input.editorName}`)
        this.modalEl.addClass('editor-ai-daemons-modal')
        const { contentEl } = this
        const decisions =
            this.input.eventCount === 1 ? '1 decision' : `${this.input.eventCount} decisions`
        contentEl.createEl('p', {
            cls: 'editor-ai-daemons-tab-intro',
            text:
                `Distilled from ${decisions} you made this session. Review and edit the text — ` +
                `it replaces the editor's memory in ${this.input.destinationLabel} when you save. ` +
                'Nothing is saved if you cancel.'
        })

        const details = contentEl.createEl('details', { cls: 'editor-ai-daemons-memory-previous' })
        details.createEl('summary', { text: 'Previous memory' })
        details.createEl('pre', {
            text: this.input.previousMemory.length > 0 ? this.input.previousMemory : '(empty)'
        })

        const textarea = contentEl.createEl('textarea', {
            cls: 'editor-ai-daemons-ask-textarea editor-ai-daemons-memory-textarea',
            attr: { 'rows': '12', 'aria-label': 'Proposed memory (editable)' }
        })
        textarea.value = this.input.proposedMemory
        textarea.addEventListener('input', () => this.syncSaveButton())
        this.textareaEl = textarea

        new Setting(contentEl)
            .addButton((button) => {
                button.setButtonText('Cancel').onClick(() => this.close())
            })
            .addButton((button) => {
                this.saveButton = button
                button
                    .setButtonText('Save memory')
                    .setCta()
                    .onClick(() => void this.save())
            })
    }

    override onClose(): void {
        this.textareaEl = null
        this.saveButton = null
        this.contentEl.empty()
        // Escape/Cancel during a slow save: hold the caller's in-flight
        // guard until the save settles (see `notifyAfterSettled`).
        notifyAfterSettled(this.savePromise, this.input.onDone)
    }

    private syncSaveButton(): void {
        const blank = (this.textareaEl?.value.trim().length ?? 0) === 0
        this.saveButton?.setDisabled(blank || this.saving)
    }

    private async save(): Promise<void> {
        const memory = this.textareaEl?.value.trim() ?? ''
        if (memory.length === 0 || this.saving) {
            return
        }
        // The contract's memory ceiling. An amended text past it would fail
        // settings-schema validation with an opaque "rejected a settings
        // update" Notice — a dead end with no hint which field or limit.
        // Name the limit here instead, before anything is attempted.
        if (memory.length > MEMORY_TEXT_MAX) {
            new Notice(
                `AI Editor: the memory is too long (${String(memory.length)} characters; the maximum is ${String(MEMORY_TEXT_MAX)}). Shorten it and save again.`
            )
            return
        }
        this.saving = true
        this.saveButton?.setDisabled(true)
        const pending = this.input.onSave(memory)
        this.savePromise = pending
        try {
            await pending
            this.close()
        } catch (error) {
            this.saving = false
            this.syncSaveButton()
            new Notice(
                `AI Editor: could not save the memory (${error instanceof Error ? error.message : String(error)})`
            )
        }
    }
}
