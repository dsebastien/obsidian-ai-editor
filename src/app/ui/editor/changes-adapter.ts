/**
 * CM6 → domain change adapter.
 *
 * Review findings addressed: #4 (decorations mapping) — the DecorationSet is
 * only a projection; the authoritative anchors live in the domain and are
 * mapped with `mapAnchorThroughChanges`. This adapter converts the exact
 * `ChangeSet` a transaction applied into the domain `TextChange` shape so the
 * orchestrator maps its anchors through the very same changes the decoration
 * field maps through — the two can never drift apart.
 */

import type { Transaction } from '@codemirror/state'
import type { TextChange } from '../../domain/anchoring/anchor'

/**
 * Adapts `tr.changes.iterChanges` into the domain `TextChange` list.
 *
 * `iterChanges` yields spans sorted ascending and expressed in PRE-change
 * document coordinates (`fromA`/`toA`), which is exactly the contract
 * `mapAnchorThroughChanges` expects; `insertedLength` is the length of the
 * replacement text.
 */
export function changesFromTransaction(tr: Transaction): TextChange[] {
    const changes: TextChange[] = []
    tr.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
        changes.push({ from: fromA, to: toA, insertedLength: inserted.length })
    })
    return changes
}
