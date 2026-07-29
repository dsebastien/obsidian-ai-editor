/**
 * Pure state → view-model computation for the persona rail.
 *
 * Kept free of DOM so the labeling/badge/status rules are unit-testable
 * (`rail-model.spec.ts`); `rail.ts` only translates this view model into
 * elements. Review finding addressed: #19 (rail) — separating the model from
 * the view-owned DOM keeps the DOM layer trivial and disposable.
 */

export type RailEditorStatus = 'idle' | 'pending' | 'running' | 'done' | 'error' | 'cancelled'

/** Per-editor input state, projected by the run orchestrator. */
export interface RailEditorState {
    readonly id: string
    readonly name: string
    /** Persona color (any CSS color value). */
    readonly color: string
    readonly status: RailEditorStatus
    /** Findings reported so far (counts up live while streaming). */
    readonly findingCount: number
    /**
     * Short human reason for a failed attempt ("timeout", "rate limit"…),
     * rendered as `failed (<reason>)` in the chip tooltip. Absent when the
     * editor did not fail or the failure has no specific reason. Derive from
     * an operation error code via `railErrorReason`.
     */
    readonly errorReason?: string
}

export interface RailState {
    readonly editors: readonly RailEditorState[]
    /** True while a review run is in flight (button shows Cancel). */
    readonly running: boolean
    /**
     * True while daemon mode is on AND an automatic refresh is armed for
     * this note (idle countdown running). Rendered as a subtle indicator —
     * a small dot with a tooltip, no layout churn.
     */
    readonly daemonArmed?: boolean
}

export interface RailButtonViewModel {
    readonly label: 'Review' | 'Cancel'
    readonly action: 'review' | 'cancel'
    readonly ariaLabel: string
    readonly disabled: boolean
}

export interface RailDotViewModel {
    readonly editorId: string
    readonly color: string
    readonly status: RailEditorStatus
    /** Count badge text, or null when no badge should render. */
    readonly badge: string | null
    readonly ariaLabel: string
    readonly title: string
    /**
     * Accessible label for the retry affordance, or null when the editor is
     * not retryable. Only editors whose run attempt ended in failure
     * (`error`) or was cancelled get one — retry re-runs exactly that editor
     * inside the existing run (plan §0 "Slow & thinking models" piece 1).
     */
    readonly retryAriaLabel: string | null
}

export interface RailViewModel {
    readonly button: RailButtonViewModel
    readonly dots: readonly RailDotViewModel[]
    /** Non-null while a daemon refresh is armed for this note. */
    readonly daemon: { readonly title: string } | null
}

/** Tooltip/aria text of the daemon armed indicator. */
export const DAEMON_ARMED_TITLE = 'Daemon armed — the review refreshes after you pause editing'

const BADGE_MAX = 99

function formatBadge(findingCount: number): string | null {
    if (findingCount <= 0) {
        return null
    }
    return findingCount > BADGE_MAX ? `${BADGE_MAX}+` : String(findingCount)
}

function findingsLabel(findingCount: number): string {
    return findingCount === 1 ? '1 finding' : `${findingCount} findings`
}

/**
 * Maps an operation error code to the short reason shown in the chip
 * tooltip (`failed (timeout)`). Returns undefined for codes with no useful
 * short form ('unknown', 'cancelled' — the latter is its own status).
 */
export function railErrorReason(code: string): string | undefined {
    switch (code) {
        case 'timeout':
            return 'timeout'
        case 'network':
            return 'network'
        case 'auth':
            return 'authentication'
        case 'rate-limit':
            return 'rate limit'
        case 'invalid-output':
            return 'invalid output'
        default:
            return undefined
    }
}

function statusLabel(editor: RailEditorState): string {
    switch (editor.status) {
        case 'idle':
            return 'idle'
        case 'pending':
            return 'waiting'
        case 'running':
            return editor.findingCount > 0
                ? `reviewing, ${findingsLabel(editor.findingCount)} so far`
                : 'reviewing'
        case 'done':
            return findingsLabel(editor.findingCount)
        case 'error':
            return editor.errorReason === undefined ? 'failed' : `failed (${editor.errorReason})`
        case 'cancelled':
            return 'cancelled'
    }
}

function isRetryable(status: RailEditorStatus): boolean {
    return status === 'error' || status === 'cancelled'
}

function buildDot(editor: RailEditorState): RailDotViewModel {
    const label = `${editor.name} — ${statusLabel(editor)}`
    return {
        editorId: editor.id,
        color: editor.color,
        status: editor.status,
        badge: formatBadge(editor.findingCount),
        ariaLabel: label,
        title: label,
        retryAriaLabel: isRetryable(editor.status) ? `Retry ${editor.name}` : null
    }
}

/** Computes the full rail view model from the current run/editor state. */
export function buildRailViewModel(state: RailState): RailViewModel {
    const button: RailButtonViewModel = state.running
        ? {
              label: 'Cancel',
              action: 'cancel',
              ariaLabel: 'Cancel the running review',
              disabled: false
          }
        : {
              label: 'Review',
              action: 'review',
              ariaLabel: 'Review this note with the enabled editors',
              disabled: state.editors.length === 0
          }
    return {
        button,
        dots: state.editors.map(buildDot),
        daemon: state.daemonArmed === true ? { title: DAEMON_ARMED_TITLE } : null
    }
}
