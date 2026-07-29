/**
 * Transform preview — the non-destructive inline diff widget for transform
 * and generate results (plan M4: source stays visible; Accept/Reject).
 *
 * When a transform result arrives, the controller dispatches
 * `showTransformPreviewEffect` with a fully built spec; this field renders it
 * as ONE block widget below the line containing the target span's end (or
 * the insertion anchor). The source text is never replaced or hidden
 * (Business Rules #2) — the widget shows a word-level red/green diff
 * (`word-diff.ts` segments) for replacements, or the continuation text for
 * insertions, plus the rationale and an Accept / Reject action row.
 *
 * Constraints honored:
 * - Pure DOM + CM6, no Obsidian imports: user intent flows back through the
 *   callbacks embedded in the spec (wired by the review controller), which
 *   owns Notices, the apply precondition, and run lifecycle.
 * - Block widgets render between lines in BOTH Live Preview and Source mode
 *   (Business Rules #6): the anchor is normalized to a line END, never a
 *   mid-line position.
 * - The decoration maps through document changes like any CM6 decoration;
 *   the CONTROLLER decides staleness (apply precondition against original
 *   offsets, Business Rules #3) and dismisses the widget — this layer never
 *   guesses.
 * - Popout-safe: all elements are created via the owning view's document.
 * - Keyboard: while focus is inside the widget, Enter accepts and Escape
 *   rejects (buttons keep their native activation). No global hotkeys.
 */

import { StateEffect, StateField } from '@codemirror/state'
import type { EditorState, Text } from '@codemirror/state'
import { Decoration, EditorView, WidgetType } from '@codemirror/view'
import type { DecorationSet } from '@codemirror/view'
import type { DiffSegment } from '../../domain/diff/word-diff'

// ---------------------------------------------------------------------------
// Spec (built by the review controller, rendered here)
// ---------------------------------------------------------------------------

/** User-intent callbacks; the controller re-verifies before applying. */
export interface TransformPreviewActions {
    readonly onAccept: () => void
    readonly onReject: () => void
}

/** Everything the preview widget renders for one settled transform run. */
export interface TransformPreviewSpec {
    readonly runId: string
    readonly kind: 'transform-selection' | 'insert-at'
    /**
     * Document offset the widget anchors to: the END of the replaced span
     * (`transform-selection`) or the insertion position (`insert-at`),
     * expressed against the document current at dispatch time. The widget
     * renders below the line containing this offset (see
     * {@link previewWidgetPos}).
     */
    readonly anchor: number
    /** Header title, e.g. "Rephrase — Concision editor". */
    readonly title: string
    /** Persona color (any CSS color value) for the identity accents. */
    readonly editorColor: string
    /** Word-level diff (replacements) or a single ins segment (insertions). */
    readonly segments: readonly DiffSegment[]
    /** One-line backend rationale, or null when none was returned. */
    readonly rationale: string | null
    readonly actions: TransformPreviewActions
}

// ---------------------------------------------------------------------------
// Effects
// ---------------------------------------------------------------------------

/** Shows (or replaces) THE transform preview of this editor view. */
export const showTransformPreviewEffect = StateEffect.define<TransformPreviewSpec>({
    map: (spec, mapping) => ({ ...spec, anchor: mapping.mapPos(spec.anchor, -1) })
})

/** Removes the transform preview (accept, reject, stale, note switch). */
export const clearTransformPreviewEffect = StateEffect.define<null>()

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested)
// ---------------------------------------------------------------------------

/**
 * Where the block widget goes: the end of the line containing `anchor`
 * (clamped into the document). When the anchor sits at the very START of a
 * line (a selection ending right after a newline — whole-line selections),
 * the widget belongs after the PREVIOUS line: that is the last line the
 * user actually selected.
 */
export function previewWidgetPos(doc: Text, anchor: number): number {
    const clamped = Math.max(0, Math.min(anchor, doc.length))
    const line = doc.lineAt(clamped)
    if (clamped === line.from && clamped > 0) {
        return doc.lineAt(clamped - 1).to
    }
    return line.to
}

/**
 * Guards the inline persona-color style (same defense-in-depth as the
 * finding decorations): a value that could break out of the declaration
 * falls back to the theme accent.
 */
const SAFE_CSS_COLOR = /^[#a-zA-Z0-9(),.%\s/-]+$/

export function sanitizePreviewColor(color: string): string {
    return SAFE_CSS_COLOR.test(color) ? color : 'var(--text-accent)'
}

/** Accessible one-line summary of what the widget proposes. */
export function previewAriaLabel(spec: Pick<TransformPreviewSpec, 'kind' | 'title'>): string {
    return spec.kind === 'transform-selection'
        ? `${spec.title} — proposed replacement`
        : `${spec.title} — proposed insertion`
}

// ---------------------------------------------------------------------------
// Widget
// ---------------------------------------------------------------------------

const SEGMENT_TAGS: Readonly<Record<DiffSegment['kind'], 'span' | 'del' | 'ins'>> = {
    same: 'span',
    del: 'del',
    ins: 'ins'
}

class TransformPreviewWidget extends WidgetType {
    constructor(private readonly spec: TransformPreviewSpec) {
        super()
    }

    override eq(other: TransformPreviewWidget): boolean {
        // Same run + same anchor → same rendering; callbacks ride along.
        return this.spec.runId === other.spec.runId && this.spec.anchor === other.spec.anchor
    }

    override ignoreEvent(): boolean {
        // The widget owns its clicks/keys; the editor must not treat them
        // as document interactions.
        return true
    }

    override toDOM(view: EditorView): HTMLElement {
        const doc = view.dom.ownerDocument
        const spec = this.spec
        const root = doc.createElement('div')
        root.classList.add('ai-editor-transform-preview')
        root.style.setProperty('--ai-editor-editor-color', sanitizePreviewColor(spec.editorColor))
        root.setAttribute('role', 'region')
        root.setAttribute('aria-label', previewAriaLabel(spec))
        root.tabIndex = 0

        const header = doc.createElement('div')
        header.classList.add('ai-editor-transform-preview-header')
        const dot = doc.createElement('span')
        dot.classList.add('ai-editor-transform-preview-dot')
        dot.setAttribute('aria-hidden', 'true')
        header.appendChild(dot)
        const title = doc.createElement('span')
        title.classList.add('ai-editor-transform-preview-title')
        title.textContent = spec.title
        header.appendChild(title)
        root.appendChild(header)

        const diff = doc.createElement('div')
        diff.classList.add('ai-editor-transform-preview-diff')
        for (const segment of spec.segments) {
            const el = doc.createElement(SEGMENT_TAGS[segment.kind])
            el.classList.add(`ai-editor-transform-preview-${segment.kind}`)
            el.textContent = segment.text
            diff.appendChild(el)
        }
        root.appendChild(diff)

        if (spec.rationale !== null && spec.rationale.length > 0) {
            const rationale = doc.createElement('p')
            rationale.classList.add('ai-editor-transform-preview-rationale')
            rationale.textContent = spec.rationale
            root.appendChild(rationale)
        }

        const actions = doc.createElement('div')
        actions.classList.add('ai-editor-transform-preview-actions')
        const accept = doc.createElement('button')
        accept.classList.add('ai-editor-transform-preview-accept', 'mod-cta')
        accept.textContent = 'Accept'
        accept.addEventListener('click', () => spec.actions.onAccept())
        actions.appendChild(accept)
        const reject = doc.createElement('button')
        reject.classList.add('ai-editor-transform-preview-reject')
        reject.textContent = 'Reject'
        reject.addEventListener('click', () => spec.actions.onReject())
        actions.appendChild(reject)
        const hint = doc.createElement('span')
        hint.classList.add('ai-editor-transform-preview-hint')
        hint.textContent = 'Enter to accept · Esc to reject'
        hint.setAttribute('aria-hidden', 'true')
        actions.appendChild(hint)
        root.appendChild(actions)

        // Widget-scoped keyboard access: only fires while focus is INSIDE
        // the widget (root or buttons). Enter on a focused button keeps its
        // native activation — accept must not shadow a focused Reject.
        root.addEventListener('keydown', (event: KeyboardEvent) => {
            if (event.key === 'Escape') {
                event.preventDefault()
                event.stopPropagation()
                spec.actions.onReject()
                return
            }
            if (event.key === 'Enter' && !(event.target instanceof HTMLButtonElement)) {
                event.preventDefault()
                event.stopPropagation()
                spec.actions.onAccept()
            }
        })
        return root
    }
}

// ---------------------------------------------------------------------------
// State field
// ---------------------------------------------------------------------------

function buildPreviewDecorations(spec: TransformPreviewSpec, doc: Text): DecorationSet {
    const widget = Decoration.widget({
        widget: new TransformPreviewWidget(spec),
        block: true,
        side: 1
    })
    return Decoration.set([widget.range(previewWidgetPos(doc, spec.anchor))])
}

/**
 * At most ONE preview per editor view (dispatching a new transform cancels
 * the previous run per file — `TransformController`). The decoration maps
 * through document changes; showing replaces, clearing empties.
 */
export const transformPreviewField = StateField.define<DecorationSet>({
    create: () => Decoration.none,
    update: (decorations, tr) => {
        let next = decorations.map(tr.changes)
        for (const effect of tr.effects) {
            if (effect.is(clearTransformPreviewEffect)) {
                next = Decoration.none
            } else if (effect.is(showTransformPreviewEffect)) {
                next = buildPreviewDecorations(effect.value, tr.newDoc)
            }
        }
        return next
    },
    provide: (field) => EditorView.decorations.from(field)
})

/** Whether a transform preview is currently rendered in this state. */
export function hasTransformPreview(state: EditorState): boolean {
    const decorations = state.field(transformPreviewField, false)
    return decorations !== undefined && decorations.size > 0
}
