/**
 * Pure state → view-model computation for the persona rail.
 *
 * Kept free of DOM so the labeling/badge/status rules are unit-testable
 * (`rail-model.spec.ts`); `rail.ts` only translates this view model into
 * elements. Review finding addressed: #19 (rail) — separating the model from
 * the view-owned DOM keeps the DOM layer trivial and disposable.
 */

import { entityName } from '../entity-label'
import type { ScorecardStatusKind } from '../panel-scorecard'

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

/**
 * The panel this run IS, when it is one (plan M6). Business Rules #11: a panel
 * must be visually distinguishable from an editor in every surface — on the
 * rail it is ONE row with a HOLLOW identity core that owns its members, while
 * the members keep their own names and their own filled cores under it. A
 * panel weighs its members; it does not absorb them, and neither does the rail.
 */
export interface RailPanelState {
    readonly name: string
    /** Panel color (any CSS color value). */
    readonly color: string
    /** Where the scorecard stands, projected exactly like the side panel's. */
    readonly status: ScorecardStatusKind
    /**
     * The editors that are this panel's members. MEMBERSHIP only: nothing
     * reads an order out of this list — the rail renders the member rows in
     * the order the editors themselves arrive in (settings order), so that
     * one order governs the whole rail.
     */
    readonly memberIds: readonly string[]
    /** Human label of the panel's overall verdict, once there is one. */
    readonly verdictLabel?: string
}

export interface RailState {
    readonly editors: readonly RailEditorState[]
    /** Non-null when this note's run is a panel run. */
    readonly panel?: RailPanelState
    /** True while a review run is in flight (button shows Cancel). */
    readonly running: boolean
    /**
     * Whether daemon mode is on at all (the global `behavior.daemonMode`
     * setting). Drives the rail's daemon toggle, which is present in both
     * states — a control that only appears once enabled cannot be the thing
     * that enables it.
     */
    readonly daemonMode?: boolean
    /**
     * True while daemon mode is on AND an automatic refresh is armed for
     * this note (idle countdown running). Shown ON the toggle as a pulse,
     * not as a second indicator: one control, one place to look.
     */
    readonly daemonArmed?: boolean
    /**
     * Narrow pane (plan M4 adaptive layout): the rail gets DENSER — smaller
     * type, tighter spacing, a shorter name budget. It does NOT go icon-only:
     * an editor's name is the one thing the rail exists to show, and a rail
     * whose names live in tooltips is a rail nobody can read at a glance
     * (Sébastien, 2026-08-01). Driven by the pane `ResizeObserver` through
     * `nextLayoutMode` (layout-mode.ts).
     */
    readonly narrow?: boolean
    /**
     * Identity of the run currently projected, or undefined when there is no
     * run. Purely a MOTION key: `railMotion` staggers the rows in when it
     * changes, so a new run animates and the dozens of re-renders inside one
     * run do not. Fed from the run's snapshot id — a retry reuses the
     * snapshot, so retrying one editor does not re-stagger the whole rail.
     */
    readonly runKey?: string
}

export interface RailButtonViewModel {
    /**
     * What the button says — and it says it in BOTH layouts. The compact form
     * used to swap the label for a glyph; now that every row next to it
     * carries a name, a lone glyph button was the only unreadable control on
     * a rail otherwise made of words.
     */
    readonly label: 'Review' | 'Cancel'
    readonly action: 'review' | 'cancel'
    /** Accessible name: what the control IS, identical in both layouts. */
    readonly ariaLabel: string
    /** Hover/tooltip text: the accessible name plus narrow-pane guidance. */
    readonly tooltip: string
    readonly disabled: boolean
}

/**
 * What the ring around a row's identity core says about that row's work.
 * Deliberately smaller than the status vocabulary it is derived from: the ring
 * is a 16–20px shape, so it can carry "is something happening" and "did it end
 * badly", not seven distinct meanings. The full status is in the accessible
 * name, which is where precision belongs.
 *
 * - `idle` — nothing has run: the faintest ring there is;
 * - `pending` — queued behind the concurrency budget: dashed, static;
 * - `busy` — a request is in flight: an animated arc sweep in the persona
 *   colour (`running` and `transforming` both land here — the tooltip is what
 *   distinguishes them);
 * - `done` — settled with a result: a solid persona ring;
 * - `error` — the attempt failed: the ring in the error colour;
 * - `muted` — cancelled, skipped or unavailable: the ring in the muted colour.
 */
export type RailRingKind = 'idle' | 'pending' | 'busy' | 'done' | 'error' | 'muted'

/** Status → ring for an editor row. */
export function editorRing(status: RailEditorStatus): RailRingKind {
    switch (status) {
        case 'idle':
            return 'idle'
        case 'pending':
            return 'pending'
        case 'running':
        case 'transforming':
            return 'busy'
        case 'done':
            return 'done'
        case 'error':
            return 'error'
        case 'cancelled':
            return 'muted'
    }
}

/** Scorecard status → ring for the panel row. Same vocabulary, same shapes. */
export function panelRing(status: ScorecardStatusKind): RailRingKind {
    switch (status) {
        case 'waiting':
            return 'pending'
        case 'running':
            return 'busy'
        case 'ready':
            return 'done'
        case 'failed':
            return 'error'
        case 'cancelled':
        case 'skipped':
        case 'unavailable':
            return 'muted'
    }
}

export interface RailDotViewModel {
    readonly editorId: string
    readonly color: string
    readonly status: RailEditorStatus
    /** Which ring the row draws around its identity core. */
    readonly ring: RailRingKind
    /** The editor's full name — the accessible name is built from it. */
    readonly name: string
    /**
     * The name as the row RENDERS it. Normally the full name: CSS
     * `text-overflow: ellipsis` does the everyday shortening and leaves this
     * text intact. Only an absurd name is cut here, by the runaway guard
     * ({@link NAME_MAX_CHARS}), so the rail's width can never be decided by a
     * 400-character persona before CSS gets a say.
     */
    readonly displayName: string
    /**
     * What the editor is doing, as a phrase ("reviewing, 2 findings so far").
     * The half of the accessible name after the name — exposed on its own so
     * the live region can pair it with the FULL name rather than the row's
     * visible one.
     */
    readonly statusText: string
    /** Findings reported so far — the number {@link badge} caps at `99+`. */
    readonly findingCount: number
    /** Count badge text, or null when no badge should render. */
    readonly badge: string | null
    /**
     * Accessible name. Opens on {@link displayName} — the row's VISIBLE text
     * — so a speech-input user can say what they read (WCAG 2.5.3). The full
     * name rides {@link title}, which is the only place the two differ, and
     * only when the runaway-name guard fired.
     */
    readonly ariaLabel: string
    /** Hover tooltip: the FULL name plus the same status phrase. */
    readonly title: string
    /**
     * Accessible label for the retry affordance, or null when the editor is
     * not retryable. Only editors whose run attempt ended in failure
     * (`error`) or was cancelled get one — retry re-runs exactly that editor
     * inside the existing run (Architecture.md § Run lifecycle beyond the first pass).
     */
    readonly retryAriaLabel: string | null
    /**
     * True when this editor is a member of the run's panel. The view groups
     * members under the panel chip; a non-member editor (enabled, but not in
     * this panel) keeps its place outside the group.
     */
    readonly member: boolean
}

/** The panel chip: one entity, ringed, carrying the scorecard's state. */
export interface RailPanelViewModel {
    readonly name: string
    /** The name as the row renders it (same character cap as an editor's). */
    readonly displayName: string
    /** Where the scorecard stands, as a phrase — see `RailDotViewModel`. */
    readonly statusText: string
    readonly status: ScorecardStatusKind
    /** Which ring the row draws — same vocabulary as an editor's. */
    readonly ring: RailRingKind
    /** The verdict label, once the scorecard exists; null otherwise. */
    readonly badge: string | null
    readonly color: string
    readonly ariaLabel: string
    readonly title: string
    /**
     * Accessible name of the GROUP holding the chip and its member dots — the
     * only thing telling assistive tech that those dots belong to a panel
     * (the bracket that says it visually is decoration). Built here rather
     * than in the DOM layer so `(panel)` has exactly one author.
     */
    readonly groupLabel: string
}

export interface RailViewModel {
    readonly button: RailButtonViewModel
    readonly dots: readonly RailDotViewModel[]
    /** Non-null when the run is a panel run: renders as ONE ringed chip. */
    readonly panel: RailPanelViewModel | null
    /**
     * The daemon toggle, always present. `enabled` is the mode; `armed` adds
     * the pulse while this note's refresh is counting down.
     */
    readonly daemon: RailDaemonViewModel
    /**
     * True in the narrow-pane form: denser type, tighter spacing, a shorter
     * name budget. Never icon-only — see {@link RailState.narrow}.
     */
    readonly compact: boolean
    /** Motion key of the projected run; null when no run is bound. */
    readonly runKey: string | null
}

/**
 * What clicking an editor chip does (Architecture.md § Triage surfaces):
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

export interface RailDaemonViewModel {
    /** Daemon mode itself — what the toggle's next click changes. */
    readonly enabled: boolean
    /** A refresh is counting down for this note (pulse, `enabled` implied). */
    readonly armed: boolean
    /** The state glyph — hollow ring off, filled disc on. Both layouts. */
    readonly text: string
    /**
     * The word next to the glyph in a wide pane. Null in a narrow one, where
     * the rail's width is spent on the editor names instead — the toggle is a
     * mode indicator, not one of the rows the redesign is about, and its
     * `aria-pressed` + accessible name carry the state either way.
     */
    readonly label: string | null
    /** Accessible name: the state, since `aria-pressed` carries on/off. */
    readonly ariaLabel: string
    /** Tooltip: the state plus what clicking does, and the cost when off. */
    readonly tooltip: string
}

/** The word shown next to the daemon glyph in a wide pane. */
export const DAEMON_LABEL = 'Daemon'

/** Tooltip/aria text of the daemon armed indicator. */
export const DAEMON_ARMED_TITLE = 'Daemon armed — the review refreshes after you pause editing'

/**
 * The daemon toggle's text. The cost sits in the tooltip of the OFF state,
 * where it is a warning about what the click will start, rather than in the
 * ON state where it would nag about a decision already made.
 */
export function buildDaemonViewModel(
    enabled: boolean,
    armed: boolean,
    compact = false
): RailDaemonViewModel {
    const label = compact ? null : DAEMON_LABEL
    if (!enabled) {
        return {
            enabled: false,
            armed: false,
            text: '◌',
            label,
            ariaLabel: 'Daemon mode off',
            tooltip:
                'Daemon mode is off — editors run only when you summon them. Turn it on to refresh reviews automatically after you pause; every refresh calls your backends.'
        }
    }
    return {
        enabled: true,
        armed,
        text: '◉',
        label,
        ariaLabel: armed ? 'Daemon mode on, refresh armed' : 'Daemon mode on',
        tooltip: armed
            ? `${DAEMON_ARMED_TITLE}. Click to turn daemon mode off.`
            : 'Daemon mode is on — a changed note refreshes after you pause. Click to turn it off.'
    }
}

/**
 * Character budget for a row's visible name, wide pane and narrow pane.
 *
 * A RUNAWAY GUARD, not the everyday truncation. The rail's width is capped in
 * CSS and `text-overflow: ellipsis` does the real shortening against glyph
 * widths no pure function can know — and CSS truncation leaves the DOM text
 * INTACT, which is what keeps the visible label complete. What CSS cannot do
 * is stop a 400-character persona name from being laid out at all, so the
 * model hands the DOM something already bounded.
 *
 * The budgets are therefore set far above any name a row can actually show:
 * the hard cut here really does put an ellipsis into the text node, so it must
 * fire only for absurd input, never as the shortening a user sees every day.
 * When it does fire, the accessible name is rebuilt from the CUT name so the
 * visible text stays the accessible name's leading run (WCAG 2.5.3) and the
 * full name rides the tooltip.
 */
export const NAME_MAX_CHARS = 64
export const NAME_MAX_CHARS_COMPACT = 40

/** The one ellipsis character used when a name is cut. */
export const NAME_ELLIPSIS = '…'

/**
 * Cuts `name` to at most `maxChars` characters INCLUDING the ellipsis, with
 * any whitespace left dangling before the ellipsis removed (`"Concision "` →
 * `"Concision…"`, never `"Concision …"`). A non-positive budget yields the
 * ellipsis alone rather than an empty row.
 *
 * Counted in CODE POINTS, not UTF-16 units: persona names are free-form user
 * settings, and slicing an astral character (an emoji) in half leaves a lone
 * surrogate that renders as U+FFFD right where the ellipsis belongs.
 */
export function truncateName(name: string, maxChars: number): string {
    const points = [...name]
    if (points.length <= maxChars) {
        return name
    }
    if (maxChars <= 1) {
        return NAME_ELLIPSIS
    }
    return `${points
        .slice(0, maxChars - 1)
        .join('')
        .trimEnd()}${NAME_ELLIPSIS}`
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

function buildDot(editor: RailEditorState, member: boolean, nameBudget: number): RailDotViewModel {
    const statusText = statusLabel(editor)
    const displayName = truncateName(editor.name, nameBudget)
    return {
        editorId: editor.id,
        color: editor.color,
        status: editor.status,
        ring: editorRing(editor.status),
        name: editor.name,
        displayName,
        statusText,
        findingCount: editor.findingCount,
        badge: formatBadge(editor.findingCount),
        // The accessible name is built from the VISIBLE text, not from the
        // full name: a hard cut puts an ellipsis in the text node, and a
        // visible label absent from the accessible name is exactly the
        // failure WCAG 2.5.3 is about. The full name is one hover away.
        ariaLabel: `${displayName} — ${statusText}`,
        title: `${editor.name} — ${statusText}`,
        retryAriaLabel: isRetryable(editor.status) ? `Retry ${editor.name}` : null,
        member
    }
}

/**
 * What the panel chip says about the scorecard. Deliberately short: the chip
 * is a dot with a tooltip, and the side panel is where the scorecard is read —
 * so every one of these ends up pointing there rather than explaining itself.
 */
const PANEL_STATUS_LABELS: Readonly<Record<ScorecardStatusKind, string>> = {
    waiting: 'waiting for the members',
    running: 'writing the scorecard',
    ready: 'scorecard ready',
    failed: 'the scorecard failed',
    cancelled: 'the scorecard was cancelled',
    skipped: 'no scorecard — no member produced a review',
    unavailable: 'no scorecard — this panel has no aggregation backend'
}

function buildPanel(panel: RailPanelState, nameBudget: number): RailPanelViewModel {
    // "(panel)" is in the NAME, not only in the shape: a ring is a visual
    // distinction, and a screen reader has no ring (Business Rules #11 has to
    // hold in the accessibility tree too). One author for the marker —
    // `entityName` (ui/entity-label.ts).
    const marked = entityName('panel', panel.name)
    const displayName = truncateName(panel.name, nameBudget)
    // The verdict goes in the NAME, not only in the badge: the badge is
    // `aria-hidden` (it would otherwise be announced twice), so a verdict
    // living only there would be unreachable for a screen reader, and the
    // row's only visible text beyond the name would be absent from its
    // accessible name (WCAG 2.5.3). The editor rows fold their finding count
    // in for the same reason.
    const statusText =
        panel.verdictLabel === undefined
            ? PANEL_STATUS_LABELS[panel.status]
            : `${panel.verdictLabel}, ${PANEL_STATUS_LABELS[panel.status]}`
    return {
        name: panel.name,
        displayName,
        statusText,
        status: panel.status,
        ring: panelRing(panel.status),
        badge: panel.verdictLabel ?? null,
        color: panel.color,
        // Same rule as an editor row: the accessible name opens on the
        // visible text, the tooltip carries the full name.
        ariaLabel: `${entityName('panel', displayName)} — ${statusText}`,
        title: `${marked} — ${statusText}. Select to open the AI Editor Review panel.`,
        groupLabel: marked
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
        tooltip: compact ? `${base.ariaLabel} (${NARROW_PANEL_HINT})` : base.ariaLabel
    }
    const memberIds = new Set(state.panel?.memberIds ?? [])
    const nameBudget = compact ? NAME_MAX_CHARS_COMPACT : NAME_MAX_CHARS
    return {
        button,
        dots: state.editors.map((editor) => buildDot(editor, memberIds.has(editor.id), nameBudget)),
        panel: state.panel === undefined ? null : buildPanel(state.panel, nameBudget),
        daemon: buildDaemonViewModel(
            state.daemonMode === true,
            state.daemonArmed === true,
            compact
        ),
        compact,
        runKey: state.runKey ?? null
    }
}

/* --- Motion cues ---------------------------------------------------------
   Animation is a diff, not a state: "the badge went from 2 to 3" and "that
   editor just settled" are not readable from one view model, and the rail
   rebuilds its DOM on every event — so an entrance animation written into the
   stylesheet alone would replay on every streamed finding. The comparison is
   pure and lives here; `rail.ts` only carries the previous snapshot forward
   and turns the cues into classes. */

const IN_FLIGHT_STATUSES: ReadonlySet<RailEditorStatus> = new Set<RailEditorStatus>([
    'pending',
    'running',
    'transforming'
])

const TERMINAL_STATUSES: ReadonlySet<RailEditorStatus> = new Set<RailEditorStatus>([
    'done',
    'error',
    'cancelled'
])

const PANEL_IN_FLIGHT: ReadonlySet<ScorecardStatusKind> = new Set<ScorecardStatusKind>([
    'waiting',
    'running'
])

/** What the previous render showed, kept so the next one can diff against it. */
export interface RailMotionState {
    readonly runKey: string | null
    /** editor id → badge text (`''` when the row showed no badge). */
    readonly badges: Readonly<Record<string, string>>
    readonly statuses: Readonly<Record<string, RailEditorStatus>>
    readonly panelStatus: ScorecardStatusKind | null
}

/** One-shot animations this render should play. */
export interface RailMotionCues {
    /** The whole list animates in, staggered: a new run just started. */
    readonly stagger: boolean
    /** Editor ids whose count badge changed value since the last render. */
    readonly bumped: readonly string[]
    /** Editor ids that went from in-flight to a terminal status. */
    readonly settled: readonly string[]
    /** The panel's aggregation just reached a terminal status. */
    readonly panelSettled: boolean
}

const NO_CUES: RailMotionCues = { stagger: false, bumped: [], settled: [], panelSettled: false }

/**
 * Diffs one render against the previous one.
 *
 * Rules that are decisions rather than mechanics:
 * - a stagger SUPPRESSES the per-row cues. A run starting sets every row to
 *   pending at once; bumping and settling on top of the entrance would be
 *   three animations describing one event.
 * - a row appearing for the first time never bumps. Its badge "changed" from
 *   nothing, which is what the entrance already says.
 * - `idle` is neither in-flight nor terminal, so a run being dropped (every
 *   editor back to idle) is not reported as everyone settling at once.
 */
export function railMotion(
    previous: RailMotionState | null,
    viewModel: RailViewModel
): { readonly state: RailMotionState; readonly cues: RailMotionCues } {
    const badges: Record<string, string> = {}
    const statuses: Record<string, RailEditorStatus> = {}
    for (const dot of viewModel.dots) {
        badges[dot.editorId] = dot.badge ?? ''
        statuses[dot.editorId] = dot.status
    }
    const state: RailMotionState = {
        runKey: viewModel.runKey,
        badges,
        statuses,
        panelStatus: viewModel.panel?.status ?? null
    }
    const stagger =
        viewModel.runKey !== null && (previous === null || previous.runKey !== viewModel.runKey)
    if (stagger || previous === null) {
        return { state, cues: stagger ? { ...NO_CUES, stagger: true } : NO_CUES }
    }
    const bumped: string[] = []
    const settled: string[] = []
    for (const dot of viewModel.dots) {
        const wasBadge = previous.badges[dot.editorId]
        if (wasBadge !== undefined && wasBadge !== (dot.badge ?? '') && dot.badge !== null) {
            bumped.push(dot.editorId)
        }
        const wasStatus = previous.statuses[dot.editorId]
        if (
            wasStatus !== undefined &&
            IN_FLIGHT_STATUSES.has(wasStatus) &&
            TERMINAL_STATUSES.has(dot.status)
        ) {
            settled.push(dot.editorId)
        }
    }
    const panelStatus = viewModel.panel?.status ?? null
    const panelSettled =
        previous.panelStatus !== null &&
        PANEL_IN_FLIGHT.has(previous.panelStatus) &&
        panelStatus !== null &&
        !PANEL_IN_FLIGHT.has(panelStatus)
    return { state, cues: { stagger: false, bumped, settled, panelSettled } }
}

/**
 * What the rail's live region should say about this render, or null when the
 * render says nothing new.
 *
 * The rail is the primary progress surface for a run, and everything it knows
 * is PULL-ONLY: a row's accessible name is precise, but only for someone who
 * navigates back to that row — which is not a plan while findings stream in.
 * This is the half that gets pushed.
 *
 * Deliberately COARSE. It speaks only at the transitions {@link railMotion}
 * already reports — a run starting, one editor settling, the panel's scorecard
 * settling — never per streamed finding, and adds one closing sentence when
 * the last editor has landed. It uses the FULL name (the live region has no
 * width to run out of), unlike the rows' accessible names.
 */
export function railAnnouncement(viewModel: RailViewModel, cues: RailMotionCues): string | null {
    if (cues.stagger) {
        const count = viewModel.dots.length
        return `Review started, ${count === 1 ? '1 editor' : `${count} editors`}.`
    }
    const parts: string[] = []
    for (const editorId of cues.settled) {
        const dot = viewModel.dots.find((candidate) => candidate.editorId === editorId)
        if (dot !== undefined) {
            parts.push(`${dot.name} — ${dot.statusText}.`)
        }
    }
    if (cues.panelSettled && viewModel.panel !== null) {
        const panel = viewModel.panel
        parts.push(`${entityName('panel', panel.name)} — ${panel.statusText}.`)
    }
    if (parts.length === 0) {
        return null
    }
    const finished =
        viewModel.dots.length > 0 &&
        viewModel.dots.every((dot) => TERMINAL_STATUSES.has(dot.status))
    if (finished) {
        const total = viewModel.dots.reduce((sum, dot) => sum + dot.findingCount, 0)
        const failed = viewModel.dots.filter((dot) => dot.status === 'error').length
        parts.push(
            failed === 0
                ? `Review finished, ${findingsLabel(total)}.`
                : `Review finished, ${findingsLabel(total)}, ${
                      failed === 1 ? '1 editor failed' : `${failed} editors failed`
                  }.`
        )
    }
    return parts.join(' ')
}
