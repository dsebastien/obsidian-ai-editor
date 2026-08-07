import type { SettingDefinitionItem, SettingGroupItem } from 'obsidian'
import type { PanelConfig } from '../../domain/settings/settings-schema'
import { ConfirmModal, renderColorDot } from '../components'
import { applyEntityDeletion, deletionImpactLines, describeBackendRef, moveItem } from '../helpers'
import { PanelModal } from './panel-modal'
import { commit } from './shared'
import type { TabContext } from './shared'

/**
 * Panels page: the collection of editor groups. Panels aggregate their members'
 * findings into a scorecard (verdicts, top fixes, dissent) and use ringed dots
 * so they are visually distinct from editors on every surface (Business Rule
 * #11).
 *
 * Declarative (issue #35): panels are a COLLECTION, not a set of scalars, so
 * the page is one `list`. The framework owns the add affordance, the empty
 * state, the delete button and the drag handle; `items` is `settings.panels`
 * mapped to rows. Deletion still goes through `ConfirmModal` with the
 * referential impact lines — from the list's `onDelete` now instead of a
 * per-card trash button — so nothing about deletion safety changes.
 *
 * There is not a single `control` definition on this page, and that is not an
 * oversight: everything a panel owns (name, color, members, charter,
 * aggregation backend) lives at an ARRAY index rather than a fixed dot path
 * into `PluginSettingsV1`, and is edited in `PanelModal`. An index-shaped key
 * (`panels.3.enabled`) would silently address a different panel after a delete
 * or a reorder, so the rows bind nothing.
 *
 * The rows stay imperative (`render`) for one reason: a panel row carries BOTH
 * its enable/disable toggle and its edit affordance, which no single `control`
 * or `action` definition covers, and the toggle exists on no other surface —
 * `PanelModal` does not offer it. Name and description are still declared on
 * each definition, so Obsidian's settings search finds a panel by its name.
 */
export function panelsPageItems(ctx: TabContext): SettingDefinitionItem[] {
    const settings = ctx.facade.getSettings()
    // Panels are composed FROM editors, so with no editors there is nothing to
    // compose: the old tab disabled its Add button, and the declarative add
    // affordance has no disabled state, so it is simply not offered and the
    // empty state says what to do first.
    const hasEditors = settings.editors.length > 0

    return [
        {
            name: 'About panels',
            desc: 'Panels group editors and aggregate their findings into a scorecard with verdicts, top fixes, and dissent. A ringed dot identifies a panel everywhere.',
            // Explanatory copy, not a setting: keeping it out of search stops
            // it matching every panel query ahead of the panels themselves.
            searchable: false
        },
        {
            type: 'list',
            heading: 'Panels',
            emptyState: hasEditors
                ? 'No panels yet.'
                : 'Create editors first — panels are built from them.',
            ...(hasEditors
                ? {
                      addItem: {
                          name: 'Add panel',
                          action: (): void => {
                              new PanelModal(ctx.app, ctx, null).open()
                          }
                      }
                  }
                : {}),
            // Row order IS `settings.panels` order, which is the order panels
            // are offered in (the freeform ask, the action targets), so the
            // drag handle moves the panel within that one array.
            onReorder: (oldIndex: number, newIndex: number): void => {
                commit(
                    ctx,
                    (draft) => {
                        const next = moveItem(draft.panels, oldIndex, newIndex)
                        if (next) {
                            draft.panels = next
                        }
                    },
                    { refresh: true }
                )
            },
            onDelete: (index: number): void => {
                confirmPanelDeletion(ctx, index)
            },
            items: settings.panels.map((panel) => panelRow(ctx, panel))
        }
    ]
}

/**
 * One panel row: ringed dot + name, its members and aggregation backend, an
 * enable toggle, and the pencil that opens `PanelModal`. The declared `name`
 * and `desc` are what search matches on; `render` draws the row itself.
 */
function panelRow(ctx: TabContext, panel: PanelConfig): SettingGroupItem {
    const summary = describePanel(ctx, panel)
    return {
        name: panel.name,
        desc: summary,
        render: (setting): void => {
            const nameFragment = new DocumentFragment()
            renderColorDot(nameFragment, panel.color, 'panel')
            nameFragment.createSpan({ text: panel.name })
            setting.setName(nameFragment)
            setting.setDesc(summary)
            setting.addToggle((toggle) => {
                toggle.setValue(panel.enabled)
                toggle.setTooltip(panel.enabled ? 'Enabled' : 'Disabled')
                toggle.onChange((value) => {
                    commit(
                        ctx,
                        (draft) => {
                            const target = draft.panels.find((item) => item.id === panel.id)
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
                        new PanelModal(ctx.app, ctx, panel).open()
                    })
            })
        }
    }
}

/** Members and aggregation backend, plus the disabled state the row shows. */
function describePanel(ctx: TabContext, panel: PanelConfig): string {
    const settings = ctx.facade.getSettings()
    const memberNames = panel.memberEditorIds.map(
        (memberId) =>
            settings.editors.find((editor) => editor.id === memberId)?.name ?? 'missing editor'
    )
    const members = `${memberNames.length} member${memberNames.length === 1 ? '' : 's'}: ${memberNames.join(', ')}`
    const aggregation = `Aggregation: ${describeBackendRef(settings, panel.aggregationBackend)}`
    return panel.enabled ? `${members} · ${aggregation}` : `${members} · ${aggregation} · Disabled`
}

/**
 * The delete flow, unchanged in substance: the referential impact is shown
 * first (which actions and rules point at this panel), and only a confirmed
 * deletion commits. Member editors are kept — deleting a panel deletes the
 * grouping, not the personas.
 */
function confirmPanelDeletion(ctx: TabContext, index: number): void {
    const current = ctx.facade.getSettings()
    const panel = current.panels[index]
    if (!panel) {
        return
    }
    new ConfirmModal(ctx.app, {
        title: 'Delete panel',
        message: `Delete panel "${panel.name}"? Member editors are kept; only the panel goes away.`,
        impactLines: deletionImpactLines(current, 'panel', panel.id),
        ctaLabel: 'Delete',
        onConfirm: () => {
            commit(
                ctx,
                (draft) => {
                    applyEntityDeletion(draft, 'panel', panel.id)
                },
                { refresh: true }
            )
        }
    }).open()
}
