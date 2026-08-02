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
 * RECONCILED, never rebuilt. The rail re-renders on every streamed finding
 * (`ReviewController.scheduleRefresh` coalesces to one macrotask, and the
 * finding store notifies per finding), so a `replaceChildren()` render would
 * destroy, dozens of times a second: the element holding keyboard focus, the
 * `infinite` busy-ring sweep, and every one-shot cue `railMotion` emits. So
 * every element here OUTLIVES the render that created it — the head, the list,
 * and one row per editor keyed by id — and a render patches text, classes and
 * custom properties on the survivors. Nodes are only created, removed or moved
 * when the set of rows actually changes, and that path saves and restores
 * focus around the move.
 *
 * The one-shot cues follow from that: a class added on the cue render and
 * removed on the next one would abort the animation ~60ms in. They are added
 * on the cue and removed on their own `animationend` instead, which also keeps
 * them CSS-driven — i.e. still covered by the blanket `prefers-reduced-motion`
 * block, which a WAAPI animation would have escaped.
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

import { buildRailViewModel, railAnnouncement, railMotion } from './rail-model'
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
    /**
     * Collapse/expand the rail (issue #28). Global, persisted like a setting
     * (`behavior.railCollapsed`); the chevron in the head is the control.
     */
    readonly onToggleCollapsed: () => void
    /**
     * Show/hide the note's findings (issue #29): decorations off, daemon
     * paused for the note. Per note, session-only.
     */
    readonly onToggleFindings: () => void
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

/** The key of the panel's own row. Distinct prefix from every editor key. */
const PANEL_KEY = 'panel:'

/** The key of one editor's row. */
function editorKey(editorId: string): string {
    return `editor:${editorId}`
}

/**
 * One row's render inputs, whether it came from an editor or from the panel.
 * Both are reconciled by the same code; the differences that cannot change
 * over a row's life (which callback it fires, whether its core is hollow) are
 * decided once, at creation.
 */
interface RailRowSpec {
    readonly key: string
    /** Null for the panel row — that is also what selects the callback. */
    readonly editorId: string | null
    readonly color: string
    readonly ring: RailRingKind
    readonly displayName: string
    readonly title: string
    readonly ariaLabel: string
    readonly badge: string | null
    /** Modifier class on the badge: a count pill or a verdict pill. */
    readonly badgeClass: string
    readonly retryLabel: string | null
    /** One-shot cue: this row just reached a terminal status. */
    readonly settled: boolean
    /** One-shot cue: this row's count badge changed value. */
    readonly bumped: boolean
}

/**
 * The elements of one row, plus what was last written into them — so a render
 * that changes nothing touches no attribute (and, in particular, does not
 * re-register a native tooltip on every streamed finding).
 */
interface RailRowEls {
    readonly slotEl: HTMLElement
    readonly rowEl: HTMLButtonElement
    readonly ringEl: HTMLElement
    readonly nameEl: HTMLElement
    badgeEl: HTMLElement | null
    retryEl: HTMLButtonElement | null
    ring: RailRingKind | null
    color: string
    displayName: string
    title: string
    ariaLabel: string
    badge: string | null
    retryLabel: string | null
}

export class PersonaRail {
    private readonly doc: Document
    private readonly rootEl: HTMLElement
    /**
     * Visually-hidden live region, created once and never inside anything a
     * render replaces. Progress on the rail is otherwise pull-only, which is
     * useless during exactly the period a screen-reader user cannot see it.
     */
    private readonly statusEl: HTMLElement
    private readonly daemonEl: HTMLButtonElement
    private readonly daemonGlyphEl: HTMLElement
    private readonly daemonLabelEl: HTMLElement
    private readonly buttonEl: HTMLButtonElement
    private readonly listEl: HTMLElement
    /** The panel bracket and its member container, created on first need. */
    private groupEl: HTMLElement | null = null
    private membersEl: HTMLElement | null = null
    /** Live rows by key. Entries outlive renders; that is the whole point. */
    private readonly rows = new Map<string, RailRowEls>()
    /** Which rows exist, in which order, and how they nest. */
    private structure = ''
    private announcement = ''
    private daemonGlyph = ''
    private daemonLabel = ''
    private daemonTooltip = ''
    private daemonAriaLabel = ''
    private buttonLabel = ''
    private buttonTooltip = ''
    private buttonAriaLabel = ''
    private buttonAction: RailViewModel['button']['action'] = 'review'
    private readonly collapseEl: HTMLButtonElement
    private readonly countEl: HTMLElement
    private readonly findingsEl: HTMLButtonElement
    private collapsedGlyph = ''
    private countText = ''
    private findingsGlyph = ''
    private findingsTooltip = ''
    /**
     * What the previous render showed, so `railMotion` can tell a new run from
     * the dozens of re-renders inside one.
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

        this.statusEl = this.doc.createElement('div')
        this.statusEl.classList.add('editor-ai-daemons-rail-status')
        this.statusEl.setAttribute('role', 'status')
        this.statusEl.setAttribute('aria-live', 'polite')
        this.statusEl.setAttribute('aria-atomic', 'true')
        this.rootEl.appendChild(this.statusEl)

        /*
         * The rail's head: the daemon toggle, then the Review/Cancel button.
         *
         * Order is Sébastien's: the mode you are in is context for the button
         * underneath it, not a footnote after the editors. The hierarchy is
         * carried by weight instead — Review is the filled primary control,
         * the toggle is a quiet status light you can press. The toggle is
         * present in BOTH states; a control that only appeared once daemon
         * mode was on could never be the thing that turns it on.
         */
        const headEl = this.doc.createElement('div')
        headEl.classList.add('editor-ai-daemons-rail-head')

        this.daemonEl = this.doc.createElement('button')
        this.daemonEl.classList.add('editor-ai-daemons-rail-daemon')
        this.daemonEl.type = 'button'
        this.daemonGlyphEl = this.doc.createElement('span')
        this.daemonGlyphEl.classList.add('editor-ai-daemons-rail-daemon-glyph')
        this.daemonLabelEl = this.doc.createElement('span')
        this.daemonLabelEl.classList.add('editor-ai-daemons-rail-daemon-label')
        this.daemonEl.appendChild(this.daemonGlyphEl)
        this.daemonEl.appendChild(this.daemonLabelEl)
        this.daemonEl.addEventListener('click', () => {
            this.callbacks.onToggleDaemon()
        })
        headEl.appendChild(this.daemonEl)

        this.buttonEl = this.doc.createElement('button')
        this.buttonEl.classList.add('editor-ai-daemons-rail-button')
        this.buttonEl.type = 'button'
        this.buttonEl.addEventListener('click', () => {
            // Read the action LIVE: the same element is Review and Cancel
            // across a run, so a captured value would fire the stale intent.
            if (this.buttonAction === 'cancel') {
                this.callbacks.onCancel()
            } else {
                this.callbacks.onReview()
            }
        })
        headEl.appendChild(this.buttonEl)

        // Findings visibility toggle (issue #29): filled = shown, hollow =
        // hidden — the daemon toggle's convention. Always present, like the
        // daemon toggle: a control that only appeared once something was
        // hidden could never be the thing that hides it.
        this.findingsEl = this.doc.createElement('button')
        this.findingsEl.classList.add('editor-ai-daemons-rail-findings-toggle')
        this.findingsEl.type = 'button'
        this.findingsEl.addEventListener('click', () => {
            this.callbacks.onToggleFindings()
        })
        headEl.appendChild(this.findingsEl)

        // Collapsed finding count (issue #28): the one number that makes a
        // user expand again. Hidden unless collapsed with findings.
        this.countEl = this.doc.createElement('span')
        this.countEl.classList.add(
            'editor-ai-daemons-rail-collapsed-count',
            'editor-ai-daemons-hidden'
        )
        headEl.appendChild(this.countEl)

        // Collapse/expand chevron (issue #28): always visible, so a lone
        // daemon toggle still hints that a rail is folded behind it.
        this.collapseEl = this.doc.createElement('button')
        this.collapseEl.classList.add('editor-ai-daemons-rail-collapse')
        this.collapseEl.type = 'button'
        this.collapseEl.addEventListener('click', () => {
            this.callbacks.onToggleCollapsed()
        })
        headEl.appendChild(this.collapseEl)
        this.rootEl.appendChild(headEl)

        this.listEl = this.doc.createElement('div')
        this.listEl.classList.add('editor-ai-daemons-rail-list')
        this.listEl.setAttribute('role', 'group')
        this.listEl.setAttribute('aria-label', 'Editors')
        this.rootEl.appendChild(this.listEl)

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

    /** Reconciles the rail DOM against the given state (idempotent, cheap). */
    render(state: RailState): void {
        const viewModel = buildRailViewModel(state)
        const { state: nextMotion, cues } = railMotion(this.motion, viewModel)
        this.motion = nextMotion
        // Narrow pane: denser, NOT icon-only (plan M4 adaptive layout, revised
        // 2026-08-01 — the names are the point of the rail).
        this.rootEl.classList.toggle('editor-ai-daemons-rail-compact', viewModel.compact)
        // Idle fade (issue #33): the rail floats over the note text, so when
        // it is neither hovered/focused nor actively REPORTING it dims (CSS
        // :hover/:focus-within lift it back — visual treatment only, hit
        // targets and the a11y tree untouched). "Reporting" = a run in
        // flight (the button offers Cancel), any editor working, or a daemon
        // refresh armed (the pulsing toggle is a countdown the user may be
        // watching). A daemon that is merely ON breathes but does not block
        // the fade — it would otherwise never fade for daemon users.
        const busy =
            viewModel.button.action === 'cancel' ||
            viewModel.daemon.armed ||
            viewModel.dots.some(
                (dot) =>
                    dot.status === 'pending' ||
                    dot.status === 'running' ||
                    dot.status === 'transforming'
            )
        this.rootEl.classList.toggle('is-busy', busy)
        // Collapse (issue #28): CSS hides the list and the Review button off
        // this class; Cancel stays visible while a run is in flight (a
        // collapsed rail with no visible cancel is the one unacceptable
        // shape), and the daemon toggle survives by construction.
        this.rootEl.classList.toggle('is-collapsed', viewModel.collapsed)
        this.syncCollapse(viewModel)
        this.syncFindingsToggle(viewModel)
        this.syncHead(viewModel)

        // A panel run renders as ONE entity: a ringed row owning its members
        // (Business Rules #11). Editors that are not members of it keep their
        // place outside the group — they are still their own editors.
        const panel = viewModel.panel
        const panelSpec = panel === null ? null : this.panelSpec(panel, cues)
        const members =
            panel === null
                ? []
                : viewModel.dots
                      .filter((dot) => dot.member)
                      .map((dot) => this.editorSpec(dot, cues))
        const loose = viewModel.dots
            .filter((dot) => panel === null || !dot.member)
            .map((dot) => this.editorSpec(dot, cues))
        const ordered = [...(panelSpec === null ? [] : [panelSpec]), ...members, ...loose]

        // Patch (or create) every row BEFORE deciding whether the structure
        // has to move: a row that only changed its badge must not be touched
        // structurally at all.
        ordered.forEach((spec, index) => {
            this.syncRow(spec, index)
        })
        for (const [key, els] of [...this.rows]) {
            if (!ordered.some((spec) => spec.key === key)) {
                els.slotEl.remove()
                this.rows.delete(key)
            }
        }
        const structure = `${members.length}|${ordered.map((spec) => spec.key).join(',')}`
        if (structure !== this.structure) {
            this.structure = structure
            this.assemble(panelSpec, members, loose)
        }
        if (this.groupEl !== null && panel !== null) {
            this.groupEl.setAttribute('aria-label', panel.groupLabel)
        }
        // Cues LAST: re-inserting an element cancels its animations, so a cue
        // played before an `assemble()` would be thrown away by it.
        this.playCues(ordered, cues)
        this.announce(viewModel, cues)
    }

    /** Removes the rail from the DOM. The instance must not be reused. */
    destroy(): void {
        this.rootEl.remove()
    }

    /** Patches the findings-visibility toggle in place (issue #29). */
    private syncFindingsToggle(viewModel: RailViewModel): void {
        const toggle = viewModel.findingsToggle
        if (this.findingsGlyph !== toggle.text) {
            this.findingsEl.textContent = toggle.text
            this.findingsGlyph = toggle.text
        }
        this.findingsEl.setAttribute('aria-pressed', String(toggle.hidden))
        this.findingsEl.classList.toggle('is-findings-hidden', toggle.hidden)
        if (this.findingsTooltip !== toggle.tooltip) {
            this.applyTooltip(this.findingsEl, toggle.tooltip, toggle.ariaLabel)
            this.findingsTooltip = toggle.tooltip
        }
    }

    /** Patches the chevron + collapsed count in place (issue #28). */
    private syncCollapse(viewModel: RailViewModel): void {
        const glyph = viewModel.collapsed ? '▸' : '▾'
        if (this.collapsedGlyph !== glyph) {
            this.collapseEl.textContent = glyph
            this.collapsedGlyph = glyph
        }
        this.collapseEl.setAttribute('aria-expanded', String(!viewModel.collapsed))
        const label = viewModel.collapsed ? 'Expand the review rail' : 'Collapse the review rail'
        if (this.collapseEl.getAttribute('aria-label') !== label) {
            this.applyTooltip(this.collapseEl, label)
        }
        const count =
            viewModel.collapsed && viewModel.totalFindings > 0
                ? String(viewModel.totalFindings)
                : ''
        if (this.countText !== count) {
            this.countEl.textContent = count
            this.countEl.classList.toggle('editor-ai-daemons-hidden', count.length === 0)
            if (count.length > 0) {
                const findings = viewModel.totalFindings === 1 ? 'finding' : 'findings'
                this.applyTooltip(
                    this.countEl,
                    `${String(viewModel.totalFindings)} ${findings} — expand the rail to see them`
                )
            }
            this.countText = count
        }
    }

    /** Patches the head in place, so focus on either control survives. */
    private syncHead(viewModel: RailViewModel): void {
        const daemon = viewModel.daemon
        if (this.daemonGlyph !== daemon.text) {
            this.daemonGlyphEl.textContent = daemon.text
            this.daemonGlyph = daemon.text
        }
        // The word is dropped in a narrow pane, not the control: the span
        // stays and hides, so the toggle is one element for its whole life.
        const label = daemon.label ?? ''
        if (this.daemonLabel !== label) {
            this.daemonLabelEl.textContent = label
            this.daemonLabelEl.classList.toggle('editor-ai-daemons-hidden', label.length === 0)
            this.daemonLabel = label
        }
        this.daemonEl.setAttribute('aria-pressed', String(daemon.enabled))
        this.daemonEl.classList.toggle('editor-ai-daemons-rail-daemon-on', daemon.enabled)
        this.daemonEl.classList.toggle('editor-ai-daemons-rail-daemon-armed', daemon.armed)
        // The visible word is "Daemon" and the accessible name starts with it
        // ("Daemon mode off"), so naming the control does not hide its label
        // from anyone driving it by voice (WCAG 2.5.3).
        if (this.daemonTooltip !== daemon.tooltip || this.daemonAriaLabel !== daemon.ariaLabel) {
            this.applyTooltip(this.daemonEl, daemon.tooltip, daemon.ariaLabel)
            this.daemonTooltip = daemon.tooltip
            this.daemonAriaLabel = daemon.ariaLabel
        }

        const button = viewModel.button
        this.buttonAction = button.action
        if (this.buttonLabel !== button.label) {
            this.buttonEl.textContent = button.label
            this.buttonLabel = button.label
        }
        this.buttonEl.classList.toggle(
            'editor-ai-daemons-rail-button-cancel',
            button.action === 'cancel'
        )
        // The label is the accessible name in both layouts; only the
        // narrow-pane guidance rides the tooltip.
        if (this.buttonTooltip !== button.tooltip || this.buttonAriaLabel !== button.ariaLabel) {
            this.applyTooltip(this.buttonEl, button.tooltip, button.ariaLabel)
            this.buttonTooltip = button.tooltip
            this.buttonAriaLabel = button.ariaLabel
        }
        this.buttonEl.disabled = button.disabled
    }

    private editorSpec(dot: RailDotViewModel, cues: RailMotionCues): RailRowSpec {
        return {
            key: editorKey(dot.editorId),
            editorId: dot.editorId,
            color: dot.color,
            ring: dot.ring,
            displayName: dot.displayName,
            title: dot.title,
            ariaLabel: dot.ariaLabel,
            badge: dot.badge,
            badgeClass: 'editor-ai-daemons-rail-count',
            retryLabel: dot.retryAriaLabel,
            settled: cues.settled.includes(dot.editorId),
            bumped: cues.bumped.includes(dot.editorId)
        }
    }

    /**
     * The panel's own row: a HOLLOW core, never a solid one — that is the
     * whole distinction Business Rules #11 asks for at a glance, and the name
     * carries `(panel)` for everyone the shape cannot reach. It shows the
     * scorecard's verdict where an editor shows its finding count.
     *
     * It never BUMPS that verdict: the pill only exists once the scorecard is
     * terminal, so its first render would always be a bump — and a row
     * appearing with its value is what `railMotion`'s own rules exclude. The
     * settle wash carries the event, once.
     */
    private panelSpec(panel: RailPanelViewModel, cues: RailMotionCues): RailRowSpec {
        return {
            key: PANEL_KEY,
            editorId: null,
            color: panel.color,
            ring: panel.ring,
            displayName: panel.displayName,
            title: panel.title,
            ariaLabel: panel.ariaLabel,
            badge: panel.badge,
            badgeClass: 'editor-ai-daemons-rail-verdict',
            retryLabel: null,
            settled: cues.panelSettled,
            bumped: false
        }
    }

    /** Creates the row if it is new, then writes only what actually changed. */
    private syncRow(spec: RailRowSpec, index: number): void {
        let els = this.rows.get(spec.key)
        if (els === undefined) {
            els = this.createRow(spec)
            this.rows.set(spec.key, els)
        }
        // Per-row entrance delay. A custom property rather than a class per
        // index: the rail has no fixed number of rows.
        els.slotEl.style.setProperty('--editor-ai-daemons-rail-index', String(index))
        if (els.color !== spec.color) {
            els.rowEl.style.setProperty('--editor-ai-daemons-editor-color', spec.color)
            els.color = spec.color
        }
        if (els.ring !== spec.ring) {
            // Only on a real change: re-adding `-ring-busy` would restart the
            // sweep from 0deg on every streamed finding.
            if (els.ring !== null) {
                els.ringEl.classList.remove(`editor-ai-daemons-rail-ring-${els.ring}`)
            }
            els.ringEl.classList.add(`editor-ai-daemons-rail-ring-${spec.ring}`)
            els.ring = spec.ring
        }
        if (els.displayName !== spec.displayName) {
            els.nameEl.textContent = spec.displayName
            els.displayName = spec.displayName
        }
        if (els.title !== spec.title || els.ariaLabel !== spec.ariaLabel) {
            this.applyTooltip(els.rowEl, spec.title, spec.ariaLabel)
            els.title = spec.title
            els.ariaLabel = spec.ariaLabel
        }
        this.syncBadge(els, spec)
        this.syncRetry(els, spec)
    }

    /** A count or verdict pill. The value is already in the row's name. */
    private syncBadge(els: RailRowEls, spec: RailRowSpec): void {
        if (spec.badge === null) {
            els.badgeEl?.remove()
            els.badgeEl = null
            els.badge = null
            return
        }
        if (els.badgeEl === null) {
            const badgeEl = this.doc.createElement('span')
            badgeEl.classList.add('editor-ai-daemons-rail-badge', spec.badgeClass)
            badgeEl.setAttribute('aria-hidden', 'true')
            els.rowEl.appendChild(badgeEl)
            els.badgeEl = badgeEl
        }
        if (els.badge !== spec.badge) {
            els.badgeEl.textContent = spec.badge
            els.badge = spec.badge
        }
    }

    /**
     * The retry icon-button, present only while the editor's attempt failed
     * or was cancelled. A sibling of the row button, not a child — nesting an
     * interactive element inside another is invalid and unreachable by
     * keyboard.
     */
    private syncRetry(els: RailRowEls, spec: RailRowSpec): void {
        if (spec.retryLabel === null) {
            els.retryEl?.remove()
            els.retryEl = null
            els.retryLabel = null
            return
        }
        if (els.retryEl === null) {
            const retryEl = this.doc.createElement('button')
            retryEl.type = 'button'
            retryEl.classList.add('editor-ai-daemons-rail-retry')
            // Text glyph on purpose: the rail is Obsidian-free DOM (no
            // setIcon) and must not use innerHTML.
            retryEl.textContent = '↻'
            const editorId = spec.editorId
            retryEl.addEventListener('click', () => {
                if (editorId !== null) {
                    this.callbacks.onRetry(editorId)
                }
            })
            els.slotEl.appendChild(retryEl)
            els.retryEl = retryEl
        }
        if (els.retryLabel !== spec.retryLabel) {
            this.applyTooltip(els.retryEl, spec.retryLabel)
            els.retryLabel = spec.retryLabel
        }
    }

    /**
     * One row's elements. Everything decided here is fixed for the row's
     * life: which callback it fires, and whether its identity core is hollow.
     *
     * Status ring + identity core are two nested elements on purpose: the
     * ring carries the STATE (dashed while queued, sweeping while busy, solid
     * once done, error/muted colours when it ended badly) and the core
     * carries the IDENTITY (filled for an editor, hollow for a panel), so a
     * busy panel cannot end up looking like a busy editor. Both are
     * `aria-hidden`: everything they say is already in the row's accessible
     * name, and an unnamed decorative span would otherwise be announced.
     */
    private createRow(spec: RailRowSpec): RailRowEls {
        const slotEl = this.doc.createElement('div')
        slotEl.classList.add('editor-ai-daemons-rail-slot')

        const rowEl = this.doc.createElement('button')
        rowEl.type = 'button'
        rowEl.classList.add('editor-ai-daemons-rail-row')

        const ringEl = this.doc.createElement('span')
        ringEl.classList.add('editor-ai-daemons-rail-ring')
        ringEl.setAttribute('aria-hidden', 'true')
        const coreEl = this.doc.createElement('span')
        coreEl.classList.add('editor-ai-daemons-rail-core')
        ringEl.appendChild(coreEl)

        const nameEl = this.doc.createElement('span')
        nameEl.classList.add('editor-ai-daemons-rail-name')

        const editorId = spec.editorId
        if (editorId === null) {
            rowEl.classList.add('editor-ai-daemons-rail-row-panel')
            coreEl.classList.add('editor-ai-daemons-rail-core-hollow')
            rowEl.addEventListener('click', () => {
                this.callbacks.onPanelClick()
            })
        } else {
            rowEl.dataset['editorId'] = editorId
            rowEl.addEventListener('click', () => {
                this.callbacks.onEditorClick(editorId)
            })
        }
        rowEl.appendChild(ringEl)
        rowEl.appendChild(nameEl)
        slotEl.appendChild(rowEl)
        return {
            slotEl,
            rowEl,
            ringEl,
            nameEl,
            badgeEl: null,
            retryEl: null,
            ring: null,
            color: '',
            displayName: '',
            title: '',
            ariaLabel: '',
            badge: null,
            retryLabel: null
        }
    }

    /**
     * Re-nests the surviving rows after the set (or the grouping) changed.
     *
     * This is the one path that moves nodes, and moving a node detaches it —
     * which blurs it. So the focused row/control is remembered by KEY and
     * refocused afterwards: without that, adding an editor mid-run would drop
     * a keyboard user back at the top of the document.
     */
    private assemble(
        panel: RailRowSpec | null,
        members: readonly RailRowSpec[],
        loose: readonly RailRowSpec[]
    ): void {
        const focusKey = this.focusedKey()
        this.listEl.replaceChildren()
        if (panel !== null) {
            const groupEl = this.groupEl ?? this.doc.createElement('div')
            if (this.groupEl === null) {
                groupEl.classList.add('editor-ai-daemons-rail-group')
                groupEl.setAttribute('role', 'group')
                this.groupEl = groupEl
            }
            const membersEl = this.membersEl ?? this.doc.createElement('div')
            if (this.membersEl === null) {
                membersEl.classList.add('editor-ai-daemons-rail-members')
                this.membersEl = membersEl
            }
            groupEl.replaceChildren()
            membersEl.replaceChildren()
            this.appendRow(groupEl, panel)
            for (const spec of members) {
                this.appendRow(membersEl, spec)
            }
            groupEl.appendChild(membersEl)
            this.listEl.appendChild(groupEl)
        }
        for (const spec of loose) {
            this.appendRow(this.listEl, spec)
        }
        this.restoreFocus(focusKey)
    }

    private appendRow(parentEl: HTMLElement, spec: RailRowSpec): void {
        const els = this.rows.get(spec.key)
        if (els !== undefined) {
            parentEl.appendChild(els.slotEl)
        }
    }

    /**
     * A stable identity for whatever the rail currently owns focus on, or
     * null when focus is elsewhere. Compared by element identity rather than
     * by `instanceof`, so it works in any document — including the stub one
     * the spec drives.
     */
    private focusedKey(): string | null {
        const active: unknown = this.doc.activeElement
        if (active === null) {
            return null
        }
        if (active === this.daemonEl) {
            return 'daemon'
        }
        if (active === this.buttonEl) {
            return 'button'
        }
        for (const [key, els] of this.rows) {
            if (active === els.rowEl) {
                return `row:${key}`
            }
            if (els.retryEl !== null && active === els.retryEl) {
                return `retry:${key}`
            }
        }
        return null
    }

    private restoreFocus(focusKey: string | null): void {
        if (focusKey === null) {
            return
        }
        // `preventScroll`: the rail floats over the note, and re-focusing a
        // row must never scroll the document under it.
        if (focusKey === 'daemon') {
            this.daemonEl.focus({ preventScroll: true })
            return
        }
        if (focusKey === 'button') {
            this.buttonEl.focus({ preventScroll: true })
            return
        }
        const separator = focusKey.indexOf(':')
        const role = focusKey.slice(0, separator)
        const els = this.rows.get(focusKey.slice(separator + 1))
        if (els === undefined) {
            return
        }
        if (role === 'row') {
            els.rowEl.focus({ preventScroll: true })
        } else {
            els.retryEl?.focus({ preventScroll: true })
        }
    }

    private playCues(ordered: readonly RailRowSpec[], cues: RailMotionCues): void {
        for (const spec of ordered) {
            const els = this.rows.get(spec.key)
            if (els === undefined) {
                continue
            }
            // A new run: the rows animate in, staggered. Not on every render —
            // the rail re-renders on every streamed finding (see `railMotion`,
            // which also suppresses the per-row cues while this one plays).
            if (cues.stagger) {
                this.playOnce(els.slotEl, 'editor-ai-daemons-rail-slot-enter')
            }
            if (spec.settled) {
                this.playOnce(els.rowEl, 'editor-ai-daemons-rail-row-settled')
            }
            if (spec.bumped && els.badgeEl !== null) {
                this.playOnce(els.badgeEl, 'editor-ai-daemons-rail-badge-bump')
            }
        }
    }

    /**
     * Plays a one-shot animation class on an element that SURVIVES renders.
     *
     * The class is removed when the animation ends, not on the next render —
     * a render removing it would abort the animation dozens of milliseconds
     * in, which is how "one soft wash, once" turns into a flicker. Staying
     * class-driven also keeps the animation inside the blanket
     * `prefers-reduced-motion` block; a WAAPI animation would escape it.
     *
     * Re-triggering while the previous play is still running restarts it (the
     * remove/reflow/add dance) but does not stack a second listener.
     */
    private playOnce(el: HTMLElement, cls: string): void {
        const replaying = el.classList.contains(cls)
        el.classList.remove(cls)
        // Flush the removal, so re-adding the class restarts the animation
        // instead of being coalesced into no change at all.
        el.getBoundingClientRect()
        el.classList.add(cls)
        if (replaying) {
            return
        }
        const clear = (event: Event): void => {
            // Animations on descendants bubble here too; only ours ends this.
            if (event.target !== el) {
                return
            }
            el.classList.remove(cls)
            el.removeEventListener('animationend', clear)
        }
        el.addEventListener('animationend', clear)
    }

    private announce(viewModel: RailViewModel, cues: RailMotionCues): void {
        const message = railAnnouncement(viewModel, cues)
        if (message === null || message === this.announcement) {
            return
        }
        this.announcement = message
        this.statusEl.textContent = message
    }
}
