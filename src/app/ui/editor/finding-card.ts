/**
 * Minimal review card — the click-a-highlight interaction.
 *
 * Clicking a finding highlight opens ONE floating card per editor view,
 * positioned near the clicked span (clamped into the pane), showing every finding
 * that covers the click position as stacked sections: editor identity
 * (color + name), severity, critique, the quoted text, a plain old/new
 * suggestion preview, Accept / Dismiss, and the per-finding push-back thread
 * (message list + reply input, plan M4).
 *
 * Constraints honored:
 * - Pure DOM + CM6 only — no Obsidian imports. Finding data comes through an
 *   injected {@link FindingLookup} (wired by the review controller), so this
 *   module never touches the orchestration layer directly.
 * - Popout-safe: every element is created via the owning view's
 *   `ownerDocument`, and the clamping box comes from that document's window
 *   intersected with the view's own pane rect (`layout-mode.ts`).
 * - Business Rules #2/#3: Accept is only offered when a suggestion exists and
 *   only applied when the lookup's precondition check (FindingStore) passes
 *   against the CURRENT document text; the replacement is dispatched as a
 *   regular editor transaction, so undo works naturally.
 * - Escape or click-away closes the card; any external document change closes
 *   it too (its content was resolved against the pre-change document).
 * - Listeners are registered while a card is open and torn down on close and
 *   in the view plugin's `destroy` (CM6 lifecycle).
 */

import { isolateHistory } from '@codemirror/commands'
import { StateEffect } from '@codemirror/state'
import type { EditorState, Extension } from '@codemirror/state'
import { ViewPlugin } from '@codemirror/view'
import type { EditorView, PluginValue, ViewUpdate } from '@codemirror/view'
import type { Severity } from '../../domain/operations/contract'
import { THREAD_MAX_TURNS, isThreadFull } from '../../domain/operations/thread'
import type { ThreadBeginFailure, ThreadMessage, ThreadTurn } from '../../domain/operations/thread'
import { findingSpanById, findingSpansAt, removeFindingsEffect } from './finding-decorations'
import { cardMaxWidth, paneCardViewport } from './layout-mode'
import type { LayoutBox } from './layout-mode'

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
    /** Completed push-back exchanges, oldest first (see the thread domain). */
    readonly thread: readonly ThreadMessage[]
    /** In-flight or failed push-back turn; `null` when the thread is idle. */
    readonly threadTurn: ThreadTurn | null
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
    /**
     * Sends a push-back on the finding to the editor that produced it. The
     * reply lands in the FindingStore and reaches the card through
     * `refreshFindingCardEffect` (or the next time it is opened — closing the
     * card does NOT cancel the turn), and every refusal is surfaced by the
     * controller as a Notice.
     *
     * Resolves when the DISPATCH attempt settled, not when the reply arrives:
     * `true` once the store holds the pending turn, `false` when nothing was
     * recorded (excluded note, unavailable editor, store refusal). The store
     * write happens after an await (persona context assembly), so the card
     * owns the "sending" feedback until this resolves and restores the typed
     * message on `false`.
     */
    pushBack(findingId: string, message: string): Promise<boolean>
}

/**
 * Programmatic card control (keyboard triage card-on-jump, plan §0 stage D
 * slice 1): a finding id opens the card on that finding's highlight — the
 * same card a click would open, anchored at the span's coordinates — and
 * `null` closes any open card. Dispatched by the review controller after a
 * triage step revealed (scrolled to) the target, so the span is measurable.
 */
export const showFindingCardEffect = StateEffect.define<string | null>()

/**
 * Re-resolves an open card's sections from the lookup (plan M4 threads): a
 * push-back reply arrives asynchronously, long after the click that opened the
 * card, so the review controller dispatches this on every refresh cycle. A
 * no-op when no card is open, and the in-progress reply draft plus keyboard
 * focus survive the re-render.
 */
export const refreshFindingCardEffect = StateEffect.define<null>()

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

/** One rendered line of a finding's push-back thread. */
export interface ThreadRow {
    readonly role: 'user' | 'editor'
    readonly content: string
    /**
     * `settled` = a completed exchange, `pending` = the message currently in
     * flight (spinner), `failed` = the message whose turn failed.
     */
    readonly state: 'settled' | 'pending' | 'failed'
}

/** Everything the card needs to render the thread block of one section. */
export interface ThreadView {
    readonly rows: readonly ThreadRow[]
    /** Reason of the last failed turn, shown under its message. */
    readonly failure: string | null
    readonly inputEnabled: boolean
    readonly placeholder: string
    /**
     * Message to put back into the input so a failed turn can be re-sent
     * without retyping (`null` leaves whatever the user has typed).
     */
    readonly restoreDraft: string | null
}

/**
 * Projects a finding's thread state into the card's thread block. Pure so the
 * states that matter (idle / pending / failed / capped) are spec-pinned
 * instead of only reachable through a live Obsidian view.
 *
 * The in-flight (or failed) message is rendered as a row of its own rather
 * than living in `thread` — that keeps the stored thread strictly alternating
 * while still showing the user what they just sent.
 */
export function threadView(data: {
    readonly editorName: string
    readonly thread: readonly ThreadMessage[]
    readonly threadTurn: ThreadTurn | null
}): ThreadView {
    const rows: ThreadRow[] = data.thread.map((message) => ({
        role: message.role,
        content: message.content,
        state: 'settled' as const
    }))
    const turn = data.threadTurn
    if (turn) {
        rows.push({
            role: 'user',
            content: turn.message,
            state: turn.status === 'pending' ? 'pending' : 'failed'
        })
    }
    const full = isThreadFull(data.thread)
    const pending = turn?.status === 'pending'
    return {
        rows,
        failure: turn?.status === 'failed' ? turn.reason : null,
        inputEnabled: !pending && !full,
        placeholder: pending
            ? `Waiting for ${data.editorName}…`
            : full
              ? 'Push-back limit reached for this finding'
              : 'Push back, ask for evidence…',
        restoreDraft: turn?.status === 'failed' ? turn.message : null
    }
}

/**
 * What the reply input shows after a rebuild: the user's own draft when they
 * have one, otherwise `ThreadView.restoreDraft` — the failed turn's message,
 * put back so it can be re-sent without retyping.
 *
 * An empty draft is NOT a draft. Sending clears the input, and the rebuild
 * that follows captures that empty value, so treating it as a draft would
 * permanently shadow the restore and force the user to retype.
 */
export function replyInputValue(draft: string | undefined, restoreDraft: string | null): string {
    if (draft !== undefined && draft.length > 0) {
        return draft
    }
    return restoreDraft ?? ''
}

/**
 * Notice copy for a push-back the store refused. The card disables its input
 * for the cases it can see (turn in flight, cap reached), so these mostly
 * cover races — the finding was accepted or dismissed in another pane while
 * the reply was being typed.
 */
export function threadRefusalNotice(reason: ThreadBeginFailure, editorName: string): string {
    switch (reason) {
        case 'not-found':
            return 'That finding is no longer available.'
        case 'invalid-status':
            return 'That finding was already resolved — nothing left to discuss.'
        case 'in-flight':
            return `${editorName} is still answering your previous message.`
        case 'cap-reached':
            return `Push-back limit reached for this finding (${THREAD_MAX_TURNS} exchanges).`
        case 'blank-message':
            return 'Type a message before sending.'
    }
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
    /**
     * Reply text typed per finding, so an async re-render (a thread reply
     * landing while the user is typing the next one) never eats the draft.
     * Dropped when the card closes — the card is the draft's whole lifetime.
     */
    private readonly drafts = new Map<string, string>()
    /**
     * Messages sent but not yet recorded in the store, per finding. The store
     * write happens after the persona context is assembled (vault reads), so
     * without this the card would re-render as idle — input enabled, message
     * gone — and a second Enter would start a second turn that the store then
     * refuses. Cleared when the dispatch attempt resolves; the real
     * `threadTurn` takes over from there.
     */
    private readonly sending = new Map<string, string>()
    /** Finding whose reply input had focus, restored after a re-render. */
    private focusedInput: { findingId: string; selectionStart: number } | null = null

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
        // Programmatic open/close (keyboard triage card-on-jump). Processed
        // after the doc-change close so an effect riding a doc-changing
        // transaction still wins.
        for (const transaction of update.transactions) {
            for (const effect of transaction.effects) {
                if (effect.is(refreshFindingCardEffect)) {
                    this.refreshCard()
                    continue
                }
                if (!effect.is(showFindingCardEffect)) {
                    continue
                }
                if (effect.value === null) {
                    this.closeCard()
                } else {
                    this.showFindingCard(effect.value)
                }
            }
        }
    }

    destroy(): void {
        this.closeCard()
    }

    /**
     * Opens the card on one finding's highlight without a click. DOM work is
     * deferred to a CM6 measure cycle: the triage reveal's scroll request may
     * still be pending, and `coordsAtPos` only answers for laid-out content —
     * one retry covers the scroll landing a cycle later. A finding that lost
     * its mark or its card data in the meantime aborts silently (the next
     * triage step re-resolves everything).
     */
    private showFindingCard(findingId: string, retry = true): void {
        this.view.requestMeasure({
            read: () => {
                const span = findingSpanById(this.view.state, findingId)
                return span ? this.view.coordsAtPos(span.from) : null
            },
            write: (rect) => {
                if (!rect) {
                    if (retry) {
                        this.showFindingCard(findingId, false)
                    }
                    return
                }
                const sections = this.resolveSections([findingId])
                if (sections.length === 0) {
                    return
                }
                this.openCard(sections, rect)
            }
        })
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
        // Programmatically focusable (never in the tab order): focus parks
        // here while the reply input is disabled mid-turn.
        card.tabIndex = -1
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
        this.drafts.clear()
        this.focusedInput = null
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
        // A refresh (thread reply landing) rebuilds the whole card, so the
        // reply input's text and focus must be carried across by hand.
        this.captureInputState()
        card.replaceChildren()
        for (const data of sections) {
            card.appendChild(this.renderSection(data))
        }
        this.sectionIds = sections.map((section) => section.findingId)
        this.scrollThreadsToLatest()
        this.restoreInputFocus()
    }

    /** Remembers the reply drafts and which input had focus, before a rebuild. */
    private captureInputState(): void {
        const card = this.cardEl
        if (!card) {
            return
        }
        let focused: { findingId: string; selectionStart: number } | null = null
        for (const input of Array.from(
            card.querySelectorAll('input.ai-editor-finding-card-pushback-input')
        )) {
            if (!(input instanceof HTMLInputElement)) {
                continue
            }
            const findingId = input.dataset['findingId']
            if (findingId === undefined) {
                continue
            }
            // An EMPTY value is not a draft: storing it would shadow
            // `ThreadView.restoreDraft`, which puts a failed turn's message
            // back so it can be re-sent without retyping.
            if (input.value.length > 0) {
                this.drafts.set(findingId, input.value)
            } else {
                this.drafts.delete(findingId)
            }
            if (input.ownerDocument.activeElement === input) {
                focused = {
                    findingId,
                    selectionStart: input.selectionStart ?? input.value.length
                }
            }
        }
        // Focus memory survives a rebuild that DISABLED the focused input (the
        // refresh right after sending): the browser dropped focus to the body,
        // so re-reading `activeElement` would forget where the caret belongs.
        // Only kept while focus is still inside the card or nowhere at all —
        // if the user clicked into the document, their focus wins.
        if (focused !== null || !this.cardOwnsFocus(card)) {
            this.focusedInput = focused
        }
    }

    /** Whether focus is still inside the card, or has fallen to nothing. */
    private cardOwnsFocus(card: HTMLElement): boolean {
        const active = card.ownerDocument.activeElement
        return active === null || active === card.ownerDocument.body || card.contains(active)
    }

    /** Newest turn visible: the thread list is scrollable, so pin it to the end. */
    private scrollThreadsToLatest(): void {
        const card = this.cardEl
        if (!card) {
            return
        }
        for (const list of Array.from(card.querySelectorAll('.ai-editor-finding-card-thread'))) {
            list.scrollTop = list.scrollHeight
        }
    }

    /**
     * Puts the caret back where it was before a rebuild. When the matching
     * input came back DISABLED (the refresh that follows a send), focus parks
     * on the card itself instead of falling out of the dialog — keyboard and
     * screen-reader users keep their place, and the memory is retained so the
     * refresh that re-enables the input restores the caret for real.
     */
    private restoreInputFocus(): void {
        const focused = this.focusedInput
        const card = this.cardEl
        if (!focused || !card) {
            return
        }
        for (const input of Array.from(
            card.querySelectorAll('input.ai-editor-finding-card-pushback-input')
        )) {
            if (
                !(input instanceof HTMLInputElement) ||
                input.dataset['findingId'] !== focused.findingId
            ) {
                continue
            }
            if (input.disabled) {
                card.focus()
                return
            }
            input.focus()
            const caret = Math.min(focused.selectionStart, input.value.length)
            input.setSelectionRange(caret, caret)
            return
        }
    }

    /**
     * Positions the (already attached) card near the anchor, clamped into the
     * PANE (plan M4 adaptive layout) rather than the whole window: in a split
     * or a narrow pane a window-clamped card spills over the document next to
     * it. The width cap is applied before measuring — the measurement has to
     * be of the box that will actually be positioned.
     */
    private positionCard(): void {
        const card = this.cardEl
        if (!card) {
            return
        }
        const win = card.ownerDocument.defaultView
        if (!win) {
            return
        }
        const windowBox: LayoutBox = {
            left: VIEWPORT_PADDING,
            top: VIEWPORT_PADDING,
            right: win.innerWidth - VIEWPORT_PADDING,
            bottom: win.innerHeight - VIEWPORT_PADDING
        }
        const paneRect = this.view.dom.getBoundingClientRect()
        const viewport: CardViewport = paneCardViewport(paneRect, windowBox, VIEWPORT_PADDING)
        card.style.maxWidth = `${cardMaxWidth(viewport)}px`
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
        for (const element of this.renderThread(data)) {
            section.appendChild(element)
        }
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

    /**
     * The push-back thread: the exchanges so far (scrollable, newest visible)
     * followed by the reply row. Submitting sends the message through the
     * lookup and clears the input immediately — the pending row echoes what
     * was sent, and the reply lands asynchronously via
     * `refreshFindingCardEffect`.
     */
    private renderThread(data: FindingCardData): HTMLElement[] {
        const doc = this.view.dom.ownerDocument
        // A just-sent message has no store turn yet (the dispatch assembles the
        // persona context first), so the card supplies one — same projection,
        // so the pending row, the spinner and the locked input are identical to
        // the store-driven state.
        const optimistic = this.sending.get(data.findingId)
        const view = threadView({
            editorName: data.editorName,
            thread: data.thread,
            threadTurn:
                data.threadTurn ??
                (optimistic === undefined ? null : { status: 'pending', message: optimistic })
        })
        const elements: HTMLElement[] = []

        if (view.rows.length > 0) {
            const list = doc.createElement('div')
            list.classList.add('ai-editor-finding-card-thread')
            for (const row of view.rows) {
                const message = doc.createElement('div')
                message.classList.add(
                    'ai-editor-finding-card-thread-message',
                    `ai-editor-finding-card-thread-${row.role}`
                )
                if (row.state !== 'settled') {
                    message.classList.add(`ai-editor-finding-card-thread-${row.state}`)
                }
                const who = doc.createElement('span')
                who.classList.add('ai-editor-finding-card-thread-who')
                who.textContent = row.role === 'user' ? 'You' : data.editorName
                message.appendChild(who)
                const body = doc.createElement('span')
                body.classList.add('ai-editor-finding-card-thread-body')
                body.textContent = row.content
                message.appendChild(body)
                list.appendChild(message)
            }
            elements.push(list)
        }

        if (view.failure !== null) {
            const failure = doc.createElement('p')
            failure.classList.add('ai-editor-finding-card-thread-failure')
            failure.setAttribute('role', 'alert')
            failure.textContent = `Push-back failed: ${view.failure}`
            elements.push(failure)
        }

        const row = doc.createElement('div')
        row.classList.add('ai-editor-finding-card-pushback')
        const input = doc.createElement('input')
        input.classList.add('ai-editor-finding-card-pushback-input')
        input.type = 'text'
        input.dataset['findingId'] = data.findingId
        input.disabled = !view.inputEnabled
        input.placeholder = view.placeholder
        input.setAttribute('aria-label', `Push back to ${data.editorName}`)
        input.value = replyInputValue(this.drafts.get(data.findingId), view.restoreDraft)
        const send = doc.createElement('button')
        send.classList.add('ai-editor-finding-card-pushback-send')
        send.textContent = 'Send'
        send.disabled = !view.inputEnabled
        const submit = (): void => {
            const message = input.value.trim()
            if (message.length === 0 || !view.inputEnabled) {
                return
            }
            const findingId = data.findingId
            this.drafts.delete(findingId)
            input.value = ''
            // Optimistic pending state FIRST: the store write is asynchronous,
            // so re-rendering off the store would show an idle row with an
            // enabled input and let a second Enter start a second turn.
            this.sending.set(findingId, message)
            this.refreshCard()
            void this.lookup.pushBack(findingId, message).then((recorded) => {
                if (!this.sending.delete(findingId)) {
                    return
                }
                if (!recorded && this.cardEl !== null) {
                    // Nothing was recorded (refusal, excluded note, no editor):
                    // give the message back so it is not lost.
                    this.drafts.set(findingId, message)
                }
                this.refreshCard()
            })
        }
        input.addEventListener('input', () => {
            this.drafts.set(data.findingId, input.value)
        })
        input.addEventListener('keydown', (event) => {
            if (event.key !== 'Enter') {
                return
            }
            // Enter sends; the card's Escape handling is untouched (it closes
            // the card, which never cancels an in-flight turn).
            event.preventDefault()
            event.stopPropagation()
            submit()
        })
        send.addEventListener('click', () => {
            submit()
        })
        row.appendChild(input)
        row.appendChild(send)
        elements.push(row)
        return elements
    }

    /**
     * Accept: re-verified by the lookup against the CURRENT text (Business
     * Rules #3); on success the replacement is dispatched as one undoable
     * transaction and the mark is removed in the same dispatch. On failure
     * (stale race) the card re-renders with fresh data so the Accept button
     * reflects reality instead of silently no-oping.
     *
     * `isolateHistory.of('full')` keeps that transaction its OWN undo event:
     * an annotation-less transaction joins the previous history event when
     * adjacent and within `newGroupDelay` (and later typing joins it
     * symmetrically), so without it Ctrl+Z after accepting next to recent
     * typing would revert the accept AND the keystrokes. Contract pinned in
     * `finding-accept.spec.ts`.
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
            effects: removeFindingsEffect.of([findingId]),
            annotations: isolateHistory.of('full')
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
