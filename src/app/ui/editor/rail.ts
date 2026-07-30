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
import type { RailDotViewModel, RailState } from './rail-model'

export interface RailCallbacks {
    readonly onReview: () => void
    readonly onCancel: () => void
    readonly onEditorClick: (editorId: string) => void
    /** Retry the one failed/cancelled editor inside the existing run. */
    readonly onRetry: (editorId: string) => void
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
     */
    private applyTooltip(el: HTMLElement, tooltip: string): void {
        el.setAttribute('aria-label', tooltip)
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
        this.applyTooltip(button, viewModel.button.ariaLabel)
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
        for (const dot of viewModel.dots) {
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
