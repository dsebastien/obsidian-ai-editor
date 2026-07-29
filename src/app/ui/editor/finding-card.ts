/**
 * Minimal review card — the click-a-highlight interaction.
 *
 * Clicking a finding highlight opens ONE floating card per editor view,
 * positioned near the clicked span (viewport-clamped), showing every finding
 * that covers the click position as stacked sections: editor identity
 * (color + name), severity, critique, the quoted text, a plain old/new
 * suggestion preview, Accept / Dismiss, and a disabled push-back placeholder
 * (thread wiring is a later milestone).
 *
 * Constraints honored:
 * - Pure DOM + CM6 only — no Obsidian imports. Finding data comes through an
 *   injected {@link FindingLookup} (wired by the review controller), so this
 *   module never touches the orchestration layer directly.
 * - Popout-safe: every element is created via the owning view's
 *   `ownerDocument`, and viewport clamping uses that document's window.
 * - Business Rules #2/#3: Accept is only offered when a suggestion exists and
 *   only applied when the lookup's precondition check (FindingStore) passes
 *   against the CURRENT document text; the replacement is dispatched as a
 *   regular editor transaction, so undo works naturally.
 * - Escape or click-away closes the card; any external document change closes
 *   it too (its content was resolved against the pre-change document).
 * - Listeners are registered while a card is open and torn down on close and
 *   in the view plugin's `destroy` (CM6 lifecycle).
 */

import type { EditorState, Extension } from '@codemirror/state'
import { ViewPlugin } from '@codemirror/view'
import type { EditorView, PluginValue, ViewUpdate } from '@codemirror/view'
import type { Severity } from '../../domain/operations/contract'
import { findingSpansAt, removeFindingsEffect } from './finding-decorations'

// ---------------------------------------------------------------------------
// Data contract with the review controller (injected, never imported)
// ---------------------------------------------------------------------------

/** Everything the card renders for one finding. */
export interface FindingCardData {
    readonly findingId: string
    readonly editorName: string
    /** Persona color (any CSS color value) shown as the identity dot. */
    readonly editorColor: string
    readonly severity: Severity
    readonly critique: string
    /** The text the finding is about (anchored text, falling back to quote). */
    readonly quote: string
    /** Proposed replacement, `null` when the finding has no suggestion. */
    readonly suggestion: string | null
    /**
     * Whether Accept may currently be offered: suggestion exists AND the
     * FindingStore reports the finding actionable (anchored, not stale, not
     * terminal). The accept call re-verifies before anything is applied.
     */
    readonly acceptable: boolean
}

/** Outcome of an accept attempt, resolved by the review controller. */
export type CardAcceptOutcome =
    | { readonly ok: true; readonly from: number; readonly to: number; readonly insert: string }
    | { readonly ok: false }

/**
 * Finding resolution seam injected by the review controller.
 *
 * `getCardData` returns `null` for findings that must no longer be shown
 * (unknown id, terminal status) — the card drops such sections silently.
 * `acceptFinding` MUST run the FindingStore accept path (precondition against
 * `currentText`, Business Rules #3) and, on success, mark the finding
 * accepted and return the range/replacement to dispatch. `dismissFinding`
 * marks the finding dismissed; the card removes its decoration.
 */
export interface FindingLookup {
    getCardData(findingId: string): FindingCardData | null
    acceptFinding(findingId: string, currentText: string): CardAcceptOutcome
    dismissFinding(findingId: string): void
}

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested in finding-card.spec.ts)
// ---------------------------------------------------------------------------

/** Client-coordinate rectangle of the clicked span (from `coordsAtPos`). */
export interface CardAnchorRect {
    readonly left: number
    readonly top: number
    readonly bottom: number
}

export interface CardSize {
    readonly width: number
    readonly height: number
}

/** Usable client-coordinate area the card must stay within. */
export interface CardViewport {
    readonly left: number
    readonly top: number
    readonly right: number
    readonly bottom: number
}

export interface CardPosition {
    readonly left: number
    readonly top: number
}

/** Default distance between the anchor span and the card, in pixels. */
export const CARD_GAP = 8

function clamp(value: number, min: number, max: number): number {
    return Math.min(Math.max(value, min), Math.max(min, max))
}

/**
 * Computes the card's client position: left-aligned with the anchor, below
 * it when there is room, flipped above otherwise, and clamped into the
 * viewport in both axes when neither side fully fits (the card never
 * overflows the viewport as long as it is smaller than it).
 */
export function computeCardPosition(
    anchor: CardAnchorRect,
    size: CardSize,
    viewport: CardViewport,
    gap: number = CARD_GAP
): CardPosition {
    const left = clamp(anchor.left, viewport.left, viewport.right - size.width)
    const below = anchor.bottom + gap
    const above = anchor.top - gap - size.height
    let top: number
    if (below + size.height <= viewport.bottom) {
        top = below
    } else if (above >= viewport.top) {
        top = above
    } else {
        top = clamp(below, viewport.top, viewport.bottom - size.height)
    }
    return { left, top }
}

/** One candidate span for the overlap selection (current-doc coordinates). */
export interface FindingSpanCandidate {
    readonly findingId: string
    readonly from: number
    readonly to: number
}

/**
 * Selects and orders the findings whose span covers `pos` (boundaries
 * inclusive — a click resolving to a span edge still counts). Overlapping
 * findings are stacked innermost-first (narrowest span is the most specific
 * take on the clicked text), ties broken by start position then id so the
 * section order is deterministic. Duplicate ids and empty spans are dropped.
 */
export function selectFindingsAtPos(
    candidates: readonly FindingSpanCandidate[],
    pos: number
): readonly string[] {
    const covering = candidates.filter(
        (candidate) => candidate.from < candidate.to && candidate.from <= pos && pos <= candidate.to
    )
    covering.sort((a, b) => {
        const lengthDelta = a.to - a.from - (b.to - b.from)
        if (lengthDelta !== 0) {
            return lengthDelta
        }
        if (a.from !== b.from) {
            return a.from - b.from
        }
        return a.findingId < b.findingId ? -1 : a.findingId > b.findingId ? 1 : 0
    })
    const seen = new Set<string>()
    const ids: string[] = []
    for (const candidate of covering) {
        if (!seen.has(candidate.findingId)) {
            seen.add(candidate.findingId)
            ids.push(candidate.findingId)
        }
    }
    return ids
}

// ---------------------------------------------------------------------------
// View plugin
// ---------------------------------------------------------------------------

const SEVERITY_LABELS: Readonly<Record<Severity, string>> = {
    info: 'Info',
    suggestion: 'Suggestion',
    warning: 'Warning'
}

/** Margin kept between the card and the window edges, in pixels. */
const VIEWPORT_PADDING = 8

/**
 * Creates the finding-card extension for one editor view. The lookup is
 * injected per view by the review controller; the returned extension owns
 * the card lifecycle (single active card, Escape/click-away/edit closes).
 */
export function findingCardExtension(lookup: FindingLookup): Extension {
    return ViewPlugin.define((view) => new FindingCardPlugin(view, lookup), {
        eventHandlers: {
            click(event, view) {
                return this.handleClick(event, view)
            }
        }
    })
}

class FindingCardPlugin implements PluginValue {
    private cardEl: HTMLElement | null = null
    private sectionIds: readonly string[] = []
    private anchor: CardAnchorRect = { left: 0, top: 0, bottom: 0 }

    private readonly onDocPointerDown = (event: MouseEvent): void => {
        const target = event.target
        if (this.cardEl && target instanceof Node && this.cardEl.contains(target)) {
            return
        }
        this.closeCard()
    }

    private readonly onDocKeyDown = (event: KeyboardEvent): void => {
        if (event.key !== 'Escape') {
            return
        }
        event.preventDefault()
        event.stopPropagation()
        this.closeCard()
    }

    private readonly onScroll = (): void => {
        this.closeCard()
    }

    constructor(
        private readonly view: EditorView,
        private readonly lookup: FindingLookup
    ) {}

    /**
     * CM6 content click handler. Only clicks landing on a finding highlight
     * open a card; everything else falls through to the default handling.
     * Returns true (event consumed) when a card was opened.
     */
    handleClick(event: MouseEvent, view: EditorView): boolean {
        const target = event.target
        if (!(target instanceof Element) || !target.closest('.ai-editor-finding')) {
            return false
        }
        const pos = view.posAtCoords({ x: event.clientX, y: event.clientY })
        if (pos === null) {
            return false
        }
        const ids = selectFindingsAtPos(findingSpansAt(view.state, pos), pos)
        const sections = this.resolveSections(ids)
        if (sections.length === 0) {
            return false
        }
        const rect = view.coordsAtPos(pos)
        this.openCard(
            sections,
            rect ?? { left: event.clientX, top: event.clientY, bottom: event.clientY }
        )
        return true
    }

    update(update: ViewUpdate): void {
        // Any external edit invalidates the card's content: the sections were
        // resolved against the pre-change document. Accept closes the card
        // BEFORE dispatching, so its own transaction never reaches this path
        // with an open card.
        if (update.docChanged) {
            this.closeCard()
        }
    }

    destroy(): void {
        this.closeCard()
    }

    private resolveSections(ids: readonly string[]): FindingCardData[] {
        const sections: FindingCardData[] = []
        for (const id of ids) {
            const data = this.lookup.getCardData(id)
            if (data) {
                sections.push(data)
            }
        }
        return sections
    }

    private openCard(sections: readonly FindingCardData[], anchor: CardAnchorRect): void {
        this.closeCard()
        const doc = this.view.dom.ownerDocument
        const card = doc.createElement('div')
        card.classList.add('ai-editor-finding-card')
        card.setAttribute('role', 'dialog')
        card.setAttribute(
            'aria-label',
            sections.length === 1 ? 'Review finding' : `${sections.length} review findings`
        )
        this.cardEl = card
        this.anchor = anchor
        this.renderSections(sections)
        doc.body.appendChild(card)
        this.positionCard()
        doc.addEventListener('mousedown', this.onDocPointerDown, true)
        doc.addEventListener('keydown', this.onDocKeyDown, true)
        this.view.scrollDOM.addEventListener('scroll', this.onScroll)
        // The card is position-fixed at coordinates computed once from a cached
        // anchor rect: a window/popout resize moves the anchor without moving
        // the card, which can strand it outside the viewport. Same remedy as
        // scrolling — close it.
        doc.defaultView?.addEventListener('resize', this.onScroll)
    }

    private closeCard(): void {
        const card = this.cardEl
        if (!card) {
            return
        }
        const doc = card.ownerDocument
        doc.removeEventListener('mousedown', this.onDocPointerDown, true)
        doc.removeEventListener('keydown', this.onDocKeyDown, true)
        this.view.scrollDOM.removeEventListener('scroll', this.onScroll)
        doc.defaultView?.removeEventListener('resize', this.onScroll)
        card.remove()
        this.cardEl = null
        this.sectionIds = []
    }

    /** Re-resolves the shown sections after a mutation (dismiss, failed accept). */
    private refreshCard(): void {
        if (!this.cardEl) {
            return
        }
        const sections = this.resolveSections(this.sectionIds)
        if (sections.length === 0) {
            this.closeCard()
            return
        }
        this.renderSections(sections)
        this.positionCard()
    }

    private renderSections(sections: readonly FindingCardData[]): void {
        const card = this.cardEl
        if (!card) {
            return
        }
        card.replaceChildren()
        for (const data of sections) {
            card.appendChild(this.renderSection(data))
        }
        this.sectionIds = sections.map((section) => section.findingId)
    }

    /** Positions the (already attached) card near the anchor, clamped. */
    private positionCard(): void {
        const card = this.cardEl
        if (!card) {
            return
        }
        const win = card.ownerDocument.defaultView
        if (!win) {
            return
        }
        const viewport: CardViewport = {
            left: VIEWPORT_PADDING,
            top: VIEWPORT_PADDING,
            right: win.innerWidth - VIEWPORT_PADDING,
            bottom: win.innerHeight - VIEWPORT_PADDING
        }
        const position = computeCardPosition(
            this.anchor,
            { width: card.offsetWidth, height: card.offsetHeight },
            viewport
        )
        card.style.left = `${position.left}px`
        card.style.top = `${position.top}px`
    }

    private renderSection(data: FindingCardData): HTMLElement {
        const doc = this.view.dom.ownerDocument
        const section = doc.createElement('section')
        section.classList.add('ai-editor-finding-card-section')
        section.dataset['findingId'] = data.findingId

        const header = doc.createElement('header')
        header.classList.add('ai-editor-finding-card-header')
        const dot = doc.createElement('span')
        dot.classList.add('ai-editor-finding-card-dot')
        dot.style.setProperty('--ai-editor-editor-color', data.editorColor)
        dot.setAttribute('aria-hidden', 'true')
        header.appendChild(dot)
        const name = doc.createElement('span')
        name.classList.add('ai-editor-finding-card-name')
        name.textContent = data.editorName
        header.appendChild(name)
        const severity = doc.createElement('span')
        severity.classList.add(
            'ai-editor-finding-card-severity',
            `ai-editor-finding-card-severity-${data.severity}`
        )
        severity.textContent = SEVERITY_LABELS[data.severity]
        header.appendChild(severity)
        section.appendChild(header)

        const critique = doc.createElement('p')
        critique.classList.add('ai-editor-finding-card-critique')
        critique.textContent = data.critique
        section.appendChild(critique)

        const quote = doc.createElement('blockquote')
        quote.classList.add('ai-editor-finding-card-quote')
        quote.textContent = data.quote
        section.appendChild(quote)

        if (data.suggestion !== null) {
            section.appendChild(this.renderDiff(data.quote, data.suggestion))
        }

        section.appendChild(this.renderActions(data))
        section.appendChild(this.renderPushBackPlaceholder())
        return section
    }

    /**
     * Plain two-block old/new preview (word-level diffing is a later
     * milestone): the quoted text struck through, the suggestion below it.
     */
    private renderDiff(oldText: string, newText: string): HTMLElement {
        const doc = this.view.dom.ownerDocument
        const diff = doc.createElement('div')
        diff.classList.add('ai-editor-finding-card-diff')
        const oldEl = doc.createElement('del')
        oldEl.classList.add('ai-editor-finding-card-diff-old')
        oldEl.textContent = oldText
        diff.appendChild(oldEl)
        const newEl = doc.createElement('ins')
        newEl.classList.add('ai-editor-finding-card-diff-new')
        newEl.textContent = newText
        diff.appendChild(newEl)
        return diff
    }

    private renderActions(data: FindingCardData): HTMLElement {
        const doc = this.view.dom.ownerDocument
        const actions = doc.createElement('div')
        actions.classList.add('ai-editor-finding-card-actions')

        if (data.suggestion !== null) {
            const accept = doc.createElement('button')
            accept.classList.add('ai-editor-finding-card-accept', 'mod-cta')
            accept.textContent = 'Accept'
            accept.disabled = !data.acceptable
            if (!data.acceptable) {
                accept.title = 'The text changed since this suggestion was made'
            }
            accept.addEventListener('click', () => {
                this.acceptSection(data.findingId)
            })
            actions.appendChild(accept)
        }

        const dismiss = doc.createElement('button')
        dismiss.classList.add('ai-editor-finding-card-dismiss')
        dismiss.textContent = 'Dismiss'
        dismiss.addEventListener('click', () => {
            this.dismissSection(data.findingId)
        })
        actions.appendChild(dismiss)
        return actions
    }

    /** Disabled push-back input — thread wiring lands in a later milestone. */
    private renderPushBackPlaceholder(): HTMLElement {
        const doc = this.view.dom.ownerDocument
        const row = doc.createElement('div')
        row.classList.add('ai-editor-finding-card-pushback')
        const input = doc.createElement('input')
        input.type = 'text'
        input.disabled = true
        input.placeholder = 'Push back, ask for evidence…'
        input.setAttribute('aria-label', 'Push back (coming soon)')
        row.appendChild(input)
        const label = doc.createElement('span')
        label.classList.add('ai-editor-finding-card-coming-soon')
        label.textContent = 'Coming soon'
        row.appendChild(label)
        return row
    }

    /**
     * Accept: re-verified by the lookup against the CURRENT text (Business
     * Rules #3); on success the replacement is dispatched as one regular
     * transaction (naturally undoable) and the mark is removed in the same
     * dispatch. On failure (stale race) the card re-renders with fresh data
     * so the Accept button reflects reality instead of silently no-oping.
     */
    private acceptSection(findingId: string): void {
        const outcome = this.lookup.acceptFinding(findingId, this.view.state.doc.toString())
        if (!outcome.ok) {
            this.refreshCard()
            return
        }
        this.closeCard()
        this.view.dispatch({
            changes: { from: outcome.from, to: outcome.to, insert: outcome.insert },
            effects: removeFindingsEffect.of([findingId])
        })
        this.view.focus()
    }

    /** Dismiss: mark dismissed, drop the decoration, drop the section. */
    private dismissSection(findingId: string): void {
        this.lookup.dismissFinding(findingId)
        this.view.dispatch({ effects: removeFindingsEffect.of([findingId]) })
        this.sectionIds = this.sectionIds.filter((id) => id !== findingId)
        this.refreshCard()
    }
}

/**
 * Re-exported for the review controller: candidate spans at a position, in
 * the shape `selectFindingsAtPos` consumes.
 */
export function cardCandidatesAt(state: EditorState, pos: number): FindingSpanCandidate[] {
    return findingSpansAt(state, pos).map((span) => ({
        findingId: span.findingId,
        from: span.from,
        to: span.to
    }))
}
