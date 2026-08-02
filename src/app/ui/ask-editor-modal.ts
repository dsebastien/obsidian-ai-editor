import { Modal, Setting } from 'obsidian'
import type { App, ButtonComponent } from 'obsidian'
import {
    askChoiceLabel,
    canSubmitAsk,
    defaultAskEditor,
    normalizeInstruction
} from './ask-editor-model'
import type { AskEditorChoice } from './ask-editor-model'

/**
 * Wording and defaults that differ between the two things this dialog is.
 *
 * ONE modal serves both because the interaction is identical — pick an
 * editor, type a question, send — and the difference is entirely in what
 * happens next: an ask runs a review you watch, a comment parks a background
 * job whose answer lands in the margin. Two dialogs would have drifted apart
 * on keyboard handling, enablement and the single-editor case.
 */
export interface AskEditorCopy {
    readonly title: string
    /** Primary button text. */
    readonly cta: string
    readonly placeholder: string
    /** Sub-title explaining what the dialog will do; omitted when obvious. */
    readonly description?: string
    /** Editor pre-selected in the picker when it is on offer. */
    readonly preferredEditorId?: string
}

const ASK_EDITOR_COPY: AskEditorCopy = {
    // Intent-based name (issue #27, Sébastien's call): the picker says WHO
    // is being asked — an editor or a whole panel — so the title does not
    // have to carry the taxonomy.
    title: 'Ask a question',
    cta: 'Ask',
    placeholder: 'Is this argument convincing?'
}

/**
 * Freeform "Ask an editor" modal (design §6 decision 1, note-level entry
 * point): pick one review-capable editor, type an instruction, and run a
 * regular review scoped to the captured selection with that editor's prompt
 * augmented for this run only. Thin DOM glue — enablement and submission
 * decisions live in `ask-editor-model.ts`; the dispatch (selection contract,
 * prompt augmentation, run start) is entirely the `onSubmit` callback's
 * business (`ReviewController.openAskEditorModal`).
 *
 * Also serves "Ask for comments" (plan §5.5 / M8), with different copy and a
 * different default editor — see {@link AskEditorCopy}.
 *
 * Keyboard: Enter in the textarea inserts a newline (native behavior,
 * deliberately not intercepted); Ctrl/Cmd+Enter submits; Esc closes (Modal
 * default). The Ask button is the CTA and stays disabled while the
 * instruction is blank.
 */
export class AskEditorModal extends Modal {
    private readonly choices: readonly AskEditorChoice[]
    private readonly onSubmit: (editorId: string, instruction: string) => void
    private readonly copy: AskEditorCopy
    private selectedEditorId: string
    private textareaEl: HTMLTextAreaElement | null = null
    private askButton: ButtonComponent | null = null
    private submitted = false

    constructor(
        app: App,
        choices: readonly AskEditorChoice[],
        onSubmit: (editorId: string, instruction: string) => void,
        copy: AskEditorCopy = ASK_EDITOR_COPY
    ) {
        super(app)
        this.choices = choices
        this.onSubmit = onSubmit
        this.copy = copy
        this.selectedEditorId = defaultAskEditor(choices, copy.preferredEditorId)?.id ?? ''
    }

    override onOpen(): void {
        this.setTitle(this.copy.title)
        this.modalEl.addClass('editor-ai-daemons-modal')
        if (this.copy.description !== undefined) {
            this.contentEl.createEl('p', {
                cls: 'editor-ai-daemons-tab-intro',
                text: this.copy.description
            })
        }

        const hasPanels = this.choices.some((choice) => choice.kind === 'panel')
        const editorSetting = new Setting(this.contentEl).setName(
            hasPanels ? 'Editor or panel' : 'Editor'
        )
        const single = this.choices.length === 1 ? this.choices[0] : undefined
        if (single) {
            // Exactly one possible choice: static text, no pointless dropdown.
            editorSetting.controlEl.createSpan({
                cls: 'editor-ai-daemons-ask-single-editor',
                text: askChoiceLabel(single)
            })
        } else {
            editorSetting.addDropdown((dropdown) => {
                for (const choice of this.choices) {
                    // Panels marked "(panel · N requests)" — BR #11 plus the
                    // cost decision of issue #27.
                    dropdown.addOption(choice.id, askChoiceLabel(choice))
                }
                dropdown.setValue(this.selectedEditorId).onChange((value) => {
                    this.selectedEditorId = value
                })
            })
        }

        const textarea = this.contentEl.createEl('textarea', {
            cls: 'editor-ai-daemons-ask-textarea',
            attr: {
                'placeholder': this.copy.placeholder,
                'rows': '5',
                'aria-label': 'Instruction for the editor'
            }
        })
        this.textareaEl = textarea
        textarea.addEventListener('input', () => this.syncAskButton())
        textarea.addEventListener('keydown', (event) => {
            // Ctrl/Cmd+Enter submits; plain Enter falls through to the
            // textarea's native newline insertion.
            if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
                event.preventDefault()
                this.submit()
            }
        })

        new Setting(this.contentEl)
            .addButton((button) => {
                button.setButtonText('Cancel').onClick(() => this.close())
            })
            .addButton((button) => {
                this.askButton = button
                button
                    .setButtonText(this.copy.cta)
                    .setCta()
                    .setDisabled(true)
                    .onClick(() => this.submit())
            })

        textarea.focus()
    }

    override onClose(): void {
        this.textareaEl = null
        this.askButton = null
        this.contentEl.empty()
    }

    private syncAskButton(): void {
        this.askButton?.setDisabled(!canSubmitAsk(this.textareaEl?.value ?? ''))
    }

    private submit(): void {
        const instruction = normalizeInstruction(this.textareaEl?.value ?? '')
        if (instruction === null || this.selectedEditorId.length === 0 || this.submitted) {
            return
        }
        this.submitted = true
        this.close()
        this.onSubmit(this.selectedEditorId, instruction)
    }
}
