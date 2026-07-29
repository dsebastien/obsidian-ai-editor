import { Modal, Setting } from 'obsidian'
import type { App, ButtonComponent } from 'obsidian'
import { canSubmitAsk, defaultAskEditor, normalizeInstruction } from './ask-editor-model'
import type { AskEditorChoice } from './ask-editor-model'

/**
 * Freeform "Ask an editor" modal (design §6 decision 1, note-level entry
 * point): pick one review-capable editor, type an instruction, and run a
 * regular review scoped to the captured selection with that editor's prompt
 * augmented for this run only. Thin DOM glue — enablement and submission
 * decisions live in `ask-editor-model.ts`; the dispatch (selection contract,
 * prompt augmentation, run start) is entirely the `onSubmit` callback's
 * business (`ReviewController.openAskEditorModal`).
 *
 * Keyboard: Enter in the textarea inserts a newline (native behavior,
 * deliberately not intercepted); Ctrl/Cmd+Enter submits; Esc closes (Modal
 * default). The Ask button is the CTA and stays disabled while the
 * instruction is blank.
 */
export class AskEditorModal extends Modal {
    private readonly choices: readonly AskEditorChoice[]
    private readonly onSubmit: (editorId: string, instruction: string) => void
    private selectedEditorId: string
    private textareaEl: HTMLTextAreaElement | null = null
    private askButton: ButtonComponent | null = null
    private submitted = false

    constructor(
        app: App,
        choices: readonly AskEditorChoice[],
        onSubmit: (editorId: string, instruction: string) => void
    ) {
        super(app)
        this.choices = choices
        this.onSubmit = onSubmit
        this.selectedEditorId = defaultAskEditor(choices)?.id ?? ''
    }

    override onOpen(): void {
        this.setTitle('Ask an editor')
        this.modalEl.addClass('ai-editor-modal')

        const editorSetting = new Setting(this.contentEl).setName('Editor')
        const single = this.choices.length === 1 ? this.choices[0] : undefined
        if (single) {
            // Exactly one possible editor: static text, no pointless dropdown.
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
                })
            })
        }

        const textarea = this.contentEl.createEl('textarea', {
            cls: 'ai-editor-ask-textarea',
            attr: {
                'placeholder': 'Is this argument convincing?',
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
                    .setButtonText('Ask')
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
