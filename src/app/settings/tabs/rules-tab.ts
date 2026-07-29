import { Setting } from 'obsidian'
import type { BindingRule, RuleMatch } from '../../domain/settings/settings-schema'
import { generateId } from '../../domain/ids'
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
    'folder': 'Folder path, e.g. Blog',
    'tag': 'Tag without #, e.g. draft',
    'frontmatter': 'key: value, e.g. type: article',
    'osk-note-type': 'Note type name, e.g. permanent-notes'
}

/**
 * Rules tab: ordered binding rules (first match wins). A rule matches notes
 * by folder/tag/frontmatter/OSK note type and either assigns a default
 * reviewer (editor or panel) or disables the plugin UI for that scope.
 */
export function renderRulesTab(containerEl: HTMLElement, ctx: TabContext): void {
    const settings = ctx.facade.getSettings()

    containerEl.createEl('p', {
        cls: 'ai-editor-tab-intro',
        text: 'Rules are evaluated top to bottom; the first match wins. “Disable plugin” is a kill switch: no rail, no menus, no AI for matching notes.'
    })
    containerEl.createEl('p', {
        cls: 'ai-editor-tab-intro',
        text: 'OSK note type matching requires the Obsidian Starter Kit plugin; type auto-discovery is feature-detected in a later milestone. Rules using it stay inert until then.'
    })

    if (settings.rules.length === 0) {
        containerEl.createEl('p', { cls: 'ai-editor-empty-state', text: 'No rules yet.' })
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
    row.setClass('ai-editor-rule-row')
    row.setName(`Rule ${index + 1}`)
    row.setDesc(ruleSummary(settings, rule))

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
                    }
                },
                { refresh: true }
            )
        })
    })
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
