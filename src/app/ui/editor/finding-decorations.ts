/**
 * CM6 decoration layer projecting review findings as mark decorations.
 *
 * Review findings addressed:
 * - #4 (decorations mapping): the `DecorationSet` is explicitly mapped
 *   through `tr.changes` on EVERY transaction, and the position-carrying
 *   state effect (`setFindingsEffect`) declares a `map` function so effects
 *   survive being remapped across concurrent transactions. The decoration
 *   set is a projection only — the authoritative anchor store lives in the
 *   domain (`mapAnchorThroughChanges`), fed by `changesFromTransaction`
 *   (see `changes-adapter.ts`), which iterates the same `ChangeSet` this
 *   field maps through. Stale detection is a domain decision; this field
 *   never decides staleness on its own. Staleness reaches the decorations
 *   two ways: incrementally via `markStaleEffect`, dispatched (on a
 *   microtask) by `ReviewController.handleEditorUpdate` for exactly the
 *   findings whose anchor transitioned to stale during an edit batch (diff
 *   logic in `stale-diff.ts`), and via the deferred full
 *   `setFindingsEffect` rebuild in `ReviewController.dispatchDecorations`
 *   — the eventual-consistency backstop.
 *
 * Rendering: each finding is a `Decoration.mark` with class
 * `ai-editor-finding` (plus `ai-editor-finding-stale` when stale, plus
 * `ai-editor-finding-emphasized` during the rail-chip click flash, plus
 * `ai-editor-finding-current` on the keyboard-triage cursor's finding) and
 * the per-editor persona color exposed as the `--ai-editor-finding-color`
 * CSS custom property via an inline style attribute, so the stylesheet
 * controls how the tint is applied.
 *
 * The tint is never the only signal (plan M9): every mark also carries an
 * `ai-editor-finding-edge-<n>` class — a per-editor bottom-edge STYLE, so two
 * personas' highlights differ in shape as well as hue — and a `title` naming
 * the editor, its panel, the severity and staleness. Both are derived in
 * `finding-identity.ts`, which documents why the name rides a `title` rather
 * than an `aria-label`.
 *
 * Two transient visual states, two mechanisms on purpose:
 * - `current` (triage cursor) RIDES THE SPECS — it must survive the refresh
 *   cycle's full `setFindingsEffect` rebuilds for as long as the cursor
 *   stands, so the controller bakes it into every spec it dispatches.
 * - `emphasized` (~2 s chip-click flash) is EFFECT-ONLY — specs never carry
 *   it, so any rebuild clears the flash structurally.
 * Both can apply to the same mark; going stale drops both.
 */

import { StateEffect, StateField } from '@codemirror/state'
import type { EditorState, Range } from '@codemirror/state'
import { Decoration, EditorView } from '@codemirror/view'
import type { DecorationSet } from '@codemirror/view'

import type { Severity } from '../../domain/operations/contract'
import { FINDING_EDGE_STYLE_COUNT, findingMarkTitle } from './finding-identity'

export { changesFromTransaction } from './changes-adapter'

/** One finding span to render, expressed against the CURRENT document. */
export interface FindingDecorationSpec {
    readonly findingId: string
    readonly editorId: string
    readonly from: number
    readonly to: number
    /** Persona color (any CSS color value) used to tint the highlight. */
    readonly color: string
    /**
     * Who found this and how loudly. The mark turns it into its disclosure
     * sentence via {@link findingMarkTitle} — the persona colour alone cannot
     * say any of it (plan M9). Kept as PARTS rather than a finished string so
     * that a mark going stale in place re-derives a sentence that says so.
     */
    readonly editorName: string
    readonly panelName: string | null
    readonly severity: Severity
    /**
     * Bottom-edge style slot (0…{@link FINDING_EDGE_STYLE_COUNT}-1), from the
     * editor's position in settings. Shape, so two personas' highlights stay
     * distinguishable without hue.
     */
    readonly edgeIndex: number
    /** Stale findings render dimmed and are no longer actionable. */
    readonly stale: boolean
    /**
     * The keyboard-triage cursor's finding (at most one per dispatch):
     * rendered with the distinct `ai-editor-finding-current` ring.
     */
    readonly current: boolean
}

/**
 * Replaces all finding decorations with the given specs. Positions refer to
 * the document AFTER the dispatching transaction's changes (the usual CM6
 * convention); the effect maps its positions when remapped across other
 * transactions.
 */
export const setFindingsEffect = StateEffect.define<readonly FindingDecorationSpec[]>({
    map: (specs, mapping) =>
        specs.map((spec) => ({
            ...spec,
            from: mapping.mapPos(spec.from, 1),
            to: mapping.mapPos(spec.to, -1)
        }))
})

/** Removes every finding decoration (run cancelled, note switched, …). */
export const clearFindingsEffect = StateEffect.define<null>()

/**
 * Removes the decorations of the given findings only (accepted or dismissed
 * from a review card) — the remaining marks are untouched.
 */
export const removeFindingsEffect = StateEffect.define<readonly string[]>()

/** Marks the given findings stale (dimmed, non-actionable) in place. */
export const markStaleEffect = StateEffect.define<readonly string[]>()

/**
 * Emphasizes ONE editor's marks in place (the ~2 s rail-chip click flash —
 * plan §0 "Live-testing feedback #3"): the given editor's marks gain the
 * `ai-editor-finding-emphasized` class, every other mark loses it. `null`
 * clears the emphasis everywhere. A full `setFindingsEffect` rebuild also
 * resets emphasis (specs never carry it), so a note switch or run change
 * clears the flash without anyone remembering to.
 */
export const emphasizeEditorEffect = StateEffect.define<string | null>()

/** Shape of the private fields carried on each mark's decoration spec. */
interface FindingMarkSpec {
    readonly findingId: string
    readonly editorId: string
    readonly color: string
    readonly editorName: string
    readonly panelName: string | null
    readonly severity: Severity
    readonly edgeIndex: number
    readonly stale: boolean
    readonly emphasized: boolean
    readonly current: boolean
}

/**
 * Guards the inline style attribute: a color that could break out of the
 * declaration (`;`, `}`, …) is replaced by a theme fallback. Colors normally
 * come from validated settings; this is defense in depth, not validation.
 */
const SAFE_CSS_COLOR = /^[#a-zA-Z0-9(),.%\s/-]+$/

function sanitizeColor(color: string): string {
    return SAFE_CSS_COLOR.test(color) ? color : 'var(--text-accent)'
}

function buildMark(spec: FindingMarkSpec): Decoration {
    const classes = ['ai-editor-finding']
    const edge = edgeSlot(spec.edgeIndex)
    if (edge > 0) {
        // Slot 0 is the plain solid edge every mark starts with, so it needs
        // no class of its own — a plugin with one editor emits none of these.
        classes.push(`ai-editor-finding-edge-${edge}`)
    }
    if (spec.stale) {
        classes.push('ai-editor-finding-stale')
    }
    if (spec.emphasized) {
        classes.push('ai-editor-finding-emphasized')
    }
    if (spec.current) {
        classes.push('ai-editor-finding-current')
    }
    return Decoration.mark({
        class: classes.join(' '),
        attributes: {
            'style': `--ai-editor-finding-color: ${sanitizeColor(spec.color)}`,
            'data-finding-id': spec.findingId,
            'data-editor-id': spec.editorId,
            // The mark's own disclosure: the persona colour is not readable
            // by everyone, and a `<span>` in contenteditable is `role=generic`
            // and therefore cannot be NAMED (see finding-identity.ts). A
            // `title` is a tooltip for every sighted user and the accessible
            // description for the rest, without hijacking the note's text.
            'title': findingMarkTitle(spec)
        },
        findingId: spec.findingId,
        editorId: spec.editorId,
        color: spec.color,
        editorName: spec.editorName,
        panelName: spec.panelName,
        severity: spec.severity,
        edgeIndex: spec.edgeIndex,
        stale: spec.stale,
        emphasized: spec.emphasized,
        current: spec.current
    })
}

/** Clamps an edge slot onto the styles the stylesheet actually defines. */
function edgeSlot(index: number): number {
    return Number.isFinite(index) && index > 0 ? Math.floor(index) % FINDING_EDGE_STYLE_COUNT : 0
}

function markSpecOf(decoration: Decoration): FindingMarkSpec {
    const spec = decoration.spec as Partial<FindingMarkSpec>
    return {
        findingId: spec.findingId ?? '',
        editorId: spec.editorId ?? '',
        color: spec.color ?? '',
        editorName: spec.editorName ?? '',
        panelName: spec.panelName ?? null,
        severity: spec.severity ?? 'suggestion',
        edgeIndex: spec.edgeIndex ?? 0,
        stale: spec.stale ?? false,
        emphasized: spec.emphasized ?? false,
        current: spec.current ?? false
    }
}

/**
 * Builds a fresh decoration set from specs. Invalid ranges (empty, reversed,
 * or out of document bounds) are skipped — an unanchorable finding is shown
 * in the side panel list instead, never as a broken mark.
 */
function buildSet(specs: readonly FindingDecorationSpec[], docLength: number): DecorationSet {
    const ranges: Range<Decoration>[] = []
    for (const spec of specs) {
        if (spec.from < 0 || spec.to > docLength || spec.from >= spec.to) {
            continue
        }
        // Emphasis is effect-only (never spec-carried); a stale mark never
        // renders as current (mirrors `applyStale`).
        ranges.push(
            buildMark({
                ...spec,
                emphasized: false,
                current: spec.current && !spec.stale
            }).range(spec.from, spec.to)
        )
    }
    return Decoration.set(ranges, true)
}

/** Drops the marks belonging to the given findings, keeping all others. */
function applyRemove(decorations: DecorationSet, findingIds: readonly string[]): DecorationSet {
    const removed = new Set(findingIds)
    return decorations.update({
        filter: (_from, _to, decoration) => !removed.has(markSpecOf(decoration).findingId)
    })
}

/** Rebuilds the set with the given findings switched to their stale look. */
function applyStale(decorations: DecorationSet, findingIds: readonly string[]): DecorationSet {
    const staleIds = new Set(findingIds)
    const ranges: Range<Decoration>[] = []
    const cursor = decorations.iter()
    while (cursor.value) {
        const spec = markSpecOf(cursor.value)
        const mark =
            staleIds.has(spec.findingId) && !spec.stale
                ? // Going stale also drops any live emphasis flash and the
                  // triage-current ring — a stale mark must render dimmed,
                  // never pulsing, never "current" (it left the navigable
                  // set; the cursor invalidates on the next step).
                  buildMark({ ...spec, stale: true, emphasized: false, current: false })
                : cursor.value
        ranges.push(mark.range(cursor.from, cursor.to))
        cursor.next()
    }
    return Decoration.set(ranges, true)
}

/**
 * Rebuilds the set with exactly the given editor's live marks emphasized
 * (`null` de-emphasizes everything). Stale marks are never emphasized: they
 * are dimmed and non-revealable, and flashing them would contradict their
 * "no longer actionable" look. Marks whose emphasis already matches are
 * reused.
 */
function applyEmphasis(decorations: DecorationSet, editorId: string | null): DecorationSet {
    const ranges: Range<Decoration>[] = []
    const cursor = decorations.iter()
    while (cursor.value) {
        const spec = markSpecOf(cursor.value)
        const emphasized = editorId !== null && spec.editorId === editorId && !spec.stale
        const mark =
            emphasized === spec.emphasized ? cursor.value : buildMark({ ...spec, emphasized })
        ranges.push(mark.range(cursor.from, cursor.to))
        cursor.next()
    }
    return Decoration.set(ranges, true)
}

/**
 * The finding decoration state field. Owned by the editor extension bundle;
 * the run orchestrator drives it exclusively through the exported effects.
 */
export const findingDecorationsField = StateField.define<DecorationSet>({
    create: () => Decoration.none,
    update: (decorations, tr) => {
        let next = decorations.map(tr.changes)
        for (const effect of tr.effects) {
            if (effect.is(clearFindingsEffect)) {
                next = Decoration.none
            } else if (effect.is(setFindingsEffect)) {
                next = buildSet(effect.value, tr.newDoc.length)
            } else if (effect.is(markStaleEffect)) {
                next = applyStale(next, effect.value)
            } else if (effect.is(removeFindingsEffect)) {
                next = applyRemove(next, effect.value)
            } else if (effect.is(emphasizeEditorEffect)) {
                next = applyEmphasis(next, effect.value)
            }
        }
        return next
    },
    provide: (field) => EditorView.decorations.from(field)
})

/** One finding span in the current decoration set (current-doc coordinates). */
export interface FindingSpanInfo {
    readonly findingId: string
    readonly editorId: string
    readonly from: number
    readonly to: number
    readonly stale: boolean
}

/**
 * All finding spans whose range touches `pos` — the candidate set for the
 * review card opened by clicking a highlight (`finding-card.ts` narrows and
 * orders them). Returns an empty list when the field is not installed.
 */
export function findingSpansAt(state: EditorState, pos: number): FindingSpanInfo[] {
    const decorations = state.field(findingDecorationsField, false)
    if (!decorations) {
        return []
    }
    const spans: FindingSpanInfo[] = []
    decorations.between(pos, pos, (from, to, decoration) => {
        const spec = markSpecOf(decoration)
        spans.push({
            findingId: spec.findingId,
            editorId: spec.editorId,
            from,
            to,
            stale: spec.stale
        })
    })
    return spans
}

/**
 * The current span of one finding's mark, or `null` when it has none (field
 * not installed, finding not decorated). Used by the programmatic card open
 * (keyboard triage card-on-jump) to anchor the card without a click.
 */
export function findingSpanById(state: EditorState, findingId: string): FindingSpanInfo | null {
    const decorations = state.field(findingDecorationsField, false)
    if (!decorations) {
        return null
    }
    let found: FindingSpanInfo | null = null
    decorations.between(0, state.doc.length, (from, to, decoration) => {
        const spec = markSpecOf(decoration)
        if (spec.findingId === findingId) {
            found = {
                findingId: spec.findingId,
                editorId: spec.editorId,
                from,
                to,
                stale: spec.stale
            }
            return false // stop iterating
        }
        return undefined
    })
    return found
}
