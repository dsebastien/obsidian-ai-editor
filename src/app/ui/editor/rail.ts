/**
 * Persona rail — the vertical strip of editor dots plus the Review/Cancel
 * button, rendered next to the editor.
 *
 * Review findings addressed:
 * - #19 (rail): NOT a CM6 gutter — gutters are line-oriented and scroll with
 *   content, while the rail is persistent chrome. This is a plain positioned
 *   element owned by the hosting view: the view appends it to a container it
 *   controls and calls `destroy()` on unload.
 * - #23 (popouts): every element is created through the `Document` provided
 *   at construction (the owning view's document), never a captured global
 *   `document`, so rails in popout windows render into the right DOM tree.
 *
 * Pure DOM, no Obsidian imports; all display logic lives in `rail-model.ts`.
 */

import { buildRailViewModel } from './rail-model'
import type { RailDotViewModel, RailPanelViewModel, RailState } from './rail-model'

export interface RailCallbacks {
    readonly onReview: () => void
    readonly onCancel: () => void
    readonly onEditorClick: (editorId: string) => void
    /** Retry the one failed/cancelled editor inside the existing run. */
    readonly onRetry: (editorId: string) => void
    /**
     * The panel chip was selected: open the side panel, where the scorecard
     * lives. The chip has no inline surface of its own — a verdict, ranked
     * fixes and dissent do not fit in a tooltip.
     */
    readonly onPanelClick: () => void
}

/**
 * Hover-tooltip attachment seam. The hosting view passes Obsidian's
 * `setTooltip` (wrapped with a placement) so chips get native themed
 * tooltips; without one the rail falls back to the `title` attribute —
 * keeping this file Obsidian-free and unit-testable either way.
 */
export type RailTooltipSetter = (el: HTMLElement, tooltip: string) => void

export class PersonaRail {
    private readonly doc: Document
    private readonly rootEl: HTMLElement

    /**
     * @param containerEl   view-owned element the rail attaches to
     * @param callbacks     user-intent handlers (never invoked after destroy)
     * @param doc           owning document; defaults to the container's — pass
     *                      the view's document explicitly in popout contexts
     * @param tooltipSetter native tooltip attachment (Obsidian `setTooltip`);
     *                      falls back to the `title` attribute when absent
     */
    constructor(
        containerEl: HTMLElement,
        private readonly callbacks: RailCallbacks,
        doc?: Document,
        private readonly tooltipSetter?: RailTooltipSetter
    ) {
        this.doc = doc ?? containerEl.ownerDocument
        this.rootEl = this.doc.createElement('div')
        this.rootEl.classList.add('ai-editor-rail')
        containerEl.appendChild(this.rootEl)
    }

    /**
     * Screen-reader label plus hover tooltip for one element. The native
     * setter and the `title` fallback are mutually exclusive so no element
     * ever shows two tooltips.
     *
     * `ariaLabel` defaults to the tooltip and is passed separately wherever
     * the two differ — a control is NAMED, not instructed, so guidance that
     * belongs in a tooltip ("narrow pane — run …") must not become the
     * accessible name. Setting the name before calling this would not work:
     * this is the last writer.
     */
    private applyTooltip(el: HTMLElement, tooltip: string, ariaLabel: string = tooltip): void {
        el.setAttribute('aria-label', ariaLabel)
        if (this.tooltipSetter) {
            this.tooltipSetter(el, tooltip)
        } else {
            el.title = tooltip
        }
    }

    /** Rebuilds the rail DOM from the given state (idempotent, cheap). */
    render(state: RailState): void {
        const viewModel = buildRailViewModel(state)
        this.rootEl.replaceChildren()
        // Narrow pane: icon-only, tighter spacing (plan M4 adaptive layout).
        this.rootEl.classList.toggle('ai-editor-rail-compact', viewModel.compact)

        const button = this.doc.createElement('button')
        button.classList.add('ai-editor-rail-button')
        if (viewModel.button.action === 'cancel') {
            button.classList.add('ai-editor-rail-button-cancel')
        }
        button.textContent = viewModel.button.text
        // The compact form shows a glyph, so the accessible name has to come
        // from the model — the narrow-pane guidance rides the tooltip only.
        this.applyTooltip(button, viewModel.button.tooltip, viewModel.button.ariaLabel)
        button.disabled = viewModel.button.disabled
        button.addEventListener('click', () => {
            if (viewModel.button.action === 'cancel') {
                this.callbacks.onCancel()
            } else {
                this.callbacks.onReview()
            }
        })
        this.rootEl.appendChild(button)

        const dotsEl = this.doc.createElement('div')
        dotsEl.classList.add('ai-editor-rail-dots')
        dotsEl.setAttribute('role', 'group')
        dotsEl.setAttribute('aria-label', 'Editors')
        // A panel run renders as ONE entity: a ringed chip owning its members
        // (Business Rules #11). Editors that are not members of it keep their
        // place outside the group — they are still their own editors.
        const panel = viewModel.panel
        if (panel !== null) {
            const groupEl = this.doc.createElement('div')
            groupEl.classList.add('ai-editor-rail-panel')
            groupEl.setAttribute('role', 'group')
            groupEl.setAttribute('aria-label', panel.groupLabel)
            groupEl.appendChild(this.renderPanelChip(panel))
            for (const dot of viewModel.dots.filter((candidate) => candidate.member)) {
                groupEl.appendChild(this.renderChip(dot))
            }
            dotsEl.appendChild(groupEl)
        }
        for (const dot of viewModel.dots.filter(
            (candidate) => panel === null || !candidate.member
        )) {
            dotsEl.appendChild(this.renderChip(dot))
        }
        this.rootEl.appendChild(dotsEl)

        // Daemon armed indicator: one tiny pulsing dot with a tooltip —
        // deliberately minimal, no layout churn (absent when not armed).
        if (viewModel.daemon !== null) {
            const daemonEl = this.doc.createElement('div')
            daemonEl.classList.add('ai-editor-rail-daemon')
            daemonEl.setAttribute('role', 'status')
            this.applyTooltip(daemonEl, viewModel.daemon.title)
            this.rootEl.appendChild(daemonEl)
        }
    }

    /** Removes the rail from the DOM. The instance must not be reused. */
    destroy(): void {
        this.rootEl.remove()
    }

    /**
     * One editor chip: the status dot, plus a retry icon-button when the
     * editor's attempt failed or was cancelled (`retryAriaLabel` non-null).
     */
    private renderChip(dot: RailDotViewModel): HTMLElement {
        const chipEl = this.doc.createElement('div')
        chipEl.classList.add('ai-editor-rail-chip')
        chipEl.appendChild(this.renderDot(dot))
        if (dot.retryAriaLabel !== null) {
            const retryEl = this.doc.createElement('button')
            retryEl.classList.add('ai-editor-rail-retry')
            // Text glyph on purpose: the rail is Obsidian-free DOM (no
            // setIcon) and must not use innerHTML.
            retryEl.textContent = '↻'
            this.applyTooltip(retryEl, dot.retryAriaLabel)
            retryEl.addEventListener('click', () => {
                this.callbacks.onRetry(dot.editorId)
            })
            chipEl.appendChild(retryEl)
        }
        return chipEl
    }

    /**
     * The panel's own chip: a RING, never a solid dot — that is the whole
     * distinction Business Rules #11 asks for, and it carries the scorecard's
     * verdict as its badge once there is one.
     */
    private renderPanelChip(panel: RailPanelViewModel): HTMLElement {
        const chipEl = this.doc.createElement('button')
        chipEl.classList.add('ai-editor-rail-panel-chip', `ai-editor-rail-panel-${panel.status}`)
        chipEl.style.setProperty('--ai-editor-editor-color', panel.color)
        this.applyTooltip(chipEl, panel.title, panel.ariaLabel)
        chipEl.addEventListener('click', () => {
            this.callbacks.onPanelClick()
        })
        if (panel.badge !== null) {
            const badgeEl = this.doc.createElement('span')
            badgeEl.classList.add('ai-editor-rail-panel-badge')
            badgeEl.textContent = panel.badge
            // The verdict is already in the chip's accessible name.
            badgeEl.setAttribute('aria-hidden', 'true')
            chipEl.appendChild(badgeEl)
        }
        return chipEl
    }

    private renderDot(dot: RailDotViewModel): HTMLElement {
        const dotEl = this.doc.createElement('button')
        dotEl.classList.add('ai-editor-rail-dot', `ai-editor-rail-dot-${dot.status}`)
        dotEl.style.setProperty('--ai-editor-editor-color', dot.color)
        this.applyTooltip(dotEl, dot.title)
        dotEl.dataset['editorId'] = dot.editorId
        dotEl.addEventListener('click', () => {
            this.callbacks.onEditorClick(dot.editorId)
        })
        if (dot.badge !== null) {
            const badgeEl = this.doc.createElement('span')
            badgeEl.classList.add('ai-editor-rail-badge')
            badgeEl.textContent = dot.badge
            // The count is already in the dot's aria-label.
            badgeEl.setAttribute('aria-hidden', 'true')
            dotEl.appendChild(badgeEl)
        }
        return dotEl
    }
}
