import { Setting } from 'obsidian'
import { apiProviderKindSchema } from '../../domain/settings/settings-schema'
import type { ApiProviderKind, BackendInstance } from '../../domain/settings/settings-schema'
import { ConfirmModal, populateBackendDropdown } from '../components'
import {
    apiKindLabel,
    applyEntityDeletion,
    backendKindLabel,
    deletionImpactLines
} from '../helpers'
import { BackendModal } from './backend-modal'
import { commit } from './shared'
import type { TabContext } from './shared'

/**
 * Backends tab: key-storage disclosure, global default backend, the list of
 * configured backend instances, and the add flow. Deleting a backend shows
 * its referential impact and resets references to "inherit".
 */
export function renderBackendsTab(containerEl: HTMLElement, ctx: TabContext): void {
    const settings = ctx.facade.getSettings()

    const callout = containerEl.createDiv({ cls: 'ai-editor-settings-callout' })
    callout.createEl('strong', { text: 'API keys are stored in plain text' })
    callout.createEl('div', {
        text: 'Keys live in this plugin’s data.json inside your vault. If the vault syncs (Obsidian Sync, iCloud, git…), the keys travel with it. Use minimal-scope keys and rotate them if the vault ever leaks.'
    })

    new Setting(containerEl)
        .setName('Global default backend')
        .setDesc('Editors and panels set to inherit use this backend.')
        .addDropdown((dropdown) => {
            populateBackendDropdown(dropdown, settings, 'None')
            dropdown.setValue(settings.defaultBackend?.backendId ?? '')
            dropdown.onChange((value) => {
                commit(
                    ctx,
                    (draft) => {
                        draft.defaultBackend =
                            value.length > 0
                                ? { backendId: value, model: draft.defaultBackend?.model ?? '' }
                                : null
                    },
                    { refresh: true }
                )
            })
        })

    if (settings.defaultBackend) {
        new Setting(containerEl)
            .setName('Default model')
            .setDesc('Optional model override for the global default backend.')
            .addText((text) => {
                text.setPlaceholder('Backend default')
                text.setValue(settings.defaultBackend?.model ?? '')
                text.onChange((value) => {
                    commit(ctx, (draft) => {
                        if (draft.defaultBackend) {
                            draft.defaultBackend.model = value
                        }
                    })
                })
            })
    }

    new Setting(containerEl).setName('Configured backends').setHeading()
    if (settings.backends.length === 0) {
        containerEl.createEl('p', {
            cls: 'ai-editor-empty-state',
            text: 'No backends yet. Add one below so editors can call a model.'
        })
    }
    for (const backend of settings.backends) {
        renderBackendRow(containerEl, ctx, backend)
    }

    let selectedKind: ApiProviderKind = 'anthropic'
    new Setting(containerEl)
        .setName('Add backend')
        .setDesc('CLI agents (Claude Code, Codex) arrive in a later milestone.')
        .addDropdown((dropdown) => {
            for (const kind of apiProviderKindSchema.options) {
                dropdown.addOption(kind, apiKindLabel(kind))
            }
            dropdown.setValue(selectedKind)
            dropdown.onChange((value) => {
                const parsed = apiProviderKindSchema.safeParse(value)
                if (parsed.success) {
                    selectedKind = parsed.data
                }
            })
        })
        .addButton((button) => {
            button
                .setButtonText('Add')
                .setCta()
                .onClick(() => {
                    new BackendModal(ctx.app, ctx, null, selectedKind).open()
                })
        })
}

function renderBackendRow(
    containerEl: HTMLElement,
    ctx: TabContext,
    backend: BackendInstance
): void {
    const details: string[] = [backendKindLabel(backend)]
    if (backend.defaultModel.length > 0) {
        details.push(backend.defaultModel)
    }
    if (backend.family === 'api' && backend.baseUrl.length > 0) {
        details.push(backend.baseUrl)
    }

    const row = new Setting(containerEl).setName(backend.label).setDesc(details.join(' · '))
    row.addToggle((toggle) => {
        toggle.setValue(backend.enabled)
        toggle.setTooltip(backend.enabled ? 'Enabled' : 'Disabled')
        toggle.onChange((value) => {
            commit(
                ctx,
                (draft) => {
                    const target = draft.backends.find((item) => item.id === backend.id)
                    if (target) {
                        target.enabled = value
                    }
                },
                { refresh: true }
            )
        })
    })
    if (backend.family === 'api') {
        row.addExtraButton((button) => {
            button
                .setIcon('pencil')
                .setTooltip('Edit')
                .onClick(() => {
                    new BackendModal(ctx.app, ctx, backend, backend.kind).open()
                })
        })
    }
    row.addExtraButton((button) => {
        button
            .setIcon('trash')
            .setTooltip('Delete')
            .onClick(() => {
                const settings = ctx.facade.getSettings()
                new ConfirmModal(ctx.app, {
                    title: 'Delete backend',
                    message: `Delete backend "${backend.label}"? This cannot be undone.`,
                    impactLines: deletionImpactLines(settings, 'backend', backend.id),
                    ctaLabel: 'Delete',
                    onConfirm: () => {
                        commit(
                            ctx,
                            (draft) => {
                                applyEntityDeletion(draft, 'backend', backend.id)
                            },
                            { refresh: true }
                        )
                    }
                }).open()
            })
    })
}
