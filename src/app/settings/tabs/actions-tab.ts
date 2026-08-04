import { Setting } from 'obsidian'
import { builtInActionIdSchema, verbClassSchema } from '../../domain/settings/settings-schema'
import type {
    ActionBinding,
    BuiltInActionId,
    VerbClass
} from '../../domain/settings/settings-schema'
import { getBuiltInVerb, verbClassLabel } from '../../domain/actions/verb-registry'
import { generateId } from '../../domain/ids'
import {
    actionInvalidReasonLabel,
    resolveActionBinding
} from '../../services/actions/action-resolution'
import {
    ConfirmModal,
    populateTargetDropdown,
    renderNoteRefsEditor,
    renderPromptTextArea
} from '../components'
import {
    builtInActionLabel,
    decodeActionTarget,
    encodeActionTarget,
    isBuiltInActionId,
    setBuiltInActionBinding,
    setCustomActionClass
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
    'continue': 'Draft a continuation at the cursor.',
    'expand-section': "Develop the cursor's section; inserts at its end. No selection needed.",
    'continue-note': 'Continue at the very end of the note. No selection needed.'
}

/**
 * Actions tab: bind each built-in verb to an editor or panel, and manage
 * custom actions (name + what it does + instruction prompt + instruction
 * notes + binding). Panels are marked with a ring glyph and their own
 * optgroup in every binding dropdown.
 *
 * The tab mirrors `resolveActionBinding` rather than restating its rules: the
 * panel option only appears where a panel is a valid target (review-class
 * verbs, built-in or custom), and any bound-but-undispatchable action says
 * why it is hidden instead of quietly disappearing.
 */
export function renderActionsTab(containerEl: HTMLElement, ctx: TabContext): void {
    const settings = ctx.facade.getSettings()

    containerEl.createEl('p', {
        cls: 'editor-ai-daemons-tab-intro',
        text: 'Every action verb in the selection menu routes to an editor. Review-class verbs (critique, find evidence, identify assumptions) can route to a panel instead (◎ marks panels) — each member editor runs the action. Unbound actions stay hidden from the menu and the command palette.'
    })

    new Setting(containerEl).setName('Built-in actions').setHeading()
    for (const verb of builtInActionIdSchema.options) {
        const existing = settings.actions.find((action) => action.actionId === verb)
        // Only review-class verbs may bind to a panel (a transform/generate
        // verb produces exactly one replacement/insertion) — the dropdown
        // simply never offers one, mirroring the resolution rule.
        const reviewClass = getBuiltInVerb(verb)?.verbClass === 'review'
        const row = new Setting(containerEl)
            .setName(builtInActionLabel(verb))
            .setDesc(BUILT_IN_ACTION_DESCRIPTIONS[verb])
            .addDropdown((dropdown) => {
                populateTargetDropdown(dropdown, settings, {
                    noneLabel: 'Not bound',
                    includePanels: reviewClass
                })
                dropdown.setValue(encodeActionTarget(existing?.binding ?? null))
                dropdown.onChange((value) => {
                    commit(
                        ctx,
                        (draft) => {
                            setBuiltInActionBinding(draft, verb, decodeActionTarget(value))
                        },
                        { refresh: true }
                    )
                })
            })
        if (existing) {
            renderBindingWarning(row, existing, ctx)
        }
    }

    new Setting(containerEl).setName('Custom actions').setHeading()
    const customActions = settings.actions.filter((action) => !isBuiltInActionId(action.actionId))
    if (customActions.length === 0) {
        containerEl.createEl('p', {
            cls: 'editor-ai-daemons-empty-state',
            text: 'No custom actions yet.'
        })
    }
    for (const action of customActions) {
        renderCustomActionRows(containerEl, ctx, action)
    }

    new Setting(containerEl)
        .setName('Add custom action')
        .setDesc(
            'Your own verb, with its own instruction. Pick what it does — rewrite the ' +
                'selection, write more at the cursor, or report findings — and it appears in ' +
                'the selection menu and the command palette like a built-in one.'
        )
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
                                customVerbClass: null,
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

    const reviewClass = action.customVerbClass === 'review'
    const row = new Setting(containerEl).setClass('editor-ai-daemons-custom-action-row')
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
        // No default: the class decides whether the result replaces the
        // selection, is inserted after it, or comes back as findings, and
        // guessing would silently overwrite text the user asked about.
        dropdown.addOption('', 'Pick what it does…')
        for (const verbClass of verbClassSchema.options) {
            dropdown.addOption(verbClass, verbClassLabel(verbClass))
        }
        dropdown.setValue(action.customVerbClass ?? '')
        dropdown.onChange((value) => {
            const next = verbClassSchema.safeParse(value)
            commit(
                ctx,
                (draft) => {
                    setCustomActionClass(draft, action.id, next.success ? next.data : null)
                },
                { refresh: true }
            )
        })
    })
    row.addDropdown((dropdown) => {
        populateTargetDropdown(dropdown, settings, {
            noneLabel: 'Not bound',
            includePanels: reviewClass
        })
        dropdown.setValue(encodeActionTarget(action.binding))
        dropdown.onChange((value) => {
            mutate(
                (target) => {
                    target.binding = decodeActionTarget(value)
                },
                { refresh: true }
            )
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

    renderBindingWarning(row, action, ctx)

    renderPromptTextArea(containerEl, {
        name: 'Instruction',
        desc: customInstructionDesc(action.customVerbClass),
        placeholder: 'Turn the selection into a numbered checklist…',
        get: () => action.customInstruction.text,
        set: (value) => {
            mutate((target) => {
                target.customInstruction.text = value
            })
        }
    })
    renderNoteRefsEditor(containerEl, {
        app: ctx.app,
        name: 'Instruction notes',
        desc: 'Vault notes appended to the instruction, in order, read fresh on every run.',
        getPaths: () => action.customInstruction.notePaths,
        setPaths: (paths) =>
            ctx.facade.update((draft) => {
                const target = draft.actions.find((item) => item.id === action.id)
                if (target) {
                    target.customInstruction.notePaths = paths
                }
            }),
        followLinks: {
            get: () => action.customInstruction.followLinks,
            set: (value) =>
                ctx.facade.update((draft) => {
                    const target = draft.actions.find((item) => item.id === action.id)
                    if (target) {
                        target.customInstruction.followLinks = value
                    }
                })
        }
    })
}

/** What the instruction is asked to describe, per class. */
function customInstructionDesc(verbClass: VerbClass | null): string {
    switch (verbClass) {
        case 'transform':
            return 'How to rewrite the selection. The result replaces it, after you accept the diff.'
        case 'generate':
            return 'What to write at the cursor. The result is inserted, after you accept it.'
        case 'review':
            return 'What to look for. The result comes back as findings on the note, nothing is rewritten.'
        case null:
            return 'What this action asks the bound editor to do. Pick what it does first.'
    }
}

/**
 * Appends the undispatchable-binding note to a row: a BOUND action that
 * cannot dispatch (panel binding on a non-review verb, disabled target,
 * unusable backend, blank custom action…) silently disappears from the
 * menu and the palette — say why instead. Unbound is a deliberate state
 * and stays quiet.
 */
function renderBindingWarning(row: Setting, action: ActionBinding, ctx: TabContext): void {
    if (!action.binding) {
        return
    }
    const resolution = resolveActionBinding(ctx.facade.getSettings(), action)
    if (resolution.ok) {
        return
    }
    row.descEl.createDiv({
        cls: 'editor-ai-daemons-binding-warning',
        text: `Hidden from menus and the command palette: ${actionInvalidReasonLabel(resolution.reason)}.`
    })
}
