/**
 * Pure state → view-model computation for the persona rail.
 *
 * Kept free of DOM so the labeling/badge/status rules are unit-testable
 * (`rail-model.spec.ts`); `rail.ts` only translates this view model into
 * elements. Review finding addressed: #19 (rail) — separating the model from
 * the view-owned DOM keeps the DOM layer trivial and disposable.
 */

export type RailEditorStatus =
    | 'idle'
    | 'pending'
    | 'running'
    | 'transforming'
    | 'done'
    | 'error'
    | 'cancelled'

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
    /**
     * Narrow pane (plan M4 adaptive layout): the rail drops the button label
     * and shrinks, so the tooltips carry everything the text said. Driven by
     * the pane `ResizeObserver` through `nextLayoutMode` (layout-mode.ts).
     */
    readonly narrow?: boolean
}

export interface RailButtonViewModel {
    /** Semantic label — what the button does, regardless of layout. */
    readonly label: 'Review' | 'Cancel'
    /**
     * What the button actually shows: the label when the pane is wide, a
     * glyph when it is narrow (the accessible name stays `ariaLabel`).
     */
    readonly text: string
    readonly action: 'review' | 'cancel'
    /** Accessible name: what the control IS, identical in both layouts. */
    readonly ariaLabel: string
    /** Hover/tooltip text: the accessible name plus narrow-pane guidance. */
    readonly tooltip: string
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
    /** True in the narrow-pane form (icon-only, tighter spacing). */
    readonly compact: boolean
}

/**
 * What clicking an editor chip does (plan §0 "Live-testing feedback #3"):
 * - `cycle-findings` — reveal the first / next revealable finding of that
 *   editor (with the ~2 s highlight emphasis);
 * - `open-panel` — nothing to reveal inline, but the editor has a summary or
 *   a failure to show: open the side panel scrolled to its section;
 * - `none` — chip in flight (tooltip already says so) or nothing to show.
 */
export type ChipClickAction = 'cycle-findings' | 'open-panel' | 'none'

/**
 * Pure chip-click decision. In-flight statuses (pending/running/
 * transforming) win over everything — findings may already be streaming in,
 * but the locked contract says a running chip is a no-op. After that,
 * revealable findings beat the panel fallback.
 *
 * `hasSummaryOrError`: the editor's run state carries a non-empty summary,
 * or ended in error/cancelled — i.e. its side-panel section has something
 * beyond "Nothing to report".
 */
export function chipClickAction(
    status: RailEditorStatus,
    revealableCount: number,
    hasSummaryOrError: boolean
): ChipClickAction {
    if (status === 'pending' || status === 'running' || status === 'transforming') {
        return 'none'
    }
    if (revealableCount > 0) {
        return 'cycle-findings'
    }
    return hasSummaryOrError ? 'open-panel' : 'none'
}

/** Tooltip/aria text of the daemon armed indicator. */
export const DAEMON_ARMED_TITLE = 'Daemon armed — the review refreshes after you pause editing'

/**
 * Glyphs the compact button falls back to. Text glyphs on purpose: the rail
 * is Obsidian-free DOM (no `setIcon`) and must not use innerHTML — same
 * reasoning as the retry chip's `↻`.
 */
const COMPACT_BUTTON_GLYPHS: Readonly<Record<'review' | 'cancel', string>> = {
    review: '▶',
    cancel: '■'
}

/**
 * Appended to the compact button's TOOLTIP (never to its accessible name — a
 * control is named, not instructed): in a narrow pane the rail is a launcher,
 * not a reading surface, and the side panel is where the findings and
 * summaries are legible (plan M2/M4: the panel IS the narrow-pane fallback).
 * Only the button carries it; repeating it on every chip would be noise, and
 * the chip tooltips already carry name + status.
 *
 * Names the real palette entry — `Open review panel`, not the review command.
 */
export const NARROW_PANEL_HINT =
    'narrow pane — run "AI Editor: Open review panel" for the full list'

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
        case 'transforming':
            // A transform/generate action is in flight on this editor. While
            // it runs it overlays the editor's review status on the rail.
            return 'transforming'
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
    const compact = state.narrow === true
    const base = state.running
        ? {
              label: 'Cancel' as const,
              action: 'cancel' as const,
              ariaLabel: 'Cancel the running review',
              disabled: false
          }
        : {
              label: 'Review' as const,
              action: 'review' as const,
              ariaLabel: 'Review this note with the enabled editors',
              disabled: state.editors.length === 0
          }
    const button: RailButtonViewModel = {
        ...base,
        text: compact ? COMPACT_BUTTON_GLYPHS[base.action] : base.label,
        tooltip: compact ? `${base.ariaLabel} (${NARROW_PANEL_HINT})` : base.ariaLabel
    }
    return {
        button,
        dots: state.editors.map(buildDot),
        daemon: state.daemonArmed === true ? { title: DAEMON_ARMED_TITLE } : null,
        compact
    }
}
