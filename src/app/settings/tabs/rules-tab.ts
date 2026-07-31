import { Setting } from 'obsidian'
import type { BindingRule, RuleMatch } from '../../domain/settings/settings-schema'
import { generateId } from '../../domain/ids'
import { isStarterKitAvailable, readOskNoteTypes } from '../../ui/osk-note-types'
import { populateTargetDropdown } from '../components'
import { decodeActionTarget, encodeActionTarget, moveItem, ruleSummary } from '../helpers'
import { commit } from './shared'
import type { TabContext } from './shared'

const MATCH_TYPE_LABELS: Record<RuleMatch['matchType'], string> = {
    'folder': 'Folder',
    'tag': 'Tag',
    'frontmatter': 'Frontmatter',
    'osk-note-type': 'OSK note type'
}

const VALUE_PLACEHOLDERS: Record<RuleMatch['matchType'], string> = {
    'folder': 'Folder path, e.g. Blog (/ = whole vault)',
    'tag': 'Tag without #, e.g. draft',
    'frontmatter': 'key: value, e.g. type: article',
    'osk-note-type': 'Note type name, e.g. permanent-notes'
}

/** Alphabetically first Starter Kit type name, or `null` when none is offered. */
function firstOskTypeName(app: TabContext['app']): string | null {
    const names = readOskNoteTypes(app)
        .map((noteType) => noteType.name)
        .sort((a, b) => a.localeCompare(b))
    return names[0] ?? null
}

/**
 * Rules tab: ordered binding rules. A rule matches notes by
 * folder/tag/frontmatter/OSK note type and either assigns a default reviewer
 * (editor or panel) or disables the plugin entirely for that scope.
 *
 * The copy here states the evaluation order the engine actually implements
 * (`domain/rules/rule-engine.ts`): kill switches win from any position, then
 * the first matching assignment in list order.
 */
export function renderRulesTab(containerEl: HTMLElement, ctx: TabContext): void {
    const settings = ctx.facade.getSettings()

    containerEl.createEl('p', {
        cls: 'editor-ai-daemons-tab-intro',
        text: 'The “Disable plugin” action is a kill switch: no rail, no menu items, no commands, no AI for matching notes. It wins wherever it sits in the list.'
    })
    containerEl.createEl('p', {
        cls: 'editor-ai-daemons-tab-intro',
        text: 'Among the remaining rules, the first match from the top assigns who reviews the note — one rule, not a union. Use the arrows to set priority.'
    })
    containerEl.createEl('p', {
        cls: 'editor-ai-daemons-tab-intro',
        text: 'Notes no rule matches are reviewed by every enabled editor, which is also what happens when there are no rules at all.'
    })
    // Only mentioned when it is there. Telling a user who does not run the
    // Starter Kit that it was "not detected" advertises a match type they
    // cannot use and reads as a warning about something being wrong.
    if (isStarterKitAvailable(ctx.app)) {
        containerEl.createEl('p', {
            cls: 'editor-ai-daemons-tab-intro',
            text: `Obsidian Starter Kit detected — “OSK note type” lists its ${readOskNoteTypes(ctx.app).length} types to pick from. A note also matches by its type/… tag, so rules keep working if the Starter Kit is ever disabled.`
        })
    }

    if (settings.rules.length === 0) {
        containerEl.createEl('p', {
            cls: 'editor-ai-daemons-empty-state',
            text: 'No rules yet — every enabled editor reviews every note.'
        })
    }
    settings.rules.forEach((rule, index) => {
        renderRuleRow(containerEl, ctx, rule, index, settings.rules.length)
    })

    new Setting(containerEl)
        .setName('Add rule')
        .setDesc('New rules are appended at the bottom (lowest priority).')
        .addButton((button) => {
            button
                .setButtonText('Add rule')
                .setCta()
                .onClick(() => {
                    commit(
                        ctx,
                        (draft) => {
                            draft.rules.push({
                                id: generateId(),
                                name: '',
                                match: { matchType: 'folder', value: '/' },
                                effect: 'assign',
                                defaultTarget: null,
                                enabled: true
                            })
                        },
                        { refresh: true }
                    )
                })
        })
}

function renderRuleRow(
    containerEl: HTMLElement,
    ctx: TabContext,
    rule: BindingRule,
    index: number,
    total: number
): void {
    const settings = ctx.facade.getSettings()
    const mutate = (
        mutator: (target: BindingRule) => void,
        options: { refresh?: boolean } = {}
    ): void => {
        commit(
            ctx,
            (draft) => {
                const target = draft.rules.find((item) => item.id === rule.id)
                if (target) {
                    mutator(target)
                }
            },
            options
        )
    }

    const row = new Setting(containerEl)
    row.setClass('editor-ai-daemons-rule-row')
    row.setName(`Rule ${index + 1}`)
    row.setDesc(ruleSummary(settings, rule))
    const starterKitAvailable = isStarterKitAvailable(ctx.app)

    row.addToggle((toggle) => {
        toggle.setValue(rule.enabled)
        toggle.setTooltip(rule.enabled ? 'Enabled' : 'Disabled')
        toggle.onChange((value) => {
            mutate((target) => {
                target.enabled = value
            })
        })
    })
    row.addDropdown((dropdown) => {
        for (const [matchType, label] of Object.entries(MATCH_TYPE_LABELS)) {
            // Without the Starter Kit there is no registry to match against,
            // so the option is not offered — except on a rule already set to
            // it (a rule written when the Starter Kit was enabled, or brought
            // in by an import), where hiding it would leave the dropdown
            // showing "Folder" while the rule matched note types.
            if (
                matchType === 'osk-note-type' &&
                !starterKitAvailable &&
                rule.match.matchType !== 'osk-note-type'
            ) {
                continue
            }
            dropdown.addOption(matchType, label)
        }
        dropdown.setValue(rule.match.matchType)
        dropdown.onChange((value) => {
            mutate(
                (target) => {
                    if (
                        value === 'folder' ||
                        value === 'tag' ||
                        value === 'frontmatter' ||
                        value === 'osk-note-type'
                    ) {
                        target.match.matchType = value
                        // Switching to a picker must also store what the
                        // picker will show. A dropdown renders its first
                        // option whether or not anything selected it, so
                        // leaving the old value here would display one type
                        // while the rule matched another (and an empty value
                        // is schema-invalid besides).
                        if (value === 'osk-note-type') {
                            const first = firstOskTypeName(ctx.app)
                            if (first !== null) {
                                target.match.value = first
                            }
                        }
                    }
                },
                { refresh: true }
            )
        })
    })
    // OSK note types are a closed list when the Starter Kit is there, so the
    // control is a picker rather than a spelling exercise: the names are its
    // own ("Permanent Notes"), not the tag spelling, and getting one character
    // wrong yields a rule that silently matches nothing. A value already set
    // but no longer in the registry (type renamed, Starter Kit disabled) is
    // kept as its own option so opening this tab cannot rewrite the rule.
    const oskTypeNames =
        rule.match.matchType === 'osk-note-type'
            ? readOskNoteTypes(ctx.app)
                  .map((noteType) => noteType.name)
                  .sort((a, b) => a.localeCompare(b))
            : []
    if (oskTypeNames.length > 0) {
        row.addDropdown((dropdown) => {
            const current = rule.match.value
            if (current.length > 0 && !oskTypeNames.includes(current)) {
                dropdown.addOption(current, `${current} (not in the registry)`)
            }
            for (const name of oskTypeNames) {
                dropdown.addOption(name, name)
            }
            dropdown.setValue(current.length > 0 ? current : (oskTypeNames[0] ?? ''))
            dropdown.onChange((value) => {
                mutate((target) => {
                    target.match.value = value
                })
            })
        })
    } else {
        row.addText((text) => {
            text.setPlaceholder(VALUE_PLACEHOLDERS[rule.match.matchType])
            text.setValue(rule.match.value)
            text.onChange((value) => {
                // An empty value is schema-invalid (`ruleMatchSchema.value` is
                // min(1)); committing it would be rejected by the facade and, if
                // ever persisted, wiped by the strict load path. Keep the last
                // non-empty value instead (mirrors how modals validate on Save).
                if (value.length === 0) {
                    return
                }
                mutate((target) => {
                    target.match.value = value
                })
            })
        })
    }
    row.addDropdown((dropdown) => {
        dropdown.addOption('assign', 'Assign reviewer')
        dropdown.addOption('disabled', 'Disable plugin')
        dropdown.setValue(rule.effect)
        dropdown.onChange((value) => {
            mutate(
                (target) => {
                    if (value === 'assign' || value === 'disabled') {
                        target.effect = value
                    }
                },
                { refresh: true }
            )
        })
    })
    if (rule.effect === 'assign') {
        row.addDropdown((dropdown) => {
            populateTargetDropdown(dropdown, settings, {
                noneLabel: 'No target',
                includePanels: true
            })
            dropdown.setValue(encodeActionTarget(rule.defaultTarget))
            dropdown.onChange((value) => {
                mutate(
                    (target) => {
                        target.defaultTarget = decodeActionTarget(value)
                    },
                    { refresh: true }
                )
            })
        })
    }
    row.addExtraButton((button) => {
        button
            .setIcon('arrow-up')
            .setTooltip('Move up')
            .setDisabled(index === 0)
            .onClick(() => {
                commit(
                    ctx,
                    (draft) => {
                        const next = moveItem(draft.rules, index, index - 1)
                        if (next) {
                            draft.rules = next
                        }
                    },
                    { refresh: true }
                )
            })
    })
    row.addExtraButton((button) => {
        button
            .setIcon('arrow-down')
            .setTooltip('Move down')
            .setDisabled(index === total - 1)
            .onClick(() => {
                commit(
                    ctx,
                    (draft) => {
                        const next = moveItem(draft.rules, index, index + 1)
                        if (next) {
                            draft.rules = next
                        }
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
                commit(
                    ctx,
                    (draft) => {
                        draft.rules = draft.rules.filter((item) => item.id !== rule.id)
                    },
                    { refresh: true }
                )
            })
    })
}
