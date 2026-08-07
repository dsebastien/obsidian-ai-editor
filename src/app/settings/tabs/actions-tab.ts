import type { Setting, SettingDefinitionItem, SettingGroupItem } from 'obsidian'
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
    'continue-note': 'Continue at the very end of the note. No selection needed.',
    'find-references': 'Find sources for the claims; add vetted ones as footnotes or references.'
}

/**
 * Actions page: bind each built-in verb to an editor or panel, and manage
 * custom actions (name + what it does + instruction prompt + instruction
 * notes + binding). Panels are marked with a ring glyph and their own
 * optgroup in every binding dropdown.
 *
 * The page mirrors `resolveActionBinding` rather than restating its rules: the
 * panel option only appears where a panel is a valid target (review-class
 * verbs, built-in or custom), and any bound-but-undispatchable action says
 * why it is hidden instead of quietly disappearing.
 *
 * Declarative (issue #35): the built-in verbs are a fixed group, the custom
 * actions are a `list` — the collection the user adds to and deletes from, so
 * add/delete are the list's own affordances and the ConfirmModal still gates
 * the deletion.
 *
 * Nothing on this page is a `control`, and that is not an oversight. Every
 * value here lives in the `actions` ARRAY, whose entries are created and
 * removed on demand (`setBuiltInActionBinding` pushes an entry the first time
 * a verb is bound and filters it out when unbound), so an `actions.<n>.…` dot
 * path addresses a different action the moment any other binding changes.
 * Bindings are also encoded targets rather than scalars, and their dropdown
 * carries optgroups that `SettingDropdownControl`'s flat option record cannot
 * express — so the rows use the `render` escape hatch over the existing
 * dropdown/prompt/note-ref helpers, and every write still goes through the
 * facade.
 */
export function actionsPageItems(ctx: TabContext): SettingDefinitionItem[] {
    const customActions = ctx.facade
        .getSettings()
        .actions.filter((action) => !isBuiltInActionId(action.actionId))
    return [
        {
            type: 'group',
            heading: 'Built-in actions',
            items: [
                {
                    name: 'About actions',
                    desc: 'Every action verb in the selection menu routes to an editor. Review-class verbs (critique, find evidence, identify assumptions) can route to a panel instead (◎ marks panels) — each member editor runs the action. Unbound actions stay hidden from the menu and the command palette.',
                    // Explanatory copy, not a setting: keeping it out of search
                    // stops it matching every action query ahead of the verbs
                    // right below it.
                    searchable: false
                },
                ...builtInActionIdSchema.options.map((verb) => builtInActionItem(ctx, verb))
            ]
        },
        {
            type: 'group',
            items: [
                {
                    name: 'About custom actions',
                    desc:
                        'Your own verb, with its own instruction. Pick what it does — rewrite the ' +
                        'selection, write more at the cursor, or report findings — and it appears in ' +
                        'the selection menu and the command palette like a built-in one.',
                    searchable: false
                }
            ]
        },
        {
            type: 'list',
            heading: 'Custom actions',
            emptyState: 'No custom actions yet.',
            addItem: {
                name: 'Add custom action',
                action: (): void => {
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
                }
            },
            // Deletion safety is unchanged: the list's delete affordance opens
            // the same confirmation, which states what is lost before anything
            // is removed.
            onDelete: (index: number): void => {
                const action = customActions[index]
                if (!action) {
                    return
                }
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
            },
            items: customActions.map((action) => customActionItem(ctx, action))
        }
    ]
}

/**
 * One built-in verb row: the label and what the verb does are declared (so
 * settings search finds them), the binding dropdown is rendered because only
 * `populateTargetDropdown` knows how to mark panels and group them.
 */
function builtInActionItem(ctx: TabContext, verb: BuiltInActionId): SettingGroupItem {
    return {
        name: builtInActionLabel(verb),
        desc: BUILT_IN_ACTION_DESCRIPTIONS[verb],
        render: (setting): void => {
            const settings = ctx.facade.getSettings()
            const existing = settings.actions.find((action) => action.actionId === verb)
            // Only review-class verbs may bind to a panel (a transform/generate
            // verb produces exactly one replacement/insertion) — the dropdown
            // simply never offers one, mirroring the resolution rule.
            const reviewClass = getBuiltInVerb(verb)?.verbClass === 'review'
            setting.addDropdown((dropdown) => {
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
                renderBindingWarning(setting, existing, ctx)
            }
        }
    }
}

/**
 * One custom action row: name, what it does, and where it is bound on the row
 * itself; its instruction and instruction notes underneath it, in the list.
 *
 * The row name is the stored name at render time — editing the text field
 * commits without a re-render so the field keeps focus, exactly as before, so
 * the label catches up on the next render.
 */
function customActionItem(ctx: TabContext, action: ActionBinding): SettingGroupItem {
    return {
        name: action.customName.length > 0 ? action.customName : 'Unnamed action',
        render: (setting, group): void => {
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
            setting.setClass('editor-ai-daemons-custom-action-row')
            setting.addText((text) => {
                text.setPlaceholder('Action name')
                text.setValue(action.customName)
                text.onChange((value) => {
                    mutate((target) => {
                        target.customName = value
                    })
                })
            })
            setting.addDropdown((dropdown) => {
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
            setting.addDropdown((dropdown) => {
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

            renderBindingWarning(setting, action, ctx)

            // The instruction is a prompt source (text + ordered note refs +
            // follow-links), not a scalar: the existing editors render it into
            // the list, right under the row they belong to.
            renderPromptTextArea(group.listEl, {
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
            renderNoteRefsEditor(group.listEl, {
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
    }
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
