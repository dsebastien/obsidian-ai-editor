import { ExtraButtonComponent, Setting, ToggleComponent } from 'obsidian'
import type { EditorConfig } from '../../domain/settings/settings-schema'
import { ConfirmModal, renderColorDot } from '../components'
import { applyEntityDeletion, deletionImpactLines, describeBackendRef } from '../helpers'
import { EditorModal } from './editor-modal'
import { commit } from './shared'
import type { TabContext } from './shared'

/**
 * Editors tab: card gallery of AI personas (solid color dot = editor) with
 * enable/edit/delete, plus the add flow. Deletion shows referential impact
 * (panels, actions, rules, comment default) before anything is removed.
 */
export function renderEditorsTab(containerEl: HTMLElement, ctx: TabContext): void {
    const settings = ctx.facade.getSettings()

    containerEl.createEl('p', {
        cls: 'editor-ai-daemons-tab-intro',
        text: 'Editors are AI personas that review your notes. A solid color dot identifies an editor everywhere in the plugin.'
    })

    new Setting(containerEl)
        .setName('Add editor')
        .setDesc('Create a new persona with its own prompt, color, and backend.')
        .addButton((button) => {
            button
                .setButtonText('Add editor')
                .setCta()
                .onClick(() => {
                    new EditorModal(ctx.app, ctx, null).open()
                })
        })

    if (settings.editors.length === 0) {
        containerEl.createEl('p', {
            cls: 'editor-ai-daemons-empty-state',
            text: 'No editors yet. Add one to get your first reviewer.'
        })
        return
    }

    const grid = containerEl.createDiv({ cls: 'editor-ai-daemons-card-grid' })
    for (const editor of settings.editors) {
        renderEditorCard(grid, ctx, editor)
    }
}

function renderEditorCard(grid: HTMLElement, ctx: TabContext, editor: EditorConfig): void {
    const settings = ctx.facade.getSettings()
    const card = grid.createDiv({ cls: 'editor-ai-daemons-card' })
    if (!editor.enabled) {
        card.addClass('is-disabled')
    }

    const title = card.createDiv({ cls: 'editor-ai-daemons-card-title' })
    renderColorDot(title, editor.color, 'editor')
    title.createSpan({ text: editor.name })

    card.createDiv({
        cls: 'editor-ai-daemons-card-sub',
        text: describeBackendRef(settings, editor.backend)
    })
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
    card.createDiv({
        cls: 'editor-ai-daemons-card-sub',
        text: capabilities.length > 0 ? capabilities.join(' · ') : 'no capabilities'
    })

    const actions = card.createDiv({ cls: 'editor-ai-daemons-card-actions' })
    const toggle = new ToggleComponent(actions)
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
    new ExtraButtonComponent(actions)
        .setIcon('pencil')
        .setTooltip('Edit')
        .onClick(() => {
            new EditorModal(ctx.app, ctx, editor).open()
        })
    new ExtraButtonComponent(actions)
        .setIcon('trash')
        .setTooltip('Delete')
        .onClick(() => {
            const current = ctx.facade.getSettings()
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
        })
}
