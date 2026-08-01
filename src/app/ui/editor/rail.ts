/**
 * Persona rail — the card of named editor rows plus the Review/Cancel button
 * and the daemon toggle, floating at the top-right of the editor.
 *
 * Every row shows its editor's NAME as text (Sébastien, 2026-08-01: "daemon
 * names should always be visible"), a ring around a persona-coloured identity
 * core saying what that editor is doing, and its finding count. A narrow pane
 * makes all of that denser — never invisible; the side panel remains the
 * surface for reading findings in a narrow pane, and the button tooltip says
 * so.
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

import { buildRailViewModel, railMotion } from './rail-model'
import type {
    RailDotViewModel,
    RailMotionCues,
    RailMotionState,
    RailPanelViewModel,
    RailRingKind,
    RailState,
    RailViewModel
} from './rail-model'

export interface RailCallbacks {
    readonly onReview: () => void
    readonly onCancel: () => void
    /**
     * Flip daemon mode. Sébastien asked for it here, next to Review: it is a
     * per-session decision, and the settings toggle and the palette command
     * both remain. The control is a toggle button rather than a switch
     * widget so the rail stays plain DOM (no Obsidian imports).
     */
    readonly onToggleDaemon: () => void
    readonly onEditorClick: (editorId: string) => void
    /** Retry the one failed/cancelled editor inside the existing run. */
    readonly onRetry: (editorId: string) => void
    /**
     * The panel row was selected: open the side panel, where the scorecard
     * lives. The row has no inline surface of its own — a verdict, ranked
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
     * What the previous render showed, so `railMotion` can tell a new run from
     * the dozens of re-renders inside one. The rail rebuilds its children on
     * every state change, so without this every streamed finding would replay
     * the entrance animation of every row.
     */
    private motion: RailMotionState | null = null

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
        this.rootEl.classList.add('editor-ai-daemons-rail')
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
        const { state: nextMotion, cues } = railMotion(this.motion, viewModel)
        this.motion = nextMotion
        this.rootEl.replaceChildren()
        // Narrow pane: denser, NOT icon-only (plan M4 adaptive layout, revised
        // 2026-08-01 — the names are the point of the rail).
        this.rootEl.classList.toggle('editor-ai-daemons-rail-compact', viewModel.compact)

        this.rootEl.appendChild(this.renderHead(viewModel.daemon, viewModel.button))

        const listEl = this.doc.createElement('div')
        listEl.classList.add('editor-ai-daemons-rail-list')
        // A new run: the rows animate in, staggered. Not on every render —
        // the rail rebuilds on every streamed finding (see `railMotion`).
        listEl.classList.toggle('editor-ai-daemons-rail-list-enter', cues.stagger)
        listEl.setAttribute('role', 'group')
        listEl.setAttribute('aria-label', 'Editors')
        // A panel run renders as ONE entity: a ringed row owning its members
        // (Business Rules #11). Editors that are not members of it keep their
        // place outside the group — they are still their own editors.
        const panel = viewModel.panel
        let index = 0
        if (panel !== null) {
            const groupEl = this.doc.createElement('div')
            groupEl.classList.add('editor-ai-daemons-rail-group')
            groupEl.setAttribute('role', 'group')
            groupEl.setAttribute('aria-label', panel.groupLabel)
            groupEl.appendChild(this.renderPanelRow(panel, cues, index))
            index += 1
            const membersEl = this.doc.createElement('div')
            membersEl.classList.add('editor-ai-daemons-rail-members')
            for (const dot of viewModel.dots.filter((candidate) => candidate.member)) {
                membersEl.appendChild(this.renderRow(dot, cues, index))
                index += 1
            }
            groupEl.appendChild(membersEl)
            listEl.appendChild(groupEl)
        }
        for (const dot of viewModel.dots.filter(
            (candidate) => panel === null || !candidate.member
        )) {
            listEl.appendChild(this.renderRow(dot, cues, index))
            index += 1
        }
        this.rootEl.appendChild(listEl)
    }

    /** Removes the rail from the DOM. The instance must not be reused. */
    destroy(): void {
        this.rootEl.remove()
    }

    /**
     * The rail's head: the daemon toggle, then the Review/Cancel button.
     *
     * Order is Sébastien's: the mode you are in is context for the button
     * underneath it, not a footnote after the editors. The hierarchy is
     * carried by weight instead — Review is the filled primary control, the
     * toggle is a quiet status light you can press. The toggle is present in
     * BOTH states; a control that only appeared once daemon mode was on could
     * never be the thing that turns it on.
     */
    private renderHead(
        daemon: RailViewModel['daemon'],
        button: RailViewModel['button']
    ): HTMLElement {
        const headEl = this.doc.createElement('div')
        headEl.classList.add('editor-ai-daemons-rail-head')

        const daemonEl = this.doc.createElement('button')
        daemonEl.classList.add('editor-ai-daemons-rail-daemon')
        daemonEl.type = 'button'
        const glyphEl = this.doc.createElement('span')
        glyphEl.classList.add('editor-ai-daemons-rail-daemon-glyph')
        glyphEl.textContent = daemon.text
        daemonEl.appendChild(glyphEl)
        if (daemon.label !== null) {
            const labelEl = this.doc.createElement('span')
            labelEl.classList.add('editor-ai-daemons-rail-daemon-label')
            labelEl.textContent = daemon.label
            daemonEl.appendChild(labelEl)
        }
        daemonEl.setAttribute('aria-pressed', String(daemon.enabled))
        daemonEl.classList.toggle('editor-ai-daemons-rail-daemon-on', daemon.enabled)
        daemonEl.classList.toggle('editor-ai-daemons-rail-daemon-armed', daemon.armed)
        // The visible word is "Daemon" and the accessible name starts with it
        // ("Daemon mode off"), so naming the control does not hide its label
        // from anyone driving it by voice (WCAG 2.5.3).
        this.applyTooltip(daemonEl, daemon.tooltip, daemon.ariaLabel)
        daemonEl.addEventListener('click', () => {
            this.callbacks.onToggleDaemon()
        })
        headEl.appendChild(daemonEl)

        const buttonEl = this.doc.createElement('button')
        buttonEl.classList.add('editor-ai-daemons-rail-button')
        if (button.action === 'cancel') {
            buttonEl.classList.add('editor-ai-daemons-rail-button-cancel')
        }
        buttonEl.textContent = button.label
        // The label is the accessible name in both layouts; only the
        // narrow-pane guidance rides the tooltip.
        this.applyTooltip(buttonEl, button.tooltip, button.ariaLabel)
        buttonEl.disabled = button.disabled
        buttonEl.addEventListener('click', () => {
            if (button.action === 'cancel') {
                this.callbacks.onCancel()
            } else {
                this.callbacks.onReview()
            }
        })
        headEl.appendChild(buttonEl)
        return headEl
    }

    /**
     * One editor row: identity + name + count, plus a retry icon-button when
     * the editor's attempt failed or was cancelled (`retryAriaLabel` non-null).
     * The retry button is a sibling of the row button, not a child — nesting
     * an interactive element inside another is invalid and unreachable by
     * keyboard.
     */
    private renderRow(dot: RailDotViewModel, cues: RailMotionCues, index: number): HTMLElement {
        const slotEl = this.doc.createElement('div')
        slotEl.classList.add('editor-ai-daemons-rail-slot')
        this.applyStagger(slotEl, index)

        const rowEl = this.doc.createElement('button')
        rowEl.type = 'button'
        rowEl.classList.add('editor-ai-daemons-rail-row')
        rowEl.classList.toggle(
            'editor-ai-daemons-rail-row-settled',
            cues.settled.includes(dot.editorId)
        )
        rowEl.style.setProperty('--editor-ai-daemons-editor-color', dot.color)
        this.applyTooltip(rowEl, dot.title)
        rowEl.dataset['editorId'] = dot.editorId
        rowEl.addEventListener('click', () => {
            this.callbacks.onEditorClick(dot.editorId)
        })
        // Solid core = editor (Business Rules #11); the ring around it is the
        // status, never the identity.
        rowEl.appendChild(this.renderIndicator(dot.ring, false))
        rowEl.appendChild(this.renderName(dot.displayName))
        if (dot.badge !== null) {
            // The count is already in the row's aria-label.
            rowEl.appendChild(
                this.renderBadge(
                    dot.badge,
                    'editor-ai-daemons-rail-count',
                    cues.bumped.includes(dot.editorId)
                )
            )
        }
        slotEl.appendChild(rowEl)

        if (dot.retryAriaLabel !== null) {
            const retryEl = this.doc.createElement('button')
            retryEl.type = 'button'
            retryEl.classList.add('editor-ai-daemons-rail-retry')
            // Text glyph on purpose: the rail is Obsidian-free DOM (no
            // setIcon) and must not use innerHTML.
            retryEl.textContent = '↻'
            this.applyTooltip(retryEl, dot.retryAriaLabel)
            retryEl.addEventListener('click', () => {
                this.callbacks.onRetry(dot.editorId)
            })
            slotEl.appendChild(retryEl)
        }
        return slotEl
    }

    /**
     * The panel's own row: a HOLLOW core, never a solid one — that is the
     * whole distinction Business Rules #11 asks for at a glance, and the name
     * carries `(panel)` for everyone the shape cannot reach. It shows the
     * scorecard's verdict where an editor shows its finding count.
     */
    private renderPanelRow(
        panel: RailPanelViewModel,
        cues: RailMotionCues,
        index: number
    ): HTMLElement {
        const slotEl = this.doc.createElement('div')
        slotEl.classList.add('editor-ai-daemons-rail-slot')
        this.applyStagger(slotEl, index)

        const rowEl = this.doc.createElement('button')
        rowEl.type = 'button'
        rowEl.classList.add('editor-ai-daemons-rail-row', 'editor-ai-daemons-rail-row-panel')
        rowEl.classList.toggle('editor-ai-daemons-rail-row-settled', cues.panelSettled)
        rowEl.style.setProperty('--editor-ai-daemons-editor-color', panel.color)
        this.applyTooltip(rowEl, panel.title, panel.ariaLabel)
        rowEl.addEventListener('click', () => {
            this.callbacks.onPanelClick()
        })
        rowEl.appendChild(this.renderIndicator(panel.ring, true))
        rowEl.appendChild(this.renderName(panel.displayName))
        if (panel.badge !== null) {
            // The verdict is already in the row's accessible name.
            rowEl.appendChild(
                this.renderBadge(panel.badge, 'editor-ai-daemons-rail-verdict', cues.panelSettled)
            )
        }
        slotEl.appendChild(rowEl)
        return slotEl
    }

    /**
     * Status ring + identity core. Two nested elements on purpose: the ring
     * carries the STATE (dashed while queued, sweeping while busy, solid once
     * done, error/muted colours when it ended badly) and the core carries the
     * IDENTITY (filled for an editor, hollow for a panel), so a busy panel
     * cannot end up looking like a busy editor.
     *
     * `aria-hidden`: everything it says is already in the row's accessible
     * name, and an unnamed decorative span would otherwise be announced.
     */
    private renderIndicator(ring: RailRingKind, hollow: boolean): HTMLElement {
        const ringEl = this.doc.createElement('span')
        ringEl.classList.add('editor-ai-daemons-rail-ring', `editor-ai-daemons-rail-ring-${ring}`)
        ringEl.setAttribute('aria-hidden', 'true')
        const coreEl = this.doc.createElement('span')
        coreEl.classList.add('editor-ai-daemons-rail-core')
        if (hollow) {
            coreEl.classList.add('editor-ai-daemons-rail-core-hollow')
        }
        ringEl.appendChild(coreEl)
        return ringEl
    }

    private renderName(text: string): HTMLElement {
        const nameEl = this.doc.createElement('span')
        nameEl.classList.add('editor-ai-daemons-rail-name')
        nameEl.textContent = text
        return nameEl
    }

    /** A count or verdict pill; `bump` plays the change animation once. */
    private renderBadge(text: string, cls: string, bump: boolean): HTMLElement {
        const badgeEl = this.doc.createElement('span')
        badgeEl.classList.add('editor-ai-daemons-rail-badge', cls)
        badgeEl.classList.toggle('editor-ai-daemons-rail-badge-bump', bump)
        badgeEl.textContent = text
        badgeEl.setAttribute('aria-hidden', 'true')
        return badgeEl
    }

    /**
     * Per-row entrance delay. A custom property rather than a class per index:
     * the rail has no fixed number of rows, and `animation-delay` is read from
     * it in the stylesheet only while the list carries the enter class.
     */
    private applyStagger(el: HTMLElement, index: number): void {
        el.style.setProperty('--editor-ai-daemons-rail-index', String(index))
    }
}
