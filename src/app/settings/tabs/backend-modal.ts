import { Modal, Notice, Setting } from 'obsidian'
import type { App } from 'obsidian'
import { validateApiBackend } from '../../domain/settings/backend-validation'
import { apiBackendSchema } from '../../domain/settings/settings-schema'
import type { ApiBackend, ApiProviderKind } from '../../domain/settings/settings-schema'
import { generateId } from '../../domain/ids'
import { apiKindLabel, isInsecureRemoteUrl } from '../helpers'
import { commit } from './shared'
import type { TabContext } from './shared'

const BASE_URL_PLACEHOLDERS: Record<ApiProviderKind, string> = {
    'anthropic': 'Optional — defaults to https://api.anthropic.com',
    'openai': 'Optional — defaults to https://api.openai.com/v1',
    'openrouter': 'Optional — defaults to https://openrouter.ai/api/v1',
    'openai-compatible': 'https://api.groq.com/openai/v1',
    'azure-openai': 'https://<resource>.openai.azure.com',
    'ollama': 'http://localhost:11434'
}

const MODEL_PLACEHOLDERS: Record<ApiProviderKind, string> = {
    'anthropic': 'e.g. claude-sonnet-4-5',
    'openai': 'e.g. gpt-5.2',
    'openrouter': 'e.g. anthropic/claude-sonnet-4.5',
    'openai-compatible': 'Model id expected by the endpoint',
    'azure-openai': 'Model behind the deployment',
    'ollama': 'e.g. llama3.3'
}

/**
 * Create/edit dialog for one API backend instance. Works on a local draft;
 * nothing is persisted until Save passes validation. CLI backends have their
 * own dialog (`cli-backend-modal.ts`): they name a program rather than an
 * endpoint, and carry the two-step consent this screen has no business
 * hosting.
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

        this.renderThinkingControls(contentEl)

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

    /**
     * Per-kind thinking/reasoning controls. Only what applies to the
     * selected provider kind is shown; defaults are 'off'/'default'
     * everywhere (a local model silently reasoning for minutes with zero
     * output reads as a hang).
     */
    private renderThinkingControls(contentEl: HTMLElement): void {
        const kind = this.draft.kind
        if (kind === 'ollama') {
            new Setting(contentEl)
                .setName('Thinking')
                .setDesc(
                    'Let thinking-family models (qwen3, deepseek-r1) reason before answering. Off avoids minutes of silent reasoning.'
                )
                .addDropdown((dropdown) => {
                    dropdown.addOption('off', 'Off')
                    dropdown.addOption('on', 'On')
                    dropdown.setValue(this.draft.thinking === 'off' ? 'off' : 'on')
                    dropdown.onChange((value) => {
                        this.draft.thinking = value === 'on' ? 'on' : 'off'
                    })
                })
        }
        if (kind === 'anthropic') {
            new Setting(contentEl)
                .setName('Thinking')
                .setDesc(
                    'Adaptive lets the model decide when and how much to think (Claude 4.6 and newer). Budget is the legacy manual mode for Claude 4.5 and earlier — newer models reject it.'
                )
                .addDropdown((dropdown) => {
                    dropdown.addOption('off', 'Off')
                    dropdown.addOption('on', 'Adaptive')
                    dropdown.addOption('budget', 'Budget (legacy)')
                    dropdown.setValue(this.draft.thinking)
                    dropdown.onChange((value) => {
                        this.draft.thinking = value === 'on' || value === 'budget' ? value : 'off'
                        // The budget field shows only in budget mode.
                        this.renderContent()
                    })
                })
        }
        if (kind === 'anthropic' && this.draft.thinking === 'budget') {
            new Setting(contentEl)
                .setName('Thinking budget (tokens)')
                .setDesc(
                    'Tokens the model may spend reasoning per request (1024-32000). Capped so budget plus output stays within the 32k limit of legacy models.'
                )
                .addText((text) => {
                    text.inputEl.type = 'number'
                    text.inputEl.min = '1024'
                    text.inputEl.max = '32000'
                    text.setValue(String(this.draft.thinkingBudgetTokens))
                    text.inputEl.addEventListener('change', () => {
                        const parsed = Number.parseInt(text.inputEl.value, 10)
                        const next = Number.isFinite(parsed)
                            ? Math.min(32_000, Math.max(1_024, parsed))
                            : this.draft.thinkingBudgetTokens
                        this.draft.thinkingBudgetTokens = next
                        text.setValue(String(next))
                    })
                })
        }
        if (kind === 'openai' || kind === 'azure-openai' || kind === 'openrouter') {
            new Setting(contentEl)
                .setName('Reasoning effort')
                .setDesc("How hard reasoning models think. The 'Default' option sends nothing.")
                .addDropdown((dropdown) => {
                    dropdown.addOption('default', 'Default')
                    dropdown.addOption('minimal', 'Minimal')
                    dropdown.addOption('low', 'Low')
                    dropdown.addOption('medium', 'Medium')
                    dropdown.addOption('high', 'High')
                    dropdown.setValue(this.draft.reasoningEffort)
                    dropdown.onChange((value) => {
                        this.draft.reasoningEffort =
                            value === 'minimal' ||
                            value === 'low' ||
                            value === 'medium' ||
                            value === 'high'
                                ? value
                                : 'default'
                    })
                })
        }
        if (kind === 'openai-compatible' || kind === 'openrouter') {
            new Setting(contentEl)
                .setName('Extra request body (advanced)')
                .setDesc(
                    'Raw JSON object merged into every request body — for host-specific thinking/reasoning flags. Leave empty unless your endpoint needs it.'
                )
                .addTextArea((text) => {
                    text.setPlaceholder('{"reasoning": {"effort": "high"}}')
                    text.setValue(this.draft.extraBodyJson)
                    text.onChange((value) => {
                        this.draft.extraBodyJson = value
                    })
                })
        }
    }

    private save(): void {
        const validation = validateApiBackend(this.draft)
        if (!validation.ok) {
            new Notice(validation.message)
            return
        }
        const backend = validation.backend
        commit(
            this.ctx,
            (draft) => {
                const index = draft.backends.findIndex((candidate) => candidate.id === backend.id)
                if (index >= 0) {
                    draft.backends[index] = backend
                } else {
                    draft.backends.push(backend)
                }
            },
            { refresh: true }
        )
        this.close()
    }
}
