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
 *   field maps through. Stale detection is a domain decision: the
 *   orchestrator dispatches `markStaleEffect` when a domain anchor goes
 *   stale; this field never decides staleness on its own.
 *
 * Rendering: each finding is a `Decoration.mark` with class
 * `ai-editor-finding` (plus `ai-editor-finding-stale` when stale) and the
 * per-editor persona color exposed as the `--ai-editor-finding-color` CSS
 * custom property via an inline style attribute, so the stylesheet controls
 * how the tint is applied.
 */

import { StateEffect, StateField } from '@codemirror/state'
import type { Range } from '@codemirror/state'
import { Decoration, EditorView } from '@codemirror/view'
import type { DecorationSet } from '@codemirror/view'

export { changesFromTransaction } from './changes-adapter'

/** One finding span to render, expressed against the CURRENT document. */
export interface FindingDecorationSpec {
    readonly findingId: string
    readonly editorId: string
    readonly from: number
    readonly to: number
    /** Persona color (any CSS color value) used to tint the highlight. */
    readonly color: string
    /** Stale findings render dimmed and are no longer actionable. */
    readonly stale: boolean
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

/** Marks the given findings stale (dimmed, non-actionable) in place. */
export const markStaleEffect = StateEffect.define<readonly string[]>()

/** Shape of the private fields carried on each mark's decoration spec. */
interface FindingMarkSpec {
    readonly findingId: string
    readonly editorId: string
    readonly color: string
    readonly stale: boolean
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
    return Decoration.mark({
        class: spec.stale ? 'ai-editor-finding ai-editor-finding-stale' : 'ai-editor-finding',
        attributes: {
            'style': `--ai-editor-finding-color: ${sanitizeColor(spec.color)}`,
            'data-finding-id': spec.findingId,
            'data-editor-id': spec.editorId
        },
        findingId: spec.findingId,
        editorId: spec.editorId,
        color: spec.color,
        stale: spec.stale
    })
}

function markSpecOf(decoration: Decoration): FindingMarkSpec {
    const spec = decoration.spec as Partial<FindingMarkSpec>
    return {
        findingId: spec.findingId ?? '',
        editorId: spec.editorId ?? '',
        color: spec.color ?? '',
        stale: spec.stale ?? false
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
        ranges.push(buildMark(spec).range(spec.from, spec.to))
    }
    return Decoration.set(ranges, true)
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
                ? buildMark({ ...spec, stale: true })
                : cursor.value
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
            }
        }
        return next
    },
    provide: (field) => EditorView.decorations.from(field)
})
