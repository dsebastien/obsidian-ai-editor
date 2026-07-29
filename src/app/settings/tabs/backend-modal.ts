import { Modal, Notice, Setting } from 'obsidian'
import type { App } from 'obsidian'
import { apiBackendSchema } from '../../domain/settings/settings-schema'
import type { ApiBackend, ApiProviderKind } from '../../domain/settings/settings-schema'
import { generateId } from '../../domain/ids'
import { apiKindLabel, isInsecureRemoteUrl } from '../helpers'
import { commit } from './shared'
import type { TabContext } from './shared'

const BASE_URL_PLACEHOLDERS: Record<ApiProviderKind, string> = {
    'anthropic': 'Optional — defaults to https://api.anthropic.com',
    'openai': 'Optional — defaults to https://api.openai.com',
    'openai-compatible': 'https://openrouter.ai/api/v1',
    'azure-openai': 'https://<resource>.openai.azure.com',
    'ollama': 'http://localhost:11434'
}

const MODEL_PLACEHOLDERS: Record<ApiProviderKind, string> = {
    'anthropic': 'e.g. claude-sonnet-4-5',
    'openai': 'e.g. gpt-5.2',
    'openai-compatible': 'Model id expected by the endpoint',
    'azure-openai': 'Model behind the deployment',
    'ollama': 'e.g. llama3.3'
}

/**
 * Create/edit dialog for one API backend instance. Works on a local draft;
 * nothing is persisted until Save passes validation. CLI backends (Claude
 * Code, Codex) are a later milestone (M7) and are not offered here.
 */
export class BackendModal extends Modal {
    private readonly ctx: TabContext
    private readonly draft: ApiBackend
    private readonly isNew: boolean

    constructor(app: App, ctx: TabContext, existing: ApiBackend | null, kind: ApiProviderKind) {
        super(app)
        this.ctx = ctx
        this.isNew = existing === null
        this.draft = existing
            ? structuredClone(existing)
            : apiBackendSchema.parse({
                  id: generateId(),
                  family: 'api',
                  kind,
                  label: apiKindLabel(kind)
              })
    }

    override onOpen(): void {
        this.setTitle(
            this.isNew
                ? `Add ${apiKindLabel(this.draft.kind)} backend`
                : `Edit ${apiKindLabel(this.draft.kind)} backend`
        )
        this.modalEl.addClass('ai-editor-modal')
        this.renderContent()
    }

    override onClose(): void {
        this.contentEl.empty()
    }

    private renderContent(): void {
        const { contentEl } = this
        contentEl.empty()

        new Setting(contentEl)
            .setName('Label')
            .setDesc('How this backend appears in dropdowns.')
            .addText((text) => {
                text.setValue(this.draft.label)
                text.onChange((value) => {
                    this.draft.label = value
                })
            })

        new Setting(contentEl)
            .setName('API key')
            .setDesc('Stored in plain text in data.json. Leave empty if the endpoint needs no key.')
            .addText((text) => {
                text.inputEl.type = 'password'
                text.inputEl.setAttribute('autocomplete', 'new-password')
                text.setValue(this.draft.apiKey)
                text.onChange((value) => {
                    this.draft.apiKey = value
                })
            })

        new Setting(contentEl)
            .setName('Base URL')
            .setDesc('Endpoint the requests go to.')
            .addText((text) => {
                text.setPlaceholder(BASE_URL_PLACEHOLDERS[this.draft.kind])
                text.setValue(this.draft.baseUrl)
                text.onChange((value) => {
                    this.draft.baseUrl = value
                    updateInsecureWarning()
                })
            })
        const insecureWarning = contentEl.createDiv({
            cls: 'ai-editor-modal-warning',
            text: 'This endpoint uses unencrypted HTTP to a remote host — the API key and note content would travel in clear text.'
        })
        const updateInsecureWarning = (): void => {
            insecureWarning.toggle(isInsecureRemoteUrl(this.draft.baseUrl))
        }
        updateInsecureWarning()

        if (this.draft.kind === 'azure-openai') {
            new Setting(contentEl)
                .setName('Deployment')
                .setDesc('Azure OpenAI deployment name.')
                .addText((text) => {
                    text.setValue(this.draft.azureDeployment)
                    text.onChange((value) => {
                        this.draft.azureDeployment = value
                    })
                })
            new Setting(contentEl)
                .setName('API version')
                .setDesc('Azure api-version query parameter.')
                .addText((text) => {
                    text.setPlaceholder('e.g. 2024-10-21')
                    text.setValue(this.draft.azureApiVersion)
                    text.onChange((value) => {
                        this.draft.azureApiVersion = value
                    })
                })
        }

        new Setting(contentEl)
            .setName('Default model')
            .setDesc('Used when an editor or panel does not override the model.')
            .addText((text) => {
                text.setPlaceholder(MODEL_PLACEHOLDERS[this.draft.kind])
                text.setValue(this.draft.defaultModel)
                text.onChange((value) => {
                    this.draft.defaultModel = value
                })
            })

        new Setting(contentEl)
            .addButton((button) => {
                button.setButtonText('Cancel').onClick(() => this.close())
            })
            .addButton((button) => {
                button
                    .setButtonText(this.isNew ? 'Add backend' : 'Save')
                    .setCta()
                    .onClick(() => this.save())
            })
    }

    private save(): void {
        this.draft.label = this.draft.label.trim()
        this.draft.baseUrl = this.draft.baseUrl.trim()
        if (this.draft.label.length === 0) {
            new Notice('A label is required.')
            return
        }
        if (this.draft.kind === 'openai-compatible' && this.draft.baseUrl.length === 0) {
            new Notice('OpenAI-compatible backends need a base URL.')
            return
        }
        if (this.draft.kind === 'azure-openai' && this.draft.azureDeployment.trim().length === 0) {
            new Notice('Azure OpenAI backends need a deployment name.')
            return
        }
        const parsed = apiBackendSchema.safeParse(this.draft)
        if (!parsed.success) {
            new Notice('Invalid backend configuration.')
            return
        }
        commit(
            this.ctx,
            (draft) => {
                const index = draft.backends.findIndex((backend) => backend.id === parsed.data.id)
                if (index >= 0) {
                    draft.backends[index] = parsed.data
                } else {
                    draft.backends.push(parsed.data)
                }
            },
            { refresh: true }
        )
        this.close()
    }
}
