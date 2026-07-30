import { Modal, Notice, Setting } from 'obsidian'
import type { App } from 'obsidian'
import { editorConfigSchema } from '../../domain/settings/settings-schema'
import type { EditorConfig } from '../../domain/settings/settings-schema'
import { generateId } from '../../domain/ids'
import { previewEditorContext } from '../../services/context-preview-service'
import type { ContextPreviewResult } from '../../services/context-preview-service'
import { ContextPreviewModal } from '../../ui/context-preview-modal'
import { ObsidianVaultReader } from '../../ui/obsidian-vault-reader'
import {
    populateBackendDropdown,
    renderColorField,
    renderNoteRefsEditor,
    renderPromptTextArea
} from '../components'
import { commit } from './shared'
import type { TabContext } from './shared'

/**
 * Create/edit dialog for one editor persona. Works on a local draft; nothing
 * persists until Save passes validation, so Cancel is always safe.
 */
export class EditorModal extends Modal {
    private readonly ctx: TabContext
    private readonly draft: EditorConfig
    private readonly isNew: boolean

    constructor(app: App, ctx: TabContext, existing: EditorConfig | null) {
        super(app)
        this.ctx = ctx
        this.isNew = existing === null
        this.draft = existing
            ? structuredClone(existing)
            : editorConfigSchema.parse({ id: generateId(), name: 'New editor' })
    }

    override onOpen(): void {
        this.setTitle(this.isNew ? 'Add editor' : `Edit editor: ${this.draft.name}`)
        this.modalEl.addClass('ai-editor-modal')
        this.renderContent()
    }

    override onClose(): void {
        this.contentEl.empty()
    }

    private renderContent(): void {
        const { contentEl } = this
        contentEl.empty()
        const settings = this.ctx.facade.getSettings()

        new Setting(contentEl)
            .setName('Name')
            .setDesc('Shown in the rail, cards, and menus.')
            .addText((text) => {
                text.setValue(this.draft.name)
                text.onChange((value) => {
                    this.draft.name = value
                })
            })

        renderColorField(contentEl, {
            label: 'Color',
            variant: 'editor',
            get: () => this.draft.color,
            set: (color) => {
                this.draft.color = color
            }
        })

        renderPromptTextArea(contentEl, {
            name: 'Persona prompt',
            desc: 'Direct prompt text. Combined with the referenced notes below, in order, at run time.',
            placeholder: 'You are a ruthless concision editor…',
            get: () => this.draft.prompt.text,
            set: (value) => {
                this.draft.prompt.text = value
            }
        })

        renderNoteRefsEditor(contentEl, {
            app: this.app,
            name: 'Prompt notes',
            desc: 'Vault notes appended to the prompt, resolved fresh at every run — the vault is the config.',
            getPaths: () => this.draft.prompt.notePaths,
            setPaths: (paths) => {
                this.draft.prompt.notePaths = paths
            },
            followLinks: {
                get: () => this.draft.prompt.followLinks,
                set: (value) => {
                    this.draft.prompt.followLinks = value
                }
            }
        })

        new Setting(contentEl)
            .setName('Backend')
            .setDesc('Override the global default backend for this editor.')
            .addDropdown((dropdown) => {
                populateBackendDropdown(dropdown, settings, 'Inherit global default')
                dropdown.setValue(this.draft.backend?.backendId ?? '')
                dropdown.onChange((value) => {
                    this.draft.backend =
                        value.length > 0
                            ? { backendId: value, model: this.draft.backend?.model ?? '' }
                            : null
                    this.renderContent()
                })
            })
        if (this.draft.backend) {
            new Setting(contentEl)
                .setName('Model override')
                .setDesc('Leave empty to use the backend’s default model.')
                .addText((text) => {
                    text.setValue(this.draft.backend?.model ?? '')
                    text.onChange((value) => {
                        if (this.draft.backend) {
                            this.draft.backend.model = value
                        }
                    })
                })
        }

        new Setting(contentEl)
            .setName('Include linked notes')
            .setDesc(
                'Attach the notes the reviewed note links to as context. Links and embeds, ' +
                    'one hop only, capped below. Excluded notes are never attached, and the ' +
                    'context budget applies.'
            )
            .addToggle((toggle) => {
                toggle.setValue(this.draft.includeLinkedNotes)
                toggle.onChange((value) => {
                    this.draft.includeLinkedNotes = value
                    this.renderContent()
                })
            })
        if (this.draft.includeLinkedNotes) {
            new Setting(contentEl)
                .setName('Linked notes cap')
                .setDesc('Maximum number of linked notes to attach (1-20).')
                .addText((text) => {
                    text.inputEl.type = 'number'
                    text.inputEl.min = '1'
                    text.inputEl.max = '20'
                    text.setValue(String(this.draft.maxLinkedNotes))
                    text.inputEl.addEventListener('change', () => {
                        const parsed = Number.parseInt(text.inputEl.value, 10)
                        const next = Number.isNaN(parsed)
                            ? this.draft.maxLinkedNotes
                            : Math.min(20, Math.max(1, parsed))
                        this.draft.maxLinkedNotes = next
                        text.setValue(String(next))
                    })
                })
        }

        new Setting(contentEl)
            .setName('Inject voice profile')
            .setDesc('Prepend the global voice profile to this editor’s runs.')
            .addToggle((toggle) => {
                toggle.setValue(this.draft.injectVoiceProfile)
                toggle.onChange((value) => {
                    this.draft.injectVoiceProfile = value
                })
            })

        new Setting(contentEl).setName('Capabilities').setHeading()
        const capabilityRows: readonly {
            key: keyof EditorConfig['capabilities']
            name: string
            desc: string
        }[] = [
            { key: 'review', name: 'Review', desc: 'May critique and flag findings.' },
            { key: 'rewrite', name: 'Rewrite', desc: 'May propose replacement text.' },
            {
                key: 'research',
                name: 'Research',
                desc: 'May look things up when the backend supports it.'
            }
        ]
        for (const capability of capabilityRows) {
            new Setting(contentEl)
                .setName(capability.name)
                .setDesc(capability.desc)
                .addToggle((toggle) => {
                    toggle.setValue(this.draft.capabilities[capability.key])
                    toggle.onChange((value) => {
                        this.draft.capabilities[capability.key] = value
                    })
                })
        }

        new Setting(contentEl)
            .setName('Learning memory')
            .setDesc('Where accept/reject patterns are distilled for future runs.')
            .addDropdown((dropdown) => {
                dropdown.addOption('off', 'Off')
                dropdown.addOption('settings', 'Plugin settings')
                dropdown.addOption('note', 'Vault note')
                dropdown.setValue(this.draft.memory)
                dropdown.onChange((value) => {
                    if (value === 'off' || value === 'settings' || value === 'note') {
                        this.draft.memory = value
                        this.renderContent()
                    }
                })
            })
        if (this.draft.memory === 'note') {
            new Setting(contentEl)
                .setName('Memory note path')
                .setDesc('Vault note that stores what this editor learns (readable, editable).')
                .addText((text) => {
                    text.setPlaceholder('e.g. Meta/AI Editor/Concision memory.md')
                    text.setValue(this.draft.memoryNotePath)
                    text.onChange((value) => {
                        this.draft.memoryNotePath = value
                    })
                })
        }

        new Setting(contentEl)
            .setName('Preview what will be sent')
            .setDesc(
                'Assemble this editor’s context for the active note and show it, exactly as it would be sent. Uses the unsaved values above.'
            )
            .addButton((button) => {
                button.setButtonText('Preview').onClick(() => this.preview())
            })

        new Setting(contentEl)
            .addButton((button) => {
                button.setButtonText('Cancel').onClick(() => this.close())
            })
            .addButton((button) => {
                button
                    .setButtonText(this.isNew ? 'Add editor' : 'Save')
                    .setCta()
                    .onClick(() => this.save())
            })
    }

    /**
     * Opens the "what will be sent" preview for the DRAFT — the values in this
     * dialog, saved or not. Previewing the persona you are currently writing is
     * the whole point of the button; previewing the saved one would answer a
     * question nobody asked.
     *
     * The note is the workspace's active file read from the vault, not a live
     * buffer: the settings dialog covers the editor, so there is no focused
     * markdown view to read unsaved text from. The palette command
     * (`Preview what will be sent`) is the surface that uses the live buffer.
     */
    private preview(): void {
        const file = this.app.workspace.getActiveFile()
        if (!file) {
            new Notice('Open a note first — the preview needs something to assemble against.')
            return
        }
        const notePath = file.path
        const draft = structuredClone(this.draft)
        new ContextPreviewModal(this.app, {
            notePath,
            choices: [
                { id: draft.id, name: draft.name.trim().length > 0 ? draft.name : 'This editor' }
            ],
            // No action picker here: the question this button answers is
            // "what does the persona I am writing send", and an action's
            // instruction belongs to the dispatch surfaces.
            actions: [],
            resolve: (): Promise<ContextPreviewResult> =>
                previewEditorContext({
                    editor: draft,
                    settings: this.ctx.facade.getSettings(),
                    vault: new ObsidianVaultReader(this.app),
                    notePath
                })
        }).open()
    }

    private save(): void {
        this.draft.name = this.draft.name.trim()
        if (this.draft.name.length === 0) {
            new Notice('A name is required.')
            return
        }
        const parsed = editorConfigSchema.safeParse(this.draft)
        if (!parsed.success) {
            new Notice('Invalid editor configuration.')
            return
        }
        commit(
            this.ctx,
            (draft) => {
                const index = draft.editors.findIndex((editor) => editor.id === parsed.data.id)
                if (index >= 0) {
                    draft.editors[index] = parsed.data
                } else {
                    draft.editors.push(parsed.data)
                }
            },
            { refresh: true }
        )
        this.close()
    }
}
