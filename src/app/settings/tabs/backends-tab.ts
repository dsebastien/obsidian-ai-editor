import { Notice, Setting } from 'obsidian'
import { validateCliBackend } from '../../domain/settings/backend-validation'
import { grantLaunchConsent, hasLaunchConsent } from '../../domain/settings/cli-consent'
import { apiProviderKindSchema } from '../../domain/settings/settings-schema'
import type { BackendInstance, CliBackend } from '../../domain/settings/settings-schema'
import { currentCliPlatform, nodeExecutableProbe } from '../../services/backends/cli'
import { launchConsentCopy, launchConsentLine } from '../cli-consent-copy'
import { ConfirmModal, populateBackendDropdown } from '../components'
import {
    apiKindLabel,
    applyEntityDeletion,
    backendKindLabel,
    deletionImpactLines
} from '../helpers'
import { BackendModal } from './backend-modal'
import { CliBackendModal } from './cli-backend-modal'
import { commit } from './shared'
import type { TabContext } from './shared'

/**
 * What the "Add backend" dropdown offers: every API provider kind, then every
 * CLI tool. Encoded as `family:kind` so one control covers both families
 * without a second dropdown that would have to be kept in sync.
 */
type AddChoice =
    | { readonly family: 'api'; readonly kind: (typeof apiProviderKindSchema.options)[number] }
    | { readonly family: 'cli'; readonly kind: CliBackend['kind'] }

const ADD_CHOICES: readonly AddChoice[] = [
    ...apiProviderKindSchema.options.map((kind): AddChoice => ({ family: 'api', kind })),
    { family: 'cli', kind: 'claude-code' },
    { family: 'cli', kind: 'codex' }
]

function addChoiceValue(choice: AddChoice): string {
    return `${choice.family}:${choice.kind}`
}

function addChoiceLabel(choice: AddChoice): string {
    if (choice.family === 'api') {
        return apiKindLabel(choice.kind)
    }
    return `${choice.kind === 'claude-code' ? 'Claude Code' : 'Codex'} (runs locally)`
}

/**
 * Backends tab: key-storage disclosure, global default backend, the list of
 * configured backend instances, and the add flow. Deleting a backend shows
 * its referential impact and resets references to "inherit".
 */
export function renderBackendsTab(containerEl: HTMLElement, ctx: TabContext): void {
    const settings = ctx.facade.getSettings()

    const callout = containerEl.createDiv({ cls: 'editor-ai-daemons-settings-callout' })
    callout.createEl('strong', { text: 'API keys are stored in plain text' })
    callout.createDiv({
        text: 'Keys live in this plugin’s data.json inside your vault. If the vault syncs (Obsidian Sync, iCloud, Git…), the keys travel with it. Use minimal-scope keys and rotate them if the vault ever leaks.'
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
            cls: 'editor-ai-daemons-empty-state',
            text: 'No backends yet. Add one below so editors can call a model.'
        })
    }
    for (const backend of settings.backends) {
        renderBackendRow(containerEl, ctx, backend)
    }

    let selected: AddChoice = ADD_CHOICES[0] ?? { family: 'cli', kind: 'claude-code' }
    new Setting(containerEl)
        .setName('Add backend')
        .setDesc(
            'CLI agents run a program on this computer. They arrive switched off and ask for your explicit permission before they can run.'
        )
        .addDropdown((dropdown) => {
            for (const choice of ADD_CHOICES) {
                dropdown.addOption(addChoiceValue(choice), addChoiceLabel(choice))
            }
            dropdown.setValue(addChoiceValue(selected))
            dropdown.onChange((value) => {
                const match = ADD_CHOICES.find((choice) => addChoiceValue(choice) === value)
                if (match) {
                    selected = match
                }
            })
        })
        .addButton((button) => {
            button
                .setButtonText('Add')
                .setCta()
                .onClick(() => {
                    if (selected.family === 'cli') {
                        new CliBackendModal(ctx.app, ctx, null, selected.kind).open()
                        return
                    }
                    new BackendModal(ctx.app, ctx, null, selected.kind).open()
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

    if (backend.family === 'cli') {
        details.push(backend.executablePath)
    }

    const row = new Setting(containerEl).setName(backend.label).setDesc(details.join(' · '))
    if (backend.family === 'cli') {
        // The consent state is the single most important thing about a CLI
        // backend row: an enabled-but-unconsented one is skipped by every run,
        // and without this line the user would only find out from a skip
        // report after asking for a review.
        row.descEl.createDiv({
            cls: hasLaunchConsent(backend)
                ? 'editor-ai-daemons-consent-line'
                : 'editor-ai-daemons-consent-line is-missing',
            text: launchConsentLine(backend)
        })
    }
    row.addToggle((toggle) => {
        toggle.setValue(backend.enabled)
        toggle.setTooltip(backend.enabled ? 'Enabled' : 'Disabled')
        toggle.onChange((value) => {
            // Enabling a CLI backend is the moment permission is needed, so it
            // is the moment the dialog appears. The toggle is reverted and the
            // change dropped unless the user agrees — nothing is written on a
            // cancelled consent.
            if (value && backend.family === 'cli' && !hasLaunchConsent(backend)) {
                toggle.setValue(false)
                askLaunchConsent(ctx, backend)
                return
            }
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
    row.addExtraButton((button) => {
        button
            .setIcon('pencil')
            .setTooltip('Edit')
            .onClick(() => {
                if (backend.family === 'cli') {
                    new CliBackendModal(ctx.app, ctx, backend, backend.kind).open()
                    return
                }
                new BackendModal(ctx.app, ctx, backend, backend.kind).open()
            })
    })
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

/**
 * The consent dialog behind the enable toggle: explain, then record BOTH the
 * permission and the enablement in one commit.
 *
 * Doing them together matters — a backend that was enabled but not consented,
 * or consented but not enabled, is a state the user did not ask for and would
 * have to fix by hand.
 */
function askLaunchConsent(ctx: TabContext, backend: CliBackend): void {
    const validation = validateCliBackend({
        draft: backend,
        platform: currentCliPlatform(),
        probe: nodeExecutableProbe
    })
    if (!validation.ok) {
        // Same check the dialog runs, for the same reason: a consent dialog
        // that says “It runs exactly this file” about a binary that was since
        // moved, uninstalled or made non-executable records agreement to
        // something that cannot happen, and the user only finds out at the end
        // of their next review.
        new Notice(validation.message)
        return
    }
    const copy = launchConsentCopy(validation.backend)
    new ConfirmModal(ctx.app, {
        title: copy.title,
        message: copy.message,
        impactLines: copy.lines,
        ctaLabel: copy.ctaLabel,
        onConfirm: () => {
            commit(
                ctx,
                (draft) => {
                    const target = draft.backends.find((item) => item.id === backend.id)
                    if (target && target.family === 'cli') {
                        target.consent = grantLaunchConsent(target)
                        target.enabled = true
                    }
                },
                { refresh: true }
            )
        }
    }).open()
}
