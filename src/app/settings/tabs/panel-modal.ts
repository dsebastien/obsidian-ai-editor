import { Modal, Notice, Setting } from 'obsidian'
import type { App } from 'obsidian'
import { panelConfigSchema } from '../../domain/settings/settings-schema'
import type { PanelConfig } from '../../domain/settings/settings-schema'
import { generateId } from '../../domain/ids'
import {
    populateBackendDropdown,
    renderColorDot,
    renderColorField,
    renderNoteRefsEditor,
    renderPromptTextArea
} from '../components'
import { commit } from './shared'
import type { TabContext } from './shared'

/**
 * Create/edit dialog for one panel (1-n member editors + aggregation
 * charter). Works on a local draft; Save validates that at least one member
 * editor is selected before anything persists.
 */
export class PanelModal extends Modal {
    private readonly ctx: TabContext
    private readonly draft: PanelConfig
    private readonly isNew: boolean

    constructor(app: App, ctx: TabContext, existing: PanelConfig | null) {
        super(app)
        this.ctx = ctx
        this.isNew = existing === null
        this.draft = existing
            ? structuredClone(existing)
            : // memberEditorIds has a min(1) constraint: parse with a throwaway
              // member, then start empty so the user picks members explicitly.
              {
                  ...panelConfigSchema.parse({
                      id: generateId(),
                      name: 'New panel',
                      memberEditorIds: ['placeholder']
                  }),
                  memberEditorIds: []
              }
    }

    override onOpen(): void {
        this.setTitle(this.isNew ? 'Add panel' : `Edit panel: ${this.draft.name}`)
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
            .setDesc('Shown with a ringed dot so panels never look like editors.')
            .addText((text) => {
                text.setValue(this.draft.name)
                text.onChange((value) => {
                    this.draft.name = value
                })
            })

        renderColorField(contentEl, {
            label: 'Color',
            variant: 'panel',
            get: () => this.draft.color,
            set: (color) => {
                this.draft.color = color
            }
        })

        new Setting(contentEl).setName('Members').setHeading()
        if (settings.editors.length === 0) {
            contentEl.createEl('p', {
                cls: 'ai-editor-empty-state',
                text: 'No editors exist yet — create editors first, then compose panels from them.'
            })
        }
        for (const editor of settings.editors) {
            const nameFragment = new DocumentFragment()
            renderColorDot(nameFragment, editor.color, 'editor')
            nameFragment.createSpan({ text: editor.name })
            new Setting(contentEl).setName(nameFragment).addToggle((toggle) => {
                toggle.setValue(this.draft.memberEditorIds.includes(editor.id))
                toggle.onChange((value) => {
                    if (value) {
                        if (!this.draft.memberEditorIds.includes(editor.id)) {
                            this.draft.memberEditorIds.push(editor.id)
                        }
                    } else {
                        this.draft.memberEditorIds = this.draft.memberEditorIds.filter(
                            (memberId) => memberId !== editor.id
                        )
                    }
                })
            })
        }

        renderPromptTextArea(contentEl, {
            name: 'Charter',
            desc: 'Aggregation instructions: how member findings become a scorecard (verdicts, top fixes, dissent).',
            placeholder: 'Weigh the Hater’s objections double…',
            get: () => this.draft.charter.text,
            set: (value) => {
                this.draft.charter.text = value
            }
        })

        renderNoteRefsEditor(contentEl, {
            name: 'Charter notes',
            desc: 'Vault notes appended to the charter, resolved fresh at every run.',
            getPaths: () => this.draft.charter.notePaths,
            setPaths: (paths) => {
                this.draft.charter.notePaths = paths
            }
        })

        new Setting(contentEl)
            .setName('Aggregation backend')
            .setDesc('Backend powering the scorecard call. Inherits the global default when unset.')
            .addDropdown((dropdown) => {
                populateBackendDropdown(dropdown, settings, 'Inherit global default')
                dropdown.setValue(this.draft.aggregationBackend?.backendId ?? '')
                dropdown.onChange((value) => {
                    this.draft.aggregationBackend =
                        value.length > 0
                            ? {
                                  backendId: value,
                                  model: this.draft.aggregationBackend?.model ?? ''
                              }
                            : null
                    this.renderContent()
                })
            })
        if (this.draft.aggregationBackend) {
            new Setting(contentEl)
                .setName('Aggregation model override')
                .setDesc('Leave empty to use the backend’s default model.')
                .addText((text) => {
                    text.setValue(this.draft.aggregationBackend?.model ?? '')
                    text.onChange((value) => {
                        if (this.draft.aggregationBackend) {
                            this.draft.aggregationBackend.model = value
                        }
                    })
                })
        }

        new Setting(contentEl)
            .addButton((button) => {
                button.setButtonText('Cancel').onClick(() => this.close())
            })
            .addButton((button) => {
                button
                    .setButtonText(this.isNew ? 'Add panel' : 'Save')
                    .setCta()
                    .onClick(() => this.save())
            })
    }

    private save(): void {
        this.draft.name = this.draft.name.trim()
        if (this.draft.name.length === 0) {
            new Notice('A name is required.')
            return
        }
        if (this.draft.memberEditorIds.length === 0) {
            new Notice('Select at least one member editor.')
            return
        }
        const parsed = panelConfigSchema.safeParse(this.draft)
        if (!parsed.success) {
            new Notice('Invalid panel configuration.')
            return
        }
        commit(
            this.ctx,
            (draft) => {
                const index = draft.panels.findIndex((panel) => panel.id === parsed.data.id)
                if (index >= 0) {
                    draft.panels[index] = parsed.data
                } else {
                    draft.panels.push(parsed.data)
                }
            },
            { refresh: true }
        )
        this.close()
    }
}
