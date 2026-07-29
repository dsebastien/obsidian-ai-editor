import { ExtraButtonComponent, Setting, ToggleComponent } from 'obsidian'
import type { PanelConfig } from '../../domain/settings/settings-schema'
import { ConfirmModal, renderColorDot } from '../components'
import { applyEntityDeletion, deletionImpactLines, describeBackendRef } from '../helpers'
import { PanelModal } from './panel-modal'
import { commit } from './shared'
import type { TabContext } from './shared'

/**
 * Panels tab: card gallery of editor groups. Panels use ringed dots so they
 * are visually distinct from editors on every surface (Business Rule #11).
 */
export function renderPanelsTab(containerEl: HTMLElement, ctx: TabContext): void {
    const settings = ctx.facade.getSettings()

    containerEl.createEl('p', {
        cls: 'ai-editor-tab-intro',
        text: 'Panels group editors and aggregate their findings into a scorecard with verdicts, top fixes, and dissent. A ringed dot identifies a panel everywhere.'
    })

    new Setting(containerEl)
        .setName('Add panel')
        .setDesc('Compose a panel from existing editors.')
        .addButton((button) => {
            button
                .setButtonText('Add panel')
                .setCta()
                .setDisabled(settings.editors.length === 0)
                .onClick(() => {
                    new PanelModal(ctx.app, ctx, null).open()
                })
        })
    if (settings.editors.length === 0) {
        containerEl.createEl('p', {
            cls: 'ai-editor-empty-state',
            text: 'Create editors first — panels are built from them.'
        })
        return
    }

    if (settings.panels.length === 0) {
        containerEl.createEl('p', {
            cls: 'ai-editor-empty-state',
            text: 'No panels yet.'
        })
        return
    }

    const grid = containerEl.createDiv({ cls: 'ai-editor-card-grid' })
    for (const panel of settings.panels) {
        renderPanelCard(grid, ctx, panel)
    }
}

function renderPanelCard(grid: HTMLElement, ctx: TabContext, panel: PanelConfig): void {
    const settings = ctx.facade.getSettings()
    const card = grid.createDiv({ cls: 'ai-editor-card' })
    if (!panel.enabled) {
        card.addClass('is-disabled')
    }

    const title = card.createDiv({ cls: 'ai-editor-card-title' })
    renderColorDot(title, panel.color, 'panel')
    title.createSpan({ text: panel.name })

    const memberNames = panel.memberEditorIds.map(
        (memberId) =>
            settings.editors.find((editor) => editor.id === memberId)?.name ?? 'missing editor'
    )
    card.createDiv({
        cls: 'ai-editor-card-sub',
        text: `${memberNames.length} member${memberNames.length === 1 ? '' : 's'}: ${memberNames.join(', ')}`
    })
    card.createDiv({
        cls: 'ai-editor-card-sub',
        text: `Aggregation: ${describeBackendRef(settings, panel.aggregationBackend)}`
    })

    const actions = card.createDiv({ cls: 'ai-editor-card-actions' })
    const toggle = new ToggleComponent(actions)
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
    new ExtraButtonComponent(actions)
        .setIcon('pencil')
        .setTooltip('Edit')
        .onClick(() => {
            new PanelModal(ctx.app, ctx, panel).open()
        })
    new ExtraButtonComponent(actions)
        .setIcon('trash')
        .setTooltip('Delete')
        .onClick(() => {
            const current = ctx.facade.getSettings()
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
        })
}
