import type { AnchorState } from '../domain/anchoring/anchor'
import type { FindingStatus } from '../services/orchestration/finding-store'

/**
 * Pure stepping logic for the `next-finding` / `prev-finding` commands
 * (design doc "Interaction surfaces" §3): which findings can be navigated to,
 * in what order, and which one a step lands on from the current cursor
 * position. The command glue only resolves the active run, reads the cursor,
 * and reveals the returned target.
 *
 * Navigable = revealable: same condition `revealFinding` enforces — a
 * non-terminal finding (`open`/`preview`) whose anchor exists and is not
 * stale. Ordering is by document position (anchor start, then end, then id
 * as a stable tiebreak), independent of arrival order or editor.
 */

export type NavigationDirection = 'next' | 'prev'

/** Structural subset of `TrackedFinding` the navigation logic needs. */
export interface NavigationSourceFinding {
    readonly id: string
    readonly status: FindingStatus
    readonly anchor: {
        readonly from: number
        readonly to: number
        readonly state: AnchorState
    } | null
}

/** One reveal target, in current-document coordinates. */
export interface NavigationTarget {
    readonly id: string
    readonly from: number
    readonly to: number
}

/**
 * The findings a navigation step can land on, ordered by document position.
 * Terminal, unanchored and stale findings are excluded — they have no
 * revealable range (stale anchors keep only a best-effort position and
 * `revealFinding` refuses them).
 */
export function navigableFindings(
    findings: readonly NavigationSourceFinding[]
): readonly NavigationTarget[] {
    const targets: NavigationTarget[] = []
    for (const finding of findings) {
        if (finding.status !== 'open' && finding.status !== 'preview') {
            continue
        }
        const anchor = finding.anchor
        if (!anchor || anchor.state !== 'anchored') {
            continue
        }
        targets.push({ id: finding.id, from: anchor.from, to: anchor.to })
    }
    return targets.sort(
        (a, b) => a.from - b.from || a.to - b.to || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
    )
}

/** Structural subset with the owning editor — rail-chip scoped navigation. */
export interface EditorScopedSourceFinding extends NavigationSourceFinding {
    readonly editorId: string
}

/**
 * The revealable findings of ONE editor, ordered by document position — the
 * chip-click cycle set (plan §0 "Live-testing feedback #3"). Same
 * revealability rules as `navigableFindings`, narrowed to the chip's editor.
 */
export function navigableEditorFindings(
    findings: readonly EditorScopedSourceFinding[],
    editorId: string
): readonly NavigationTarget[] {
    return navigableFindings(findings.filter((finding) => finding.editorId === editorId))
}

/**
 * Remembered stepping position: the finding the previous step (chip click,
 * triage next/prev, accept/dismiss auto-advance) landed on, plus the
 * document position it sat at when remembered. The position is the eviction
 * fallback — when the remembered finding leaves the navigable set (accepted,
 * dismissed, went stale), stepping resumes from where it USED to be instead
 * of restarting arbitrarily.
 */
export interface TriageMemory {
    readonly id: string
    readonly from: number
}

/**
 * Re-bases a remembered cursor onto the finding's CURRENT anchor position.
 *
 * The cursor store keeps a raw document offset and NOTHING remaps it (the
 * editor-update forwarding remaps anchors only), so the recorded offset goes
 * stale on the first edit anywhere before it. Since the offset is exactly the
 * eviction fallback `triageStep` compares live anchors against, it must be
 * refreshed from the finding's own anchor before every step — that anchor IS
 * remapped, and it survives the finding going accepted, dismissed or stale,
 * which is precisely when the fallback matters.
 *
 * `anchorFrom` is null only when the finding left the run entirely (retry
 * removal, run replacement); the recorded offset is then all there is.
 */
export function rebaseTriageMemory(
    memory: TriageMemory | null,
    anchorFrom: number | null
): TriageMemory | null {
    if (memory === null) {
        return null
    }
    return anchorFrom === null ? memory : { id: memory.id, from: anchorFrom }
}

/**
 * THE memory-based stepping engine (plan §0 stage D slice 1) shared by chip
 * cycling (`cycleFinding`), the `next-finding`/`prev-finding` triage
 * commands, and the accept/dismiss auto-advance:
 *
 * - No memory: `next` starts at the first target, `prev` at the last.
 * - Memory still in the set: step to the neighbor in anchor order, wrapping
 *   around at either end.
 * - Memory evicted (the remembered finding is no longer navigable — it was
 *   accepted, dismissed, went stale, or the run changed its ids): resume
 *   position-based. `next` lands on the first target at or after the
 *   remembered position (the "next remaining finding" — this IS the
 *   auto-advance after judging the current one), `prev` on the last target
 *   strictly before it; both wrap when nothing lies in that direction.
 */
export function triageStep(
    ordered: readonly NavigationTarget[],
    memory: TriageMemory | null,
    direction: NavigationDirection
): NavigationTarget | null {
    const first = ordered[0]
    const last = ordered[ordered.length - 1]
    if (!first || !last) {
        return null
    }
    if (memory === null) {
        return direction === 'next' ? first : last
    }
    const index = ordered.findIndex((target) => target.id === memory.id)
    if (index !== -1) {
        const offset = direction === 'next' ? 1 : ordered.length - 1
        return ordered[(index + offset) % ordered.length] ?? first
    }
    if (direction === 'next') {
        return ordered.find((target) => target.from >= memory.from) ?? first
    }
    for (let position = ordered.length - 1; position >= 0; position -= 1) {
        const target = ordered[position]
        if (target && target.from < memory.from) {
            return target
        }
    }
    return last
}

/**
 * The remembered finding, when it is still navigable — the triage commands'
 * "current finding". `null` when there is no memory or the finding left the
 * set (its cursor is invalid until the next step re-establishes one).
 */
export function triageCurrent(
    ordered: readonly NavigationTarget[],
    memory: TriageMemory | null
): NavigationTarget | null {
    if (memory === null) {
        return null
    }
    return ordered.find((target) => target.id === memory.id) ?? null
}

/**
 * The target a chip click lands on. Memory-based rather than cursor-based on
 * purpose: the contract says the FIRST click reveals the FIRST finding
 * regardless of where the cursor happens to sit, and subsequent clicks cycle
 * in anchor order with wrap-around. `lastRevealedId` is the finding the
 * previous chip click revealed; when it is null or no longer in the cycle
 * set (accepted, dismissed, went stale, new run) the cycle restarts at the
 * first target.
 *
 * Thin special case of {@link triageStep}: chip memory carries no position,
 * and a remembered position of 0 makes the eviction fallback resolve to the
 * first target — exactly the locked "restart at the first target" contract.
 */
export function cycleFinding(
    ordered: readonly NavigationTarget[],
    lastRevealedId: string | null
): NavigationTarget | null {
    return triageStep(
        ordered,
        lastRevealedId === null ? null : { id: lastRevealedId, from: 0 },
        'next'
    )
}

/**
 * The target a step lands on. `next` picks the first finding starting
 * strictly after the cursor, `prev` the last one starting strictly before
 * it — both wrap around when nothing lies in that direction. With no cursor
 * (note not open in any editor) `next` starts at the first finding and
 * `prev` at the last. Strict comparison makes repeated steps cycle: after a
 * reveal the cursor sits on the revealed finding's start, so the next step
 * moves past it.
 */
export function stepFinding(
    ordered: readonly NavigationTarget[],
    cursorOffset: number | null,
    direction: NavigationDirection
): NavigationTarget | null {
    const first = ordered[0]
    const last = ordered[ordered.length - 1]
    if (!first || !last) {
        return null
    }
    if (direction === 'next') {
        if (cursorOffset === null) {
            return first
        }
        return ordered.find((target) => target.from > cursorOffset) ?? first
    }
    if (cursorOffset === null) {
        return last
    }
    for (let index = ordered.length - 1; index >= 0; index -= 1) {
        const target = ordered[index]
        if (target && target.from < cursorOffset) {
            return target
        }
    }
    return last
}
