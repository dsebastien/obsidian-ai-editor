import { Setting } from 'obsidian'
import { builtInActionIdSchema } from '../../domain/settings/settings-schema'
import type { ActionBinding, BuiltInActionId } from '../../domain/settings/settings-schema'
import { generateId } from '../../domain/ids'
import { ConfirmModal, populateTargetDropdown, renderPromptTextArea } from '../components'
import {
    builtInActionLabel,
    decodeActionTarget,
    encodeActionTarget,
    isBuiltInActionId,
    setBuiltInActionBinding
} from '../helpers'
import { commit } from './shared'
import type { TabContext } from './shared'

const BUILT_IN_ACTION_DESCRIPTIONS: Record<BuiltInActionId, string> = {
    'rephrase': 'Rewrite the selection with the same meaning.',
    'summarize': 'Condense the selection or note.',
    'critique': 'Point out weaknesses without rewriting.',
    'say-more': 'Expand on the selected idea.',
    'find-evidence': 'Find support (or counter-evidence) for the claim.',
    'identify-assumptions': 'Surface what the text takes for granted.',
    'simplify': 'Make the selection easier to read.',
    'humanize': 'Remove AI-sounding patterns; restore a human voice.',
    'continue': 'Draft a continuation at the cursor.'
}

/**
 * Actions tab: bind each built-in verb to an editor or panel, and manage
 * custom actions (name + instruction prompt + binding). Panels are marked
 * with a ring glyph and their own optgroup in every binding dropdown.
 */
export function renderActionsTab(containerEl: HTMLElement, ctx: TabContext): void {
    const settings = ctx.facade.getSettings()

    containerEl.createEl('p', {
        cls: 'ai-editor-tab-intro',
        text: 'Every action verb in the selection menu routes to an editor or a panel (◎ marks panels). Unbound actions stay hidden from the menu.'
    })

    new Setting(containerEl).setName('Built-in actions').setHeading()
    for (const verb of builtInActionIdSchema.options) {
        const existing = settings.actions.find((action) => action.actionId === verb)
        new Setting(containerEl)
            .setName(builtInActionLabel(verb))
            .setDesc(BUILT_IN_ACTION_DESCRIPTIONS[verb])
            .addDropdown((dropdown) => {
                populateTargetDropdown(dropdown, settings, {
                    noneLabel: 'Not bound',
                    includePanels: true
                })
                dropdown.setValue(encodeActionTarget(existing?.binding ?? null))
                dropdown.onChange((value) => {
                    commit(ctx, (draft) => {
                        setBuiltInActionBinding(draft, verb, decodeActionTarget(value))
                    })
                })
            })
    }

    new Setting(containerEl).setName('Custom actions').setHeading()
    const customActions = settings.actions.filter((action) => !isBuiltInActionId(action.actionId))
    if (customActions.length === 0) {
        containerEl.createEl('p', {
            cls: 'ai-editor-empty-state',
            text: 'No custom actions yet.'
        })
    }
    for (const action of customActions) {
        renderCustomActionRows(containerEl, ctx, action)
    }

    new Setting(containerEl)
        .setName('Add custom action')
        .setDesc('Your own verb for the selection menu, with its own instruction prompt.')
        .addButton((button) => {
            button
                .setButtonText('Add custom action')
                .setCta()
                .onClick(() => {
                    commit(
                        ctx,
                        (draft) => {
                            const id = generateId()
                            draft.actions.push({
                                id,
                                actionId: id,
                                customName: 'New action',
                                customInstruction: {
                                    text: '',
                                    notePaths: [],
                                    followLinks: false
                                },
                                binding: null
                            })
                        },
                        { refresh: true }
                    )
                })
        })
}

function renderCustomActionRows(
    containerEl: HTMLElement,
    ctx: TabContext,
    action: ActionBinding
): void {
    const settings = ctx.facade.getSettings()
    const mutate = (
        mutator: (target: ActionBinding) => void,
        options: { refresh?: boolean } = {}
    ): void => {
        commit(
            ctx,
            (draft) => {
                const target = draft.actions.find((item) => item.id === action.id)
                if (target) {
                    mutator(target)
                }
            },
            options
        )
    }

    const row = new Setting(containerEl).setClass('ai-editor-custom-action-row')
    row.addText((text) => {
        text.setPlaceholder('Action name')
        text.setValue(action.customName)
        text.onChange((value) => {
            mutate((target) => {
                target.customName = value
            })
        })
    })
    row.addDropdown((dropdown) => {
        populateTargetDropdown(dropdown, settings, { noneLabel: 'Not bound', includePanels: true })
        dropdown.setValue(encodeActionTarget(action.binding))
        dropdown.onChange((value) => {
            mutate((target) => {
                target.binding = decodeActionTarget(value)
            })
        })
    })
    row.addExtraButton((button) => {
        button
            .setIcon('trash')
            .setTooltip('Delete')
            .onClick(() => {
                new ConfirmModal(ctx.app, {
                    title: 'Delete custom action',
                    message: `Delete custom action "${action.customName || 'Unnamed'}"? Its instruction prompt is lost.`,
                    impactLines: [],
                    ctaLabel: 'Delete',
                    onConfirm: () => {
                        commit(
                            ctx,
                            (draft) => {
                                draft.actions = draft.actions.filter(
                                    (item) => item.id !== action.id
                                )
                            },
                            { refresh: true }
                        )
                    }
                }).open()
            })
    })

    renderPromptTextArea(containerEl, {
        name: 'Instruction',
        desc: 'What this action asks the bound editor or panel to do.',
        placeholder: 'Turn the selection into a numbered checklist…',
        get: () => action.customInstruction.text,
        set: (value) => {
            mutate((target) => {
                target.customInstruction.text = value
            })
        }
    })
}
