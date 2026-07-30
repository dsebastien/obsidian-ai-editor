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
 * The target a chip click lands on. Memory-based rather than cursor-based on
 * purpose: the contract says the FIRST click reveals the FIRST finding
 * regardless of where the cursor happens to sit, and subsequent clicks cycle
 * in anchor order with wrap-around. `lastRevealedId` is the finding the
 * previous chip click revealed; when it is null or no longer in the cycle
 * set (accepted, dismissed, went stale, new run) the cycle restarts at the
 * first target.
 */
export function cycleFinding(
    ordered: readonly NavigationTarget[],
    lastRevealedId: string | null
): NavigationTarget | null {
    const first = ordered[0]
    if (!first) {
        return null
    }
    if (lastRevealedId === null) {
        return first
    }
    const index = ordered.findIndex((target) => target.id === lastRevealedId)
    if (index === -1) {
        return first
    }
    return ordered[(index + 1) % ordered.length] ?? first
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
