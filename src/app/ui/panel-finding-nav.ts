import { navigableEditorFindings } from '../commands/finding-navigation'
import type { EditorScopedSourceFinding } from '../commands/finding-navigation'

/**
 * Per-editor finding navigation in the side panel's section header: the pure
 * projection behind the previous/next pair and the "2 of 5" counter.
 *
 * ## One engine, one meaning of "next"
 *
 * The set this walks comes from `navigableEditorFindings` — the SAME function
 * the rail's chip cycling calls, and the same "revealable" rule the palette's
 * `Next finding` obeys: a non-terminal finding whose anchor exists and is not
 * stale, in document order. The caller hands over the findings its section
 * actually shows (severity lens already applied), so a finding the user cannot
 * see is never a step target and never part of the count. Anything else and
 * the panel and the rail would disagree about what "next" means.
 *
 * ## Why the counter exists
 *
 * A previous/next pair with nothing between it leaves the user guessing
 * whether they have been round the loop. The position and the total are read
 * off the SAME ordered list the stepper walks, never counted a second way —
 * a counter that can disagree with the stepper is worse than no counter.
 *
 * That is also why {@link orderRowsByPosition} exists: the counter says
 * "2 of 5" in document order, so the rows under it have to BE in document
 * order, or the number points at a row the user has to hunt for.
 *
 * ## Why controls appear only from two findings up
 *
 * One finding needs no navigation (the row below is the whole list) and zero
 * needs no controls. Rendering a disabled pair instead would be a control
 * whose only state is "unavailable", and disablement is never this plugin's
 * only signal — so the pair is absent rather than dead.
 *
 * ## Why neither button is ever disabled
 *
 * Stepping wraps at both ends (the rail's cycling contract), so from any
 * position both directions have somewhere to go. The pair is therefore
 * either fully live or not rendered at all.
 */

/** Fewer revealable findings than this and the controls are not rendered. */
export const MIN_NAVIGABLE_FINDINGS = 2

/** Structural subset of a rendered row: enough to place it in the note. */
export interface PositionedRow {
    readonly id: string
    readonly anchor: { readonly from: number; readonly to: number } | null
}

/**
 * The section's rows in DOCUMENT order — the order the header's counter counts
 * in (`navigableEditorFindings` sorts the same way: start, then end, then id
 * as a stable tiebreak).
 *
 * A run hands its findings back in ARRIVAL order, and arrival order stops
 * matching document order the moment "Generate more" appends a round whose
 * findings sit earlier in the note. Left alone, the header would say
 * "2 of 5" while the finding it points at was the last row in the list.
 *
 * Rows with no anchor have no position at all; they sink to the end in
 * arrival order (`Array.prototype.sort` is stable) rather than being ordered
 * against a number they do not have. The panel groups them separately anyway.
 */
export function orderRowsByPosition<T extends PositionedRow>(rows: readonly T[]): readonly T[] {
    return [...rows].sort((left, right) => {
        const a = left.anchor
        const b = right.anchor
        if (a === null || b === null) {
            return a === b ? 0 : a === null ? 1 : -1
        }
        return (
            a.from - b.from || a.to - b.to || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0)
        )
    })
}

/**
 * Shown in place of the position when nothing in THIS editor's list is the
 * shared current finding — no stepping yet, or the cursor sits on another
 * editor's finding. "0 of 5" would read as a count of nothing; the visible
 * total stays honest and `groupAriaLabel` says the position out loud.
 */
const NO_POSITION = '—'

export interface SectionNavigationView {
    /** False when the header must not render the controls at all. */
    readonly visible: boolean
    /** Revealable findings of this editor — what the stepper walks. */
    readonly total: number
    /**
     * 1-based position of the shared current finding within `total`; `0` when
     * no finding of this editor is current.
     */
    readonly position: number
    /** Counter text: `2 of 5`, or `— of 5` before the first step. */
    readonly positionText: string
    /**
     * Accessible name of the control group. It carries the counter in words
     * (the visible pill is `aria-hidden` — the rail marks its badges the same
     * way, because the name already says the number).
     */
    readonly groupAriaLabel: string
    /** Accessible name of the previous button — names the editor (WCAG 2.4.6). */
    readonly previousAriaLabel: string
    /** Accessible name of the next button. */
    readonly nextAriaLabel: string
}

const HIDDEN: SectionNavigationView = {
    visible: false,
    total: 0,
    position: 0,
    positionText: '',
    groupAriaLabel: '',
    previousAriaLabel: '',
    nextAriaLabel: ''
}

/**
 * @param findings        the section's findings, severity lens already
 *                        applied — the list the user can actually see
 * @param editorId        whose findings this section shows
 * @param editorName      for the accessible names: several sections carry
 *                        identical controls, so each pair must say which
 *                        editor it steps through
 * @param currentFindingId the file's shared triage cursor (`null` when there
 *                        is none), so the panel, the rail and the palette all
 *                        report the same current finding
 */
export function sectionNavigationView(
    findings: readonly EditorScopedSourceFinding[],
    editorId: string,
    editorName: string,
    currentFindingId: string | null
): SectionNavigationView {
    const ordered = navigableEditorFindings(findings, editorId)
    const total = ordered.length
    if (total < MIN_NAVIGABLE_FINDINGS) {
        return HIDDEN
    }
    const index =
        currentFindingId === null
            ? -1
            : ordered.findIndex((target) => target.id === currentFindingId)
    const position = index + 1
    return {
        visible: true,
        total,
        position,
        positionText: `${position === 0 ? NO_POSITION : position} of ${total}`,
        groupAriaLabel:
            position === 0
                ? `${editorName}: ${total} findings to step through, none of them current yet`
                : `${editorName}: finding ${position} of ${total}`,
        previousAriaLabel: `Previous finding from ${editorName}`,
        nextAriaLabel: `Next finding from ${editorName}`
    }
}
