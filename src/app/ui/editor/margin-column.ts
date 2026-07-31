import { marginCardStatusText, marginModelKey, marginRenderedCards } from './margin-model'
import type { MarginCardView, MarginColumnModel, MarginGroupView } from './margin-model'
import type { MarginSlotInput, MarginSlotPosition } from './margin-layout'

/**
 * The margin comment column: durable comments rendered next to the lines they
 * were parked on (plan §5.5 / M8, slice 3).
 *
 * Same construction rules as the persona rail (`rail.ts`), for the same
 * reasons:
 * - **Not a CM6 gutter.** Gutters are left-side, line-oriented strips inside
 *   the scroller; this is a right-hand column of prose cards that has to
 *   coexist with Obsidian's own gutters rather than compete for their slot.
 *   It is a plain positioned element owned by the hosting view.
 * - **Popout-safe.** Every element comes from the `Document` handed in at
 *   construction — never a captured global `document`.
 * - **Obsidian-free.** No `setIcon`, no `innerHTML`; glyphs are text. All
 *   display logic lives in `margin-model.ts`, all geometry in
 *   `margin-layout.ts`.
 *
 * ## Render, measure, position — three steps on purpose
 *
 * A card's height is not knowable until it is rendered, and its position
 * depends on every other card's height. So the host drives three phases:
 * {@link render} builds the DOM, {@link measure} reports the heights, and
 * {@link applyPositions} places the groups from the layout the pure stacker
 * computed. Scrolling only ever runs the third phase — rebuilding the column
 * on every scroll frame would throw away focus, collapse expanded bodies and
 * flicker. {@link render} itself is a no-op when the model has not changed.
 */

export interface MarginColumnCallbacks {
    /** Scroll to (and briefly select) the comment's span. */
    readonly onReveal: (commentId: string) => void
    /** Re-ask an interrupted or failed comment. Never a resumption. */
    readonly onRetry: (commentId: string) => void
    /** Abort an in-flight job. */
    readonly onCancel: (commentId: string) => void
    /** Close the comment, keeping the record. */
    readonly onResolve: (commentId: string) => void
    /** Remove the comment from the store for good. */
    readonly onDelete: (commentId: string) => void
    /** Expand/collapse one card's answer. */
    readonly onToggleBody: (commentId: string) => void
    /** Expand/collapse a line's "N comments" chip. */
    readonly onToggleGroup: (key: string) => void
    /** Expand/collapse the orphan group. */
    readonly onToggleOrphans: () => void
}

/** Same tooltip seam as the rail: Obsidian `setTooltip`, or the `title` attribute. */
export type MarginTooltipSetter = (el: HTMLElement, tooltip: string) => void

export class MarginColumn {
    private readonly doc: Document
    private readonly rootEl: HTMLElement
    private readonly orphansEl: HTMLElement
    private readonly groupsEl: HTMLElement
    private readonly groupEls = new Map<string, HTMLElement>()
    /** Per-card handles for the ONE thing that changes without a rebuild. */
    private readonly cardEls = new Map<string, HTMLElement>()
    private readonly statusEls = new Map<string, HTMLElement>()
    private groupOrder: readonly MarginGroupView[] = []
    private renderedKey = ''

    constructor(
        containerEl: HTMLElement,
        private readonly callbacks: MarginColumnCallbacks,
        doc?: Document,
        private readonly tooltipSetter?: MarginTooltipSetter
    ) {
        this.doc = doc ?? containerEl.ownerDocument
        this.rootEl = this.doc.createElement('div')
        this.rootEl.classList.add('editor-ai-daemons-margin')
        this.rootEl.setAttribute('role', 'complementary')
        this.rootEl.setAttribute('aria-label', 'Margin comments')
        // Orphans are pinned at the top of the column; anchored groups are
        // positioned individually against the lines they belong to.
        this.orphansEl = this.doc.createElement('div')
        this.orphansEl.classList.add('editor-ai-daemons-margin-orphans')
        this.groupsEl = this.doc.createElement('div')
        this.groupsEl.classList.add('editor-ai-daemons-margin-groups')
        this.rootEl.appendChild(this.orphansEl)
        this.rootEl.appendChild(this.groupsEl)
        containerEl.appendChild(this.rootEl)
    }

    /** Column width in px, applied as a custom property. */
    setWidth(width: number): void {
        this.rootEl.style.setProperty('--editor-ai-daemons-margin-width', `${width}px`)
    }

    /** Shows or hides the whole column without destroying it. */
    setVisible(visible: boolean): void {
        this.rootEl.classList.toggle('editor-ai-daemons-hidden', !visible)
    }

    /**
     * Rebuilds the column DOM — but only when the model actually changed.
     * Returns true when a rebuild happened, so the host knows the measured
     * heights are stale.
     */
    render(model: MarginColumnModel): boolean {
        const key = marginModelKey(model)
        if (key === this.renderedKey) {
            // The elapsed timers still move — once a second, for as long as a
            // job runs. Writing them in place is the whole reason `timer` is
            // out of the key: rebuilding here would take the keyboard user's
            // focus off whatever they were on, every second.
            this.syncLiveText(model)
            return false
        }
        this.renderedKey = key
        this.groupEls.clear()
        this.cardEls.clear()
        this.statusEls.clear()
        this.orphansEl.replaceChildren()
        this.groupsEl.replaceChildren()
        this.groupOrder = model.groups

        if (model.orphans !== null) {
            const orphans = model.orphans
            const box = this.doc.createElement('div')
            box.classList.add('editor-ai-daemons-margin-orphan-box')
            const toggle = this.doc.createElement('button')
            toggle.classList.add('editor-ai-daemons-margin-orphan-toggle')
            toggle.type = 'button'
            // Text glyph, not an icon font: this file is Obsidian-free DOM.
            toggle.textContent = `${orphans.expanded ? '▾' : '▸'} ${orphans.heading}`
            toggle.setAttribute('aria-expanded', String(orphans.expanded))
            this.applyTooltip(
                toggle,
                'These comments no longer point anywhere in the note. Expand to see what they asked about.',
                orphans.heading
            )
            toggle.addEventListener('click', () => {
                this.callbacks.onToggleOrphans()
            })
            box.appendChild(toggle)
            for (const card of orphans.cards) {
                box.appendChild(this.renderCard(card))
            }
            this.orphansEl.appendChild(box)
        }

        for (const group of model.groups) {
            const groupEl = this.doc.createElement('div')
            groupEl.classList.add('editor-ai-daemons-margin-group')
            groupEl.dataset['groupKey'] = group.key
            if (group.collapsed && group.chipLabel !== null) {
                groupEl.appendChild(this.renderChip(group, group.chipLabel))
            } else {
                for (const card of group.cards) {
                    groupEl.appendChild(this.renderCard(card))
                }
            }
            this.groupEls.set(group.key, groupEl)
            this.groupsEl.appendChild(groupEl)
        }
        return true
    }

    /**
     * Heights of the rendered groups, paired with the anchor each one wants —
     * exactly the input {@link import('./margin-layout').stackMarginSlots}
     * takes. Includes only groups that are actually in the DOM.
     */
    measure(): readonly MarginSlotInput[] {
        const slots: MarginSlotInput[] = []
        for (const group of this.groupOrder) {
            const el = this.groupEls.get(group.key)
            if (el) {
                slots.push({ key: group.key, anchorTop: group.anchorTop, height: el.offsetHeight })
            }
        }
        return slots
    }

    /**
     * The box the anchored groups are positioned inside, in client
     * coordinates. The host converts CodeMirror's document coordinates into
     * this box's space, so the two never have to agree on anything else.
     */
    groupsBox(): { readonly top: number; readonly height: number } {
        const rect = this.groupsEl.getBoundingClientRect()
        return { top: rect.top, height: rect.height }
    }

    /** Places each group at the position the stacker computed. */
    applyPositions(positions: readonly MarginSlotPosition[]): void {
        for (const position of positions) {
            const el = this.groupEls.get(position.key)
            if (el) {
                el.style.top = `${position.top}px`
            }
        }
    }

    /** Removes the column from the DOM. The instance must not be reused. */
    destroy(): void {
        this.groupEls.clear()
        this.cardEls.clear()
        this.statusEls.clear()
        this.rootEl.remove()
    }

    // -- internals ----------------------------------------------------------

    /** Rewrites the status line and the card's announced sentence in place. */
    private syncLiveText(model: MarginColumnModel): void {
        for (const card of marginRenderedCards(model)) {
            const status = this.statusEls.get(card.commentId)
            if (status) {
                status.textContent = marginCardStatusText(card)
            }
            this.cardEls.get(card.commentId)?.setAttribute('aria-label', card.accessibleName)
        }
    }

    private applyTooltip(el: HTMLElement, tooltip: string, ariaLabel: string = tooltip): void {
        el.setAttribute('aria-label', ariaLabel)
        if (this.tooltipSetter) {
            this.tooltipSetter(el, tooltip)
        } else {
            el.title = tooltip
        }
    }

    /**
     * Tooltip without an accessible name: for controls whose VISIBLE text is
     * already their name. Overriding it with `aria-label` would break WCAG
     * 2.5.3 (label in name) and, on the reveal button, hide the question the
     * user can see behind a sentence they cannot.
     */
    private applyHint(el: HTMLElement, tooltip: string): void {
        if (this.tooltipSetter) {
            this.tooltipSetter(el, tooltip)
        } else {
            el.title = tooltip
        }
    }

    /** A line with several comments: one chip that expands to all of them. */
    private renderChip(group: MarginGroupView, label: string): HTMLElement {
        const chip = this.doc.createElement('button')
        chip.classList.add('editor-ai-daemons-margin-chip')
        chip.type = 'button'
        chip.textContent = label
        chip.setAttribute('aria-expanded', 'false')
        this.applyTooltip(chip, group.chipAccessibleName ?? label)
        chip.addEventListener('click', () => {
            this.callbacks.onToggleGroup(group.key)
        })
        return chip
    }

    private renderCard(card: MarginCardView): HTMLElement {
        const cardEl = this.doc.createElement('div')
        cardEl.classList.add('editor-ai-daemons-margin-card')
        if (card.orphaned) {
            cardEl.classList.add('editor-ai-daemons-margin-card-orphaned')
        }
        cardEl.style.setProperty('--editor-ai-daemons-editor-color', card.color)
        cardEl.dataset['commentId'] = card.commentId
        // The composed sentence belongs on the CARD, which is a `group` and can
        // therefore carry a name. It used to ride on the question element —
        // fine while that was a button, silently dropped when it was a plain
        // `div` (ARIA forbids naming `role=generic`), which is exactly the
        // orphan case: no status, no editor, no indication anything is wrong.
        cardEl.setAttribute('role', 'group')
        cardEl.setAttribute('aria-label', card.accessibleName)

        const head = this.doc.createElement('div')
        head.classList.add('editor-ai-daemons-margin-head')
        const name = this.doc.createElement('span')
        name.classList.add('editor-ai-daemons-margin-editor')
        name.textContent = card.editorName
        head.appendChild(name)
        const status = this.doc.createElement('span')
        status.classList.add('editor-ai-daemons-margin-status')
        status.textContent = marginCardStatusText(card)
        // The card's own name already announces the editor and the state.
        status.setAttribute('aria-hidden', 'true')
        head.appendChild(status)
        cardEl.appendChild(head)

        // The question is the card's primary control: keyboard-reachable, and
        // named by its own visible text. A card whose span is gone has nothing
        // to reveal, so it is plain text instead.
        if (card.actions.canReveal) {
            const reveal = this.doc.createElement('button')
            reveal.classList.add(
                'editor-ai-daemons-margin-question',
                'editor-ai-daemons-margin-reveal'
            )
            reveal.type = 'button'
            reveal.textContent = card.question
            this.applyHint(reveal, 'Go to the text this comment is about')
            reveal.addEventListener('click', () => {
                this.callbacks.onReveal(card.commentId)
            })
            cardEl.appendChild(reveal)
        } else {
            const question = this.doc.createElement('div')
            question.classList.add('editor-ai-daemons-margin-question')
            question.textContent = card.question
            cardEl.appendChild(question)
        }

        if (card.quote !== null) {
            const quote = this.doc.createElement('blockquote')
            quote.classList.add('editor-ai-daemons-margin-quote')
            quote.textContent = card.quote
            cardEl.appendChild(quote)
        }
        if (card.drifted) {
            const drift = this.doc.createElement('div')
            drift.classList.add('editor-ai-daemons-margin-drift')
            drift.textContent = 'The text has changed slightly since this was asked.'
            cardEl.appendChild(drift)
        }
        if (card.body !== null) {
            const body = this.doc.createElement('div')
            body.classList.add('editor-ai-daemons-margin-body')
            body.textContent = card.body
            cardEl.appendChild(body)
            if (card.truncated) {
                const more = this.doc.createElement('button')
                more.classList.add('editor-ai-daemons-margin-more')
                more.type = 'button'
                more.textContent = card.expanded ? 'Show less' : 'Show more'
                more.setAttribute('aria-expanded', String(card.expanded))
                this.applyTooltip(
                    more,
                    card.expanded ? 'Collapse this answer' : 'Show the whole answer',
                    `${card.expanded ? 'Show less of' : 'Show more of'} the answer from ${card.editorName}`
                )
                more.addEventListener('click', () => {
                    this.callbacks.onToggleBody(card.commentId)
                })
                cardEl.appendChild(more)
            }
        }

        const actions = this.doc.createElement('div')
        actions.classList.add('editor-ai-daemons-margin-actions')
        if (card.actions.canRetry) {
            this.addAction(actions, card, 'Retry', () => this.callbacks.onRetry(card.commentId))
        }
        if (card.actions.canCancel) {
            this.addAction(actions, card, 'Cancel', () => this.callbacks.onCancel(card.commentId))
        }
        if (card.actions.canResolve) {
            this.addAction(actions, card, 'Resolve', () => this.callbacks.onResolve(card.commentId))
        }
        if (card.actions.canDelete) {
            this.addAction(actions, card, 'Delete', () => this.callbacks.onDelete(card.commentId))
        }
        if (actions.childElementCount > 0) {
            cardEl.appendChild(actions)
        }
        this.cardEls.set(card.commentId, cardEl)
        this.statusEls.set(card.commentId, status)
        return cardEl
    }

    private addAction(
        actions: HTMLElement,
        card: MarginCardView,
        label: string,
        onClick: () => void
    ): void {
        const button = this.doc.createElement('button')
        button.classList.add('editor-ai-daemons-margin-action')
        button.type = 'button'
        button.textContent = label
        // Every card carries identically-labelled buttons; the accessible
        // name has to say which comment this one acts on (WCAG 2.4.6).
        this.applyTooltip(button, `${label} the comment asked of ${card.editorName}`)
        button.addEventListener('click', onClick)
        actions.appendChild(button)
    }
}
