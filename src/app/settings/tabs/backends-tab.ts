import { Menu, Notice } from 'obsidian'
import type { SettingDefinition, SettingDefinitionItem } from 'obsidian'
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

function addChoiceLabel(choice: AddChoice): string {
    if (choice.family === 'api') {
        return apiKindLabel(choice.kind)
    }
    return `${choice.kind === 'claude-code' ? 'Claude Code' : 'Codex'} (runs locally)`
}

/**
 * Backends page: key-storage disclosure, the global default backend, and the
 * collection of configured backend instances with its add/edit/delete flows.
 * Deleting a backend shows its referential impact and resets references to
 * "inherit".
 *
 * Declarative (issue #35): the backend instances are a `list`, so the add,
 * delete and reorder affordances come from the framework instead of being
 * hand-built rows, and the two disclosures are plain definitions marked
 * `searchable: false` — they are copy, not settings.
 *
 * Three things stay imperative, each for a reason a control cannot cover:
 *
 * - The global default backend is NOT a scalar. It is a nullable
 *   `{ backendId, model }` object: picking "None" deletes it, picking a
 *   backend from nothing creates it. `defaultBackend.backendId` also fails the
 *   rule `control-bindings.ts` states — the path must resolve against the
 *   parsed defaults, and in the defaults `defaultBackend` is `null`, so
 *   `writeControlValue` would refuse the write and the choice would silently
 *   not stick. The same holds for the default model right below it.
 * - A backend row carries the enable toggle, and enabling a CLI backend is
 *   exactly the moment launch consent is asked for. A `toggle` control writes
 *   straight to storage, which would enable a local program without ever
 *   showing the dialog — the one thing that must not happen here.
 * - The add affordance offers a choice of provider, which `addItem` (a single
 *   `+`) does not model, so it opens a menu of the same choices the old
 *   dropdown listed.
 */
export function backendsPageItems(ctx: TabContext): SettingDefinitionItem[] {
    const backends = ctx.facade.getSettings().backends
    return [
        {
            type: 'group',
            heading: 'About backends',
            items: [
                {
                    name: 'API keys are stored in plain text',
                    desc: 'Keys live in this plugin’s data.json inside your vault. If the vault syncs (Obsidian Sync, iCloud, Git…), the keys travel with it. Use minimal-scope keys and rotate them if the vault ever leaks.',
                    // Disclosure, not a setting: keeping it out of search stops
                    // it outranking the backends themselves on every query.
                    searchable: false
                },
                {
                    name: 'CLI backends run on this computer',
                    desc: 'CLI agents run a program on this computer. They arrive switched off and ask for your explicit permission before they can run.',
                    searchable: false
                }
            ]
        },
        {
            type: 'group',
            heading: 'Default backend',
            items: [
                {
                    name: 'Global default backend',
                    desc: 'Editors and panels set to inherit use this backend.',
                    render: (setting): void => {
                        setting.addDropdown((dropdown) => {
                            const settings = ctx.facade.getSettings()
                            populateBackendDropdown(dropdown, settings, 'None')
                            dropdown.setValue(settings.defaultBackend?.backendId ?? '')
                            dropdown.onChange((value) => {
                                commit(
                                    ctx,
                                    (draft) => {
                                        draft.defaultBackend =
                                            value.length > 0
                                                ? {
                                                      backendId: value,
                                                      model: draft.defaultBackend?.model ?? ''
                                                  }
                                                : null
                                    },
                                    // The model row below appears and disappears
                                    // with this choice.
                                    { refresh: true }
                                )
                            })
                        })
                    }
                },
                {
                    name: 'Default model',
                    desc: 'Optional model override for the global default backend.',
                    // Nothing to override while no default backend is picked.
                    visible: (): boolean => ctx.facade.getSettings().defaultBackend !== null,
                    render: (setting): void => {
                        setting.addText((text) => {
                            text.setPlaceholder('Backend default')
                            text.setValue(ctx.facade.getSettings().defaultBackend?.model ?? '')
                            text.onChange((value) => {
                                commit(ctx, (draft) => {
                                    if (draft.defaultBackend) {
                                        draft.defaultBackend.model = value
                                    }
                                })
                            })
                        })
                    }
                }
            ]
        },
        {
            type: 'list',
            heading: 'Configured backends',
            emptyState: 'No backends yet. Add one so editors can call a model.',
            addItem: {
                name: 'Add backend',
                action: (el): void => {
                    openAddMenu(ctx, el)
                }
            },
            onReorder: (oldIndex, newIndex): void => {
                commit(
                    ctx,
                    (draft) => {
                        const [moved] = draft.backends.splice(oldIndex, 1)
                        if (moved) {
                            draft.backends.splice(newIndex, 0, moved)
                        }
                    },
                    { refresh: true }
                )
            },
            // Resolved from the LIVE settings, not the render-time `backends`
            // snapshot: a drag reorders the array and the framework re-indexes
            // its rows immediately, while our refresh only lands once the write
            // persists. Deleting in that window against the snapshot targets —
            // and, on confirm, deletes — the wrong backend (adversarial review,
            // 2026-08-07).
            onDelete: (index): void => {
                const backend = ctx.facade.getSettings().backends[index]
                if (backend) {
                    confirmDeletion(ctx, backend)
                }
            },
            items: backends.map((backend) => backendRowItem(ctx, backend))
        }
    ]
}

/** The `kind · model · endpoint` line under a backend's label. */
function backendRowDetails(backend: BackendInstance): string {
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
    return details.join(' · ')
}

/**
 * One row of the backends list: enable toggle and edit button. Deletion is the
 * list's own affordance (`onDelete` above), so it is not built here.
 */
function backendRowItem(ctx: TabContext, backend: BackendInstance): SettingDefinition {
    return {
        name: backend.label,
        desc: backendRowDetails(backend),
        render: (setting): void => {
            if (backend.family === 'cli') {
                // The consent state is the single most important thing about a
                // CLI backend row: an enabled-but-unconsented one is skipped by
                // every run, and without this line the user would only find out
                // from a skip report after asking for a review.
                setting.descEl.createDiv({
                    cls: hasLaunchConsent(backend)
                        ? 'editor-ai-daemons-consent-line'
                        : 'editor-ai-daemons-consent-line is-missing',
                    text: launchConsentLine(backend)
                })
            }
            setting.addToggle((toggle) => {
                toggle.setValue(backend.enabled)
                toggle.setTooltip(backend.enabled ? 'Enabled' : 'Disabled')
                toggle.onChange((value) => {
                    // Enabling a CLI backend is the moment permission is
                    // needed, so it is the moment the dialog appears. The
                    // toggle is reverted and the change dropped unless the user
                    // agrees — nothing is written on a cancelled consent.
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
            setting.addExtraButton((button) => {
                button
                    .setIcon('pencil')
                    .setTooltip('Edit')
                    .onClick(() => {
                        openBackendModal(ctx, backend)
                    })
            })
        }
    }
}

/** Edit an existing backend in the modal its family owns. */
function openBackendModal(ctx: TabContext, backend: BackendInstance): void {
    if (backend.family === 'cli') {
        new CliBackendModal(ctx.app, ctx, backend, backend.kind).open()
        return
    }
    new BackendModal(ctx.app, ctx, backend, backend.kind).open()
}

/**
 * The add affordance: a menu of every provider, anchored to the list's `+`.
 *
 * `addItem` is a single button, but a backend cannot be created without saying
 * WHICH provider it is — so the choice the old add row made with a dropdown is
 * made here, one click earlier, and the picked kind goes straight into the
 * matching modal.
 */
function openAddMenu(ctx: TabContext, el: HTMLElement): void {
    const menu = new Menu()
    for (const choice of ADD_CHOICES) {
        menu.addItem((item) => {
            item.setTitle(addChoiceLabel(choice))
            item.onClick(() => {
                if (choice.family === 'cli') {
                    new CliBackendModal(ctx.app, ctx, null, choice.kind).open()
                    return
                }
                new BackendModal(ctx.app, ctx, null, choice.kind).open()
            })
        })
    }
    const rect = el.getBoundingClientRect()
    menu.showAtPosition({ x: rect.left, y: rect.bottom })
}

/**
 * The delete dialog behind the list's delete affordance: the referential
 * impact is shown BEFORE anything is removed, because deleting a backend also
 * resets every editor, panel and action that pointed at it back to "inherit" —
 * a change the user cannot see from the row they are deleting.
 */
function confirmDeletion(ctx: TabContext, backend: BackendInstance): void {
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
