import { Setting } from 'obsidian'
import type { Draft } from 'immer'
import type { PluginSettingsV1 } from '../../domain/settings/settings-schema'
import { renderChipList } from '../components'
import { clampInt, normalizeChipValue } from '../helpers'
import { commit } from './shared'
import type { TabContext } from './shared'

/**
 * Behavior tab: run guardrails (size warning, concurrency, context budget),
 * privacy exclusions (folders, tags, frontmatter opt-out — absolute, per
 * Business Rule #7), and response/comment defaults.
 */
export function renderBehaviorTab(containerEl: HTMLElement, ctx: TabContext): void {
    const settings = ctx.facade.getSettings()

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
        'Context budget (characters)',
        'Total budget per run across the note, linked notes, and referenced notes.',
        settings.behavior.contextBudgetChars,
        1_000,
        2_000_000,
        (draft, next) => {
            draft.behavior.contextBudgetChars = next
        }
    )

    new Setting(containerEl).setName('Privacy exclusions').setHeading()
    containerEl.createEl('p', {
        cls: 'ai-editor-tab-intro',
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
        .setDesc('Remove frontmatter from the text sent to backends.')
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
}
