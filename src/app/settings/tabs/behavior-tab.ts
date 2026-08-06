import { Setting } from 'obsidian'
import type { Draft } from 'immer'
import type { PluginSettingsV1 } from '../../domain/settings/settings-schema'
import { applyImportPlan } from '../../domain/settings/settings-transfer'
import { renderChipList } from '../components'
import { clampInt, normalizeChipValue } from '../helpers'
import { SetupWizardModal } from '../setup-wizard-modal'
import { ExportSettingsModal, ImportSettingsModal } from '../transfer-modals'
import { commit } from './shared'
import type { TabContext } from './shared'

/**
 * Behavior tab: the setup wizard entry point, run guardrails (size warning,
 * concurrency, context budget), privacy exclusions (folders, tags, frontmatter
 * opt-out — absolute, per Business Rule #7), response/comment defaults, and
 * settings import/export.
 *
 * The wizard lives here rather than in the Backends tab because it spans every
 * tab (backends, editors, voice, behavior); this is the tab that already owns
 * the cross-cutting operations, import/export included.
 */
export function renderBehaviorTab(containerEl: HTMLElement, ctx: TabContext): void {
    const settings = ctx.facade.getSettings()

    new Setting(containerEl).setName('Setup').setHeading()
    new Setting(containerEl)
        .setName('Setup wizard')
        .setDesc(
            'Walk through a backend, your editors, your voice profile, and when editors run. ' +
                'Nothing is saved until the last step.'
        )
        .addButton((button) => {
            button.setButtonText('Run setup wizard').onClick(() => {
                // The wizard can add a backend and flip editor toggles, so the
                // whole tab re-renders once it commits.
                new SetupWizardModal(ctx.app, ctx.facade, ctx.refresh).open()
            })
        })

    const renderIntField = (
        name: string,
        desc: string,
        value: number,
        min: number,
        max: number,
        apply: (draft: Draft<PluginSettingsV1>, next: number) => void
    ): void => {
        new Setting(containerEl)
            .setName(name)
            .setDesc(desc)
            .addText((text) => {
                text.inputEl.type = 'number'
                text.inputEl.min = String(min)
                text.inputEl.max = String(max)
                text.setValue(String(value))
                // Numeric commits skip `refresh`, so the render-time `value` goes
                // stale after the first edit. Track the last committed value and
                // use it as the fallback, otherwise blurring the field empty
                // silently reverts the user's earlier change.
                let current = value
                // Commit on 'change' (blur/Enter), not per keystroke, so
                // clamping never fights the user mid-typing.
                text.inputEl.addEventListener('change', () => {
                    const next = clampInt(text.inputEl.value, min, max, current)
                    current = next
                    text.setValue(String(next))
                    commit(ctx, (draft) => {
                        apply(draft, next)
                    })
                })
            })
    }

    new Setting(containerEl).setName('Runs').setHeading()
    renderIntField(
        'Size warning threshold (words)',
        'Reviews of notes above this word count ask for confirmation first.',
        settings.behavior.sizeWarningWords,
        100,
        1_000_000,
        (draft, next) => {
            draft.behavior.sizeWarningWords = next
        }
    )
    renderIntField(
        'Max concurrent requests',
        'How many backend requests may run in parallel.',
        settings.behavior.maxConcurrentRequests,
        1,
        10,
        (draft, next) => {
            draft.behavior.maxConcurrentRequests = next
        }
    )
    renderIntField(
        'Request timeout (seconds)',
        "How long a single editor's backend request may run — raise this for slow local models.",
        settings.behavior.requestTimeoutSeconds,
        30,
        3_600,
        (draft, next) => {
            draft.behavior.requestTimeoutSeconds = next
        }
    )
    renderIntField(
        'Context budget (characters)',
        'Total budget per run across the system prompt, the note, and every attached note. ' +
            'The system prompt and the reviewed note are never truncated; attached notes ' +
            'are spent in order (prompt notes, wikilinked notes, links followed from prompt ' +
            'notes, then the reviewed note’s own links) and the last ones are dropped first. ' +
            'Run “Preview what will be sent” to see exactly what a note costs.',
        settings.behavior.contextBudgetChars,
        1_000,
        2_000_000,
        (draft, next) => {
            draft.behavior.contextBudgetChars = next
        }
    )

    new Setting(containerEl).setName('Daemon').setHeading()
    containerEl.createEl('p', {
        cls: 'editor-ai-daemons-tab-intro',
        text:
            'In daemon mode, editors watch your edits and refresh their recommendations ' +
            'automatically after you pause. Daemon mode is per note: each note starts ' +
            'with it off when you open it, and the toggle above the Review button (or ' +
            'the Toggle daemon mode for the current note command) turns it on for that ' +
            'note until you close it.'
    })
    new Setting(containerEl)
        .setName('Enable automatically for every note')
        .setDesc(
            'Every note starts with daemon mode already on when you open it. The ' +
                'per-note toggle can still turn individual notes off. Every refresh ' +
                'calls your configured AI backends — this can increase costs ' +
                'significantly.'
        )
        .addToggle((toggle) => {
            toggle.setValue(settings.behavior.daemonAlwaysOn)
            toggle.onChange((value) => {
                commit(ctx, (draft) => {
                    draft.behavior.daemonAlwaysOn = value
                })
            })
        })
    renderIntField(
        'Idle delay (seconds)',
        'How long the note must be quiet before its review refreshes. Typing, ' +
            'moving the cursor or selecting text restarts the clock; triaging ' +
            'findings — accepting, dismissing, using the review panel or a ' +
            'card — does not. Only an actual edit arms a refresh in the ' +
            'first place.',
        settings.behavior.daemonIdleSeconds,
        1,
        600,
        (draft, next) => {
            draft.behavior.daemonIdleSeconds = next
        }
    )

    new Setting(containerEl).setName('History').setHeading()
    new Setting(containerEl)
        .setName('Durable history')
        .setDesc(
            'Keep the History tab across sessions, per note. History contains quoted ' +
                'text from your notes, stored in the plugin folder (which may sync). ' +
                'Off keeps history for the current session only.'
        )
        .addToggle((toggle) => {
            toggle.setValue(settings.behavior.durableHistory)
            toggle.onChange((value) => {
                commit(ctx, (draft) => {
                    draft.behavior.durableHistory = value
                })
            })
        })
    new Setting(containerEl)
        .setName('Clear history')
        .setDesc('Removes every history entry, in memory and on disk.')
        .addButton((button) => {
            button.setButtonText('Clear').onClick(() => {
                ctx.clearHistory?.()
            })
        })

    new Setting(containerEl).setName('Privacy exclusions').setHeading()
    containerEl.createEl('p', {
        cls: 'editor-ai-daemons-tab-intro',
        text: 'Excluded notes are never sent to any backend — not as the review target, not as linked context, not via an explicit wikilink reference.'
    })
    renderChipList(containerEl, {
        name: 'Excluded folders',
        desc: 'Notes under these folders never leave the vault.',
        placeholder: 'Folder path, e.g. Private',
        emptyText: 'No excluded folders.',
        getValues: () => ctx.facade.getSettings().behavior.excludedFolders,
        setValues: (next) =>
            ctx.facade.update((draft) => {
                draft.behavior.excludedFolders = next
            }),
        normalize: (raw) => normalizeChipValue(raw, 'folder')
    })
    renderChipList(containerEl, {
        name: 'Excluded tags',
        desc: 'Notes carrying these tags never leave the vault.',
        placeholder: 'Tag without #, e.g. private',
        emptyText: 'No excluded tags.',
        getValues: () => ctx.facade.getSettings().behavior.excludedTags,
        setValues: (next) =>
            ctx.facade.update((draft) => {
                draft.behavior.excludedTags = next
            }),
        normalize: (raw) => normalizeChipValue(raw, 'tag')
    })
    new Setting(containerEl)
        .setName('Respect frontmatter opt-out')
        .setDesc('Notes with ai_editor: false in their frontmatter are excluded entirely.')
        .addToggle((toggle) => {
            toggle.setValue(settings.behavior.respectFrontmatterOptOut)
            toggle.onChange((value) => {
                commit(ctx, (draft) => {
                    draft.behavior.respectFrontmatterOptOut = value
                })
            })
        })
    new Setting(containerEl)
        .setName('Strip frontmatter')
        .setDesc('Remove frontmatter from the note and from every attached note before sending.')
        .addToggle((toggle) => {
            toggle.setValue(settings.behavior.stripFrontmatter)
            toggle.onChange((value) => {
                commit(ctx, (draft) => {
                    draft.behavior.stripFrontmatter = value
                })
            })
        })

    new Setting(containerEl).setName('Responses').setHeading()
    new Setting(containerEl)
        .setName('Response language override')
        .setDesc('Leave empty to answer in each note’s own language.')
        .addText((text) => {
            text.setPlaceholder('e.g. English')
            text.setValue(settings.behavior.responseLanguageOverride)
            text.onChange((value) => {
                commit(ctx, (draft) => {
                    draft.behavior.responseLanguageOverride = value
                })
            })
        })
    new Setting(containerEl)
        .setName('Default comment editor')
        .setDesc('Editor handling async margin comments unless rerouted per comment.')
        .addDropdown((dropdown) => {
            dropdown.addOption('', 'None')
            for (const editor of settings.editors) {
                dropdown.addOption(editor.id, editor.name)
            }
            dropdown.setValue(settings.behavior.defaultCommentEditorId)
            dropdown.onChange((value) => {
                commit(ctx, (draft) => {
                    draft.behavior.defaultCommentEditorId = value
                })
            })
        })

    new Setting(containerEl)
        .setName('Margin comment column')
        .setDesc(
            // "AI Editor Review" is the side panel's tab title — declared as
            // vocabulary in eslint.config.ts (0.4.1 forbids inline disables).
            'Show margin comments next to the text they are about. Turn this off to keep them in the AI Editor Review panel only. Needs a wide enough pane; with readable line length on, the column uses the empty margin and the text does not move.'
        )
        .addToggle((toggle) => {
            toggle.setValue(settings.behavior.showMarginComments)
            toggle.onChange((value) => {
                commit(ctx, (draft) => {
                    draft.behavior.showMarginComments = value
                })
            })
        })

    new Setting(containerEl).setName('Import & export').setHeading()
    containerEl.createEl('p', {
        cls: 'editor-ai-daemons-tab-intro',
        text: 'Move your configuration between vaults, or keep a copy in this one. API keys are never included — the vault that imports the file enters its own.'
    })
    new Setting(containerEl)
        .setName('Export settings')
        .setDesc('Write the sections you pick to a JSON file in the vault, or to the clipboard.')
        .addButton((button) => {
            button.setButtonText('Export…').onClick(() => {
                new ExportSettingsModal(ctx.app, () => ctx.facade.getSettings()).open()
            })
        })
    new Setting(containerEl)
        .setName('Import settings')
        .setDesc(
            'Add entities from an exported file. You confirm a summary before anything is saved.'
        )
        .addButton((button) => {
            button.setButtonText('Import…').onClick(() => {
                new ImportSettingsModal(ctx.app, {
                    getSettings: () => ctx.facade.getSettings(),
                    commitPlan: async (plan) => {
                        await ctx.facade.update((draft) => {
                            applyImportPlan(draft, plan)
                        })
                        ctx.refresh()
                    }
                }).open()
            })
        })
}
