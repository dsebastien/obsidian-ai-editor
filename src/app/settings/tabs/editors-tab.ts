import type { SettingDefinition, SettingDefinitionItem } from 'obsidian'
import type { EditorConfig, PluginSettingsV1 } from '../../domain/settings/settings-schema'
import { ConfirmModal, renderColorDot } from '../components'
import { applyEntityDeletion, deletionImpactLines, describeBackendRef, moveItem } from '../helpers'
import { EditorModal } from './editor-modal'
import { commit } from './shared'
import type { TabContext } from './shared'

/**
 * Editors page: the collection of AI personas (solid color dot = editor), with
 * enable/edit/delete/reorder and the add flow. Deletion shows referential
 * impact (panels, actions, rules, comment default) before anything is removed.
 *
 * The list's order IS the editor order everywhere else (issue #46): the review
 * pool is built by filtering `settings.editors` (`resolveReviewParticipants`),
 * the run keeps that order in its editor-state map, and both the rail and the
 * panel render straight off it. So `onReorder` here is the single control for
 * "who runs, and shows, first" — no separate order field exists or is needed.
 *
 * Declarative (issue #35): a `list` rather than a `group`, because these are
 * entries the user adds, reorders and removes. The framework supplies all three
 * affordances — `addItem` (the `+` in the header), the drag handle wired to
 * `onReorder`, the delete button wired to `onDelete` — which is why the
 * hand-built move-up/move-down buttons and their `moveEditor` helper are gone:
 * dragging is the same array move, done natively. `onDelete` still routes
 * through `ConfirmModal` with the referential impact lines; the framework asks
 * us to delete, it does not delete for us.
 *
 * The rows themselves stay imperative. An editor row carries BOTH an enable
 * toggle and an edit affordance, and a definition is exactly one of
 * control/action/render — so neither a `control` row (toggle, no way to open
 * the modal) nor an `action` row (modal, no way to enable) can carry both.
 * `render` builds the row from the existing pieces (`renderColorDot`,
 * `describeBackendRef`), and `name`/`desc` stay on the definition so settings
 * search still finds each editor by name, backend and capabilities.
 */
export function editorsPageItems(ctx: TabContext): SettingDefinitionItem[] {
    const settings = ctx.facade.getSettings()

    return [
        {
            type: 'group',
            heading: 'Editors',
            items: [
                {
                    name: 'About editors',
                    desc: 'Editors are AI personas that review your notes. A solid color dot identifies an editor everywhere in the plugin.',
                    // Explanatory copy, not a setting: keeping it out of search
                    // stops it matching every editor query ahead of the editors
                    // themselves.
                    searchable: false
                },
                {
                    name: 'About editor order',
                    desc: 'Drag an editor to move it. This order is the order editors run in, and the order they appear in the rail and the review panel. Put the ones you care about most first.',
                    searchable: false
                }
            ]
        },
        {
            type: 'list',
            heading: 'Your editors',
            emptyState: 'No editors yet. Add one to get your first reviewer.',
            addItem: {
                name: 'Add editor',
                action: (): void => {
                    new EditorModal(ctx.app, ctx, null).open()
                }
            },
            // Reordering moves the editor within `settings.editors` itself —
            // the one array every downstream surface reads — so a disabled
            // editor keeps its slot and re-enabling restores the intended
            // position.
            onReorder: (oldIndex, newIndex): void => {
                commit(
                    ctx,
                    (draft) => {
                        const next = moveItem(draft.editors, oldIndex, newIndex)
                        if (next) {
                            draft.editors = next
                        }
                    },
                    { refresh: true }
                )
            },
            onDelete: (index): void => {
                // Read the editor at delete time rather than closing over the
                // one captured at render time: the row index is what the
                // framework hands back, and the array may have been reordered
                // since this tree was built.
                const current = ctx.facade.getSettings()
                const editor = current.editors[index]
                if (!editor) {
                    return
                }
                new ConfirmModal(ctx.app, {
                    title: 'Delete editor',
                    message: `Delete editor "${editor.name}"? This cannot be undone.`,
                    impactLines: deletionImpactLines(current, 'editor', editor.id),
                    ctaLabel: 'Delete',
                    onConfirm: () => {
                        commit(
                            ctx,
                            (draft) => {
                                applyEntityDeletion(draft, 'editor', editor.id)
                            },
                            { refresh: true }
                        )
                    }
                }).open()
            },
            items: settings.editors.map((editor) => editorRow(ctx, settings, editor))
        }
    ]
}

/** One editor row: identity dot, backend and capabilities, enable, edit. */
function editorRow(
    ctx: TabContext,
    settings: PluginSettingsV1,
    editor: EditorConfig
): SettingDefinition {
    const summary = `${describeBackendRef(settings, editor.backend)} · ${describeCapabilities(editor)}`

    return {
        name: editor.name,
        desc: summary,
        render: (setting): void => {
            setting.setName(
                createFragment((frag) => {
                    renderColorDot(frag, editor.color, 'editor')
                    frag.createSpan({ text: editor.name })
                })
            )
            setting.setDesc(summary)
            setting.addToggle((toggle) => {
                toggle.setValue(editor.enabled)
                toggle.setTooltip(editor.enabled ? 'Enabled' : 'Disabled')
                toggle.onChange((value) => {
                    commit(
                        ctx,
                        (draft) => {
                            const target = draft.editors.find((item) => item.id === editor.id)
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
                        new EditorModal(ctx.app, ctx, editor).open()
                    })
            })
        }
    }
}

/** `review · rewrite · research`, or a plain statement when none are on. */
function describeCapabilities(editor: EditorConfig): string {
    const capabilities: string[] = []
    if (editor.capabilities.review) {
        capabilities.push('review')
    }
    if (editor.capabilities.rewrite) {
        capabilities.push('rewrite')
    }
    if (editor.capabilities.research) {
        capabilities.push('research')
    }
    return capabilities.length > 0 ? capabilities.join(' · ') : 'no capabilities'
}
