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
}

export class PersonaRail {
    private readonly doc: Document
    private readonly rootEl: HTMLElement

    /**
     * @param containerEl view-owned element the rail attaches to
     * @param callbacks   user-intent handlers (never invoked after destroy)
     * @param doc         owning document; defaults to the container's — pass
     *                    the view's document explicitly in popout contexts
     */
    constructor(
        containerEl: HTMLElement,
        private readonly callbacks: RailCallbacks,
        doc?: Document
    ) {
        this.doc = doc ?? containerEl.ownerDocument
        this.rootEl = this.doc.createElement('div')
        this.rootEl.classList.add('ai-editor-rail')
        containerEl.appendChild(this.rootEl)
    }

    /** Rebuilds the rail DOM from the given state (idempotent, cheap). */
    render(state: RailState): void {
        const viewModel = buildRailViewModel(state)
        this.rootEl.replaceChildren()

        const button = this.doc.createElement('button')
        button.classList.add('ai-editor-rail-button')
        if (viewModel.button.action === 'cancel') {
            button.classList.add('ai-editor-rail-button-cancel')
        }
        button.textContent = viewModel.button.label
        button.setAttribute('aria-label', viewModel.button.ariaLabel)
        button.title = viewModel.button.ariaLabel
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
            dotsEl.appendChild(this.renderDot(dot))
        }
        this.rootEl.appendChild(dotsEl)
    }

    /** Removes the rail from the DOM. The instance must not be reused. */
    destroy(): void {
        this.rootEl.remove()
    }

    private renderDot(dot: RailDotViewModel): HTMLElement {
        const dotEl = this.doc.createElement('button')
        dotEl.classList.add('ai-editor-rail-dot', `ai-editor-rail-dot-${dot.status}`)
        dotEl.style.setProperty('--ai-editor-editor-color', dot.color)
        dotEl.setAttribute('aria-label', dot.ariaLabel)
        dotEl.title = dot.title
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
