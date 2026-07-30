import type { EditorRunState } from '../services/orchestration/run-controller'

/**
 * "Generate more" affordance state (plan M6): the pure projection behind the
 * per-editor button in the side panel.
 *
 * ## Why the count is in the label
 *
 * Every press is one backend request the user pays for, on a note that
 * already has findings on it. `Generate more (3)` says what is already there,
 * so the choice reads as "add to these three" rather than as a free refresh —
 * and the number changing after a round is the feedback that the round did
 * something. A bare "Generate more" would give neither.
 *
 * ## One press is one round
 *
 * There is no auto-repeat and no "keep going" mode. The button disables while
 * its own pass is in flight rather than queueing a second one, so a double
 * click cannot buy two rounds.
 */

export interface GenerateMoreView {
    /**
     * False when the affordance must not be rendered at all: the editor never
     * finished (nothing to add to), or it failed — that needs Retry, and a
     * button offering to extend findings that do not exist is a dead control.
     */
    readonly visible: boolean
    /** Button text, carrying the count of findings already on the note. */
    readonly text: string
    /** Accessible name: the action, the editor, and what it adds to. */
    readonly ariaLabel: string
    /** True while this editor's continuation pass is running. */
    readonly busy: boolean
    /** Disabled while busy — one press is one round. */
    readonly disabled: boolean
    /**
     * Why the last pass produced nothing, shown next to the button. Present
     * without the editor being marked failed on purpose: the completed pass's
     * findings are untouched, and the section must not look broken because an
     * optional extra pass did not land.
     */
    readonly error: string | null
}

const HIDDEN: GenerateMoreView = {
    visible: false,
    text: '',
    ariaLabel: '',
    busy: false,
    disabled: false,
    error: null
}

/**
 * @param findingCount findings this editor currently shows — taken from the
 * SAME list the section renders, so the button never claims a number the user
 * cannot count on screen.
 */
export function generateMoreView(
    state: Pick<EditorRunState, 'status' | 'editorName' | 'continuing' | 'continuationError'>,
    findingCount: number
): GenerateMoreView {
    // `continuing` is checked first: a pass in flight puts the editor back to
    // pending/running, and hiding the button mid-round would make the control
    // vanish under the pointer that just pressed it.
    if (state.continuing) {
        return {
            visible: true,
            text: 'Generating…',
            ariaLabel: `Asking ${state.editorName} for more findings`,
            busy: true,
            disabled: true,
            error: null
        }
    }
    if (state.status !== 'done') {
        return HIDDEN
    }
    return {
        visible: true,
        text: `Generate more (${findingCount})`,
        ariaLabel:
            findingCount === 1
                ? `Ask ${state.editorName} for more findings, on top of the 1 it already reported`
                : `Ask ${state.editorName} for more findings, on top of the ${findingCount} it already reported`,
        busy: false,
        disabled: false,
        error: state.continuationError
    }
}
