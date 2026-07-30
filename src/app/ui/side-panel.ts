import { ItemView, setIcon } from 'obsidian'
import type { WorkspaceLeaf } from 'obsidian'
import type { FindingId } from '../domain/ids'
import type { Severity } from '../domain/operations/contract'
import type { TrackedFinding } from '../services/orchestration/finding-store'
import type { EditorRunState, RunHandle } from '../services/orchestration/run-controller'
import type { EditorSkip } from '../services/review-service'
import { skipReasonLabel } from '../services/review-service'
import type { ReviewGate } from '../services/reviewability'
import { entityName } from './entity-label'
import { panelEmptyStateText, panelReviewButtonState } from './panel-review-button'
import { buildScorecardView } from './panel-scorecard'
import type { ScorecardTopFix, ScorecardView, TopFixCandidate } from './panel-scorecard'
import { passesSeverityFilter, severityFilterLabel } from './severity-filter'
import type { SeverityFilterMode } from './severity-filter'
import { verdictLabel } from './verdict-label'

/**
 * Side panel (`ItemView` workspace leaf): a header bound to the panel's note
 * (name + Review button, issue #16) over the list view of that note's review
 * run — per-editor status sections, findings (anchored ones click through to
 * the editor span, unanchored ones grouped separately), summaries/verdicts,
 * and the skip report.
 *
 * The view is deliberately dumb: the `ReviewController` computes a
 * `SidePanelState` (the bound note + its reviewability answer, plus the run
 * binding when there is a run) and pushes it via `setPanelState`; the panel
 * subscribes to the run handle itself for live updates while bound. All DOM
 * goes through `createEl`/`createDiv` (never `innerHTML`) on `contentEl`, so
 * popout placement is safe.
 *
 * The header exists even with no run — that is the whole point of the Review
 * button: a note with no findings yet is exactly when the user wants to start
 * one from here.
 */

export const REVIEW_PANEL_VIEW_TYPE = 'ai-editor-review'

export interface SidePanelEditorInfo {
    readonly id: string
    readonly name: string
    readonly color: string
}

export interface SidePanelBinding {
    readonly filePath: string
    readonly run: RunHandle
    readonly editors: readonly SidePanelEditorInfo[]
    readonly skips: readonly EditorSkip[]
    /** Active severity lens for this file (view state, never a mutation). */
    readonly severityFilter: SeverityFilterMode
    /** Advances the lens: all → warnings and suggestions → warnings only. */
    readonly cycleSeverityFilter: () => void
    readonly revealFinding: (findingId: FindingId) => void
    /** Retry the one failed/cancelled editor inside the existing run. */
    readonly retryEditor: (editorId: string) => void
    /** Accept every non-conflicting finding of one editor (one undo step). */
    readonly acceptAll: (editorId: string) => void
    /** Dismiss every open finding of one editor. */
    readonly dismissAll: (editorId: string) => void
}

/**
 * The panel's bound note and what can be done with it (issue #16). Present
 * whether or not a run exists — a note that was never reviewed still needs a
 * Review button.
 */
export interface PanelReviewTarget {
    /** File name of the bound note; null when the panel is bound to nothing. */
    readonly noteName: string | null
    /** Shared reviewability answer for the bound note; null when unbound. */
    readonly gate: ReviewGate | null
    /**
     * Whether a review run (or a per-editor retry) is in flight for the bound
     * note. A THUNK, not a value: the panel re-renders on run notifications
     * without a fresh push from the controller, so a captured boolean would
     * leave a spinner turning after the run settled.
     */
    readonly isBusy: () => boolean
    /**
     * Dispatches the shared whole-note review for the bound note. Refuses on
     * its own terms (Notice) when the button's state and reality disagree —
     * the state is derived at render time, so a run that started a moment ago
     * must not be replaced by a click on a stale-looking button.
     */
    readonly startReview: () => void
}

/** Everything the panel renders: the bound note's header + its run, if any. */
export interface SidePanelState {
    readonly review: PanelReviewTarget
    readonly binding: SidePanelBinding | null
}

/** Pulls the current state when the panel (re)opens or refreshes itself. */
export type SidePanelStateProvider = () => SidePanelState

const SEVERITY_ICONS: Record<Severity, string> = {
    info: 'info',
    suggestion: 'lightbulb',
    warning: 'alert-triangle'
}

const CRITIQUE_EXCERPT_MAX = 220
const QUOTE_EXCERPT_MAX = 120

function truncate(text: string, max: number): string {
    const collapsed = text.replace(/\s+/g, ' ').trim()
    return collapsed.length > max ? `${collapsed.slice(0, max)}…` : collapsed
}

function statusLabel(state: EditorRunState): string {
    switch (state.status) {
        case 'pending':
            return 'Waiting'
        case 'running':
            return 'Reviewing…'
        case 'done':
            return state.findingIds.length === 1
                ? '1 finding'
                : `${state.findingIds.length} findings`
        case 'error':
            return 'Failed'
        case 'cancelled':
            return 'Cancelled'
    }
}

export class ReviewSidePanelView extends ItemView {
    private readonly provider: SidePanelStateProvider
    private panelState: SidePanelState | null = null
    private unsubscribe: (() => void) | null = null

    constructor(leaf: WorkspaceLeaf, provider: SidePanelStateProvider) {
        super(leaf)
        this.provider = provider
        this.navigation = false
    }

    getViewType(): string {
        return REVIEW_PANEL_VIEW_TYPE
    }

    getDisplayText(): string {
        return 'AI review'
    }

    override getIcon(): string {
        return 'bot'
    }

    override onOpen(): Promise<void> {
        this.setPanelState(this.provider())
        return Promise.resolve()
    }

    override onClose(): Promise<void> {
        this.unsubscribe?.()
        this.unsubscribe = null
        this.panelState = null
        return Promise.resolve()
    }

    /**
     * Points the panel at a note and (when there is one) its run.
     * Re-subscribes only when the run handle actually changed, so streaming
     * updates keep flowing while the controller pushes refreshed states for
     * the same run.
     */
    setPanelState(state: SidePanelState): void {
        const previous = this.panelState?.binding?.run ?? null
        const next = state.binding?.run ?? null
        if (previous !== next) {
            this.unsubscribe?.()
            this.unsubscribe = next === null ? null : next.subscribe(() => this.render())
        }
        this.panelState = state
        this.render()
    }

    /**
     * Scrolls the panel to one editor's section — the rail-chip click-through
     * for chips with nothing revealable inline but a summary/error to show
     * (plan §0 "Live-testing feedback #3"). Instant scroll on purpose: no
     * smooth animation to be reduced-motion safe without a media query. A
     * no-op when the editor has no section (no run state yet).
     */
    revealEditorSection(editorId: string): void {
        const section = this.contentEl.querySelector(
            `.ai-editor-panel-section[data-editor-id="${CSS.escape(editorId)}"]`
        )
        if (section instanceof HTMLElement) {
            section.scrollIntoView({ block: 'start' })
        }
    }

    private render(): void {
        const { contentEl } = this
        contentEl.empty()
        const root = contentEl.createDiv({ cls: 'ai-editor-panel' })

        const state = this.panelState
        if (!state) {
            return
        }
        this.renderHeader(root, state)

        const binding = state.binding
        if (!binding) {
            root.createDiv({
                cls: 'ai-editor-panel-empty',
                text: panelEmptyStateText({
                    noteName: state.review.noteName,
                    gate: state.review.gate,
                    busy: state.review.isBusy()
                })
            })
            return
        }

        this.renderScorecard(root, binding)
        this.renderSeverityFilter(root, binding)
        this.renderSkips(root, binding.skips)

        const colorById = new Map(binding.editors.map((editor) => [editor.id, editor.color]))
        // Every editor of a panel run IS one of its members (the pool is the
        // panel's membership — `resolveReviewParticipants`), so the panel's
        // name is what each section below belongs to.
        const panelName = binding.run.getPanelState()?.panelName ?? null
        for (const editorState of binding.run.getEditorStates()) {
            this.renderEditorSection(
                root,
                binding,
                editorState,
                colorById.get(editorState.editorId) ?? '',
                panelName
            )
        }
    }

    /**
     * Header: the bound note's name plus the Review button (issue #16).
     *
     * The button state is derived at RENDER time from the live `isBusy()`, so
     * the run subscription's re-renders animate it and stop animating it
     * without any push from the controller. It is a real `<button>` — keyboard
     * reachable, `disabled` when refused (so Enter/Space do nothing at all
     * rather than dispatching into a refusal), with the bound note in its
     * accessible name.
     */
    private renderHeader(root: HTMLElement, state: SidePanelState): void {
        const header = root.createDiv({ cls: 'ai-editor-panel-header' })
        header.createDiv({
            cls: 'ai-editor-panel-file',
            text: state.review.noteName ?? 'No note'
        })
        const vm = panelReviewButtonState({
            noteName: state.review.noteName,
            gate: state.review.gate,
            busy: state.review.isBusy()
        })
        const button = header.createEl('button', {
            cls: 'ai-editor-panel-review-button',
            attr: { type: 'button' }
        })
        if (vm.busy) {
            // Purely decorative: the label and the accessible name already say
            // "Reviewing…", so the spinner carries no information of its own
            // and must not be announced.
            button
                .createSpan({ cls: 'ai-editor-panel-review-spinner' })
                .setAttribute('aria-hidden', 'true')
        }
        button.createSpan({ text: vm.text })
        button.setAttribute('aria-label', vm.ariaLabel)
        button.title = vm.tooltip
        button.disabled = vm.disabled
        button.toggleClass('is-busy', vm.busy)
        button.addEventListener('click', () => {
            state.review.startReview()
        })
    }

    /**
     * The panel scorecard (plan M6), at the TOP of a panel run: the panel's
     * overall verdict, where the aggregation stands, one row per member, the
     * ranked fixes and the dissent. Absent entirely for a solo run.
     *
     * It sits above the member sections and never replaces them — an
     * aggregation that failed costs a synthesis, not the reviews.
     */
    private renderScorecard(root: HTMLElement, binding: SidePanelBinding): void {
        const panel = binding.run.getPanelState()
        if (panel === null) {
            return
        }
        const view = buildScorecardView(panel, this.topFixCandidates(binding))
        const box = root.createDiv({
            cls: `ai-editor-scorecard ai-editor-scorecard-${view.status.kind}`
        })

        const header = box.createDiv({ cls: 'ai-editor-scorecard-header' })
        // Ringed, like every other panel affordance (Business Rules #11) — and
        // the name itself says "(panel)", because the ring is decoration and
        // the member sections right below it are editors.
        header.createSpan({ cls: 'ai-editor-scorecard-ring' }).setAttribute('aria-hidden', 'true')
        header.createSpan({ cls: 'ai-editor-scorecard-name', text: view.panelLabel })
        if (view.verdict !== null) {
            header.createSpan({
                cls: `ai-editor-panel-verdict ai-editor-panel-verdict-${view.verdict.verdict}`,
                text: view.verdict.label
            })
        }

        box.createDiv({ cls: 'ai-editor-scorecard-status', text: view.status.label })
        if (view.status.detail !== null) {
            box.createDiv({ cls: 'ai-editor-scorecard-detail', text: view.status.detail })
        }
        if (view.rationale !== null && view.rationale.length > 0) {
            box.createDiv({ cls: 'ai-editor-scorecard-rationale', text: view.rationale })
        }

        this.renderScorecardMembers(box, view)
        this.renderTopFixes(box, binding, view)
        this.renderDissent(box, view)
    }

    /**
     * Live findings a top fix may point at. Deliberately NOT filtered by the
     * severity lens: the panel ranked these fixes across everything the
     * members reported, and a lens that hid the target would turn a ranked
     * action into a dead row.
     */
    private topFixCandidates(binding: SidePanelBinding): TopFixCandidate[] {
        const candidates: TopFixCandidate[] = []
        for (const state of binding.run.getEditorStates()) {
            for (const id of state.findingIds) {
                const finding = binding.run.findings.get(id)
                if (
                    finding === null ||
                    (finding.status !== 'open' && finding.status !== 'preview')
                ) {
                    continue
                }
                candidates.push({
                    id: finding.id,
                    editorName: state.editorName,
                    quote: finding.raw.quote
                })
            }
        }
        return candidates
    }

    private renderScorecardMembers(box: HTMLElement, view: ScorecardView): void {
        if (view.members.length === 0) {
            return
        }
        const list = box.createDiv({ cls: 'ai-editor-scorecard-members' })
        for (const member of view.members) {
            const row = list.createDiv({ cls: 'ai-editor-scorecard-member' })
            row.createSpan({ cls: 'ai-editor-scorecard-member-name', text: member.editorName })
            if (member.missing) {
                row.createSpan({
                    cls: 'ai-editor-scorecard-missing',
                    text: 'No review — not weighed'
                })
            } else if (member.verdict !== null && member.verdictLabel !== null) {
                row.createSpan({
                    cls: `ai-editor-panel-verdict ai-editor-panel-verdict-${member.verdict}`,
                    text: member.verdictLabel
                })
            }
            if (member.keyPoint !== null && member.keyPoint.length > 0) {
                row.createSpan({ cls: 'ai-editor-scorecard-keypoint', text: member.keyPoint })
            }
        }
    }

    /**
     * Ranked fixes. A fix whose pointer resolved is a real button that reveals
     * the member finding it came from; one that carries no pointer (a
     * structural fix, or a quote no live finding has) renders as plain text —
     * a control that cannot act must not look like one.
     */
    private renderTopFixes(box: HTMLElement, binding: SidePanelBinding, view: ScorecardView): void {
        if (view.topFixes.length === 0) {
            return
        }
        box.createDiv({ cls: 'ai-editor-scorecard-subheader', text: 'Top fixes' })
        const list = box.createEl('ol', { cls: 'ai-editor-scorecard-fixes' })
        for (const fix of view.topFixes) {
            this.renderTopFix(list.createEl('li'), binding, fix)
        }
    }

    private renderTopFix(item: HTMLElement, binding: SidePanelBinding, fix: ScorecardTopFix): void {
        const findingId = fix.findingId
        if (findingId === null) {
            item.createSpan({ cls: 'ai-editor-scorecard-fix-text', text: fix.action })
        } else {
            const button = item.createEl('button', {
                cls: 'ai-editor-scorecard-fix-button',
                text: fix.action
            })
            button.setAttribute('aria-label', `${fix.action} — show the finding it comes from`)
            button.addEventListener('click', () => binding.revealFinding(findingId))
        }
        if (fix.editorName !== null) {
            item.createSpan({ cls: 'ai-editor-scorecard-fix-source', text: fix.editorName })
        }
    }

    /**
     * Dissent, as structure: the subject, then each member's own position.
     * Never collapsed into one sentence — the disagreement is what the panel
     * knows that a single editor could not have told the user.
     */
    private renderDissent(box: HTMLElement, view: ScorecardView): void {
        if (view.dissent.length === 0) {
            return
        }
        box.createDiv({ cls: 'ai-editor-scorecard-subheader', text: 'Where the members disagreed' })
        const list = box.createDiv({ cls: 'ai-editor-scorecard-dissent' })
        for (const entry of view.dissent) {
            const item = list.createDiv({ cls: 'ai-editor-scorecard-dissent-item' })
            item.createDiv({ cls: 'ai-editor-scorecard-dissent-subject', text: entry.subject })
            for (const position of entry.positions) {
                const row = item.createDiv({ cls: 'ai-editor-scorecard-dissent-position' })
                row.createSpan({
                    cls: 'ai-editor-scorecard-member-name',
                    text: position.editorName
                })
                row.createSpan({ text: position.stance })
            }
        }
    }

    /**
     * Severity filter control (plan M4): one button cycling the file's lens,
     * with the number of findings it currently hides — the filter must never
     * make findings look absent. Hidden while the run has nothing to filter.
     */
    private renderSeverityFilter(root: HTMLElement, binding: SidePanelBinding): void {
        const live = binding.run.findings
            .list()
            .filter((finding) => finding.status === 'open' || finding.status === 'preview')
        if (live.length === 0) {
            return
        }
        const hidden = live.filter(
            (finding) => !passesSeverityFilter(binding.severityFilter, finding.raw.severity)
        ).length
        const row = root.createDiv({ cls: 'ai-editor-panel-filter' })
        row.createSpan({ cls: 'ai-editor-panel-filter-label', text: 'Show' })
        const button = row.createEl('button', {
            cls: 'ai-editor-panel-filter-button',
            text: severityFilterLabel(binding.severityFilter)
        })
        // The accessible name carries the CURRENT mode as well as the action:
        // the button's visible text IS the state, so announcing only "cycle
        // the severity filter" would hide which lens is active and that
        // anything changed (and drop the visible label — WCAG 2.5.3).
        button.setAttribute(
            'aria-label',
            `Show ${severityFilterLabel(binding.severityFilter)} — select to cycle the severity filter`
        )
        button.addEventListener('click', () => binding.cycleSeverityFilter())
        if (hidden > 0) {
            row.createSpan({
                cls: 'ai-editor-panel-filter-hidden',
                text: hidden === 1 ? '1 hidden' : `${hidden} hidden`
            })
        }
    }

    private renderSkips(root: HTMLElement, skips: readonly EditorSkip[]): void {
        if (skips.length === 0) {
            return
        }
        const box = root.createDiv({ cls: 'ai-editor-panel-skips' })
        for (const skip of skips) {
            box.createDiv({
                cls: 'ai-editor-panel-skip',
                text: `Skipped ${skip.editorName}: ${skipReasonLabel(skip.reason)}.`
            })
        }
    }

    private renderEditorSection(
        root: HTMLElement,
        binding: SidePanelBinding,
        state: EditorRunState,
        color: string,
        panelName: string | null
    ): void {
        const section = root.createEl('section', {
            cls: `ai-editor-panel-section${panelName === null ? '' : ' is-panel-member'}`,
            attr: { 'data-editor-id': state.editorId }
        })
        if (panelName !== null) {
            // The indent that groups members under the scorecard is decoration.
            // Naming the section is what tells assistive tech these findings
            // came from one member of a panel and not from a lone editor
            // (Business Rules #11), and it keeps the editor's own identity —
            // a panel weighs its members, it does not absorb them.
            section.setAttribute(
                'aria-label',
                `${state.editorName} — member of ${entityName('panel', panelName)}`
            )
        }

        const header = section.createDiv({ cls: 'ai-editor-panel-section-header' })
        const dot = header.createSpan({ cls: 'ai-editor-panel-dot' })
        if (color.length > 0) {
            dot.style.backgroundColor = color
        }
        header.createSpan({ cls: 'ai-editor-panel-editor-name', text: state.editorName })
        header.createSpan({
            cls: `ai-editor-panel-status ai-editor-panel-status-${state.status}`,
            text: statusLabel(state)
        })
        if (state.verdict !== null) {
            header.createSpan({
                cls: `ai-editor-panel-verdict ai-editor-panel-verdict-${state.verdict}`,
                text: verdictLabel(state.verdict)
            })
        }
        if (state.status === 'error' || state.status === 'cancelled') {
            // Per-editor retry (mirrors the rail chip): re-runs ONLY this
            // editor inside the existing run against the current buffer text.
            const retryLabel = `Retry ${state.editorName}`
            const retryEl = header.createEl('button', { cls: 'ai-editor-panel-retry' })
            setIcon(retryEl, 'rotate-ccw')
            retryEl.setAttribute('aria-label', retryLabel)
            retryEl.title = retryLabel
            retryEl.addEventListener('click', () => {
                binding.retryEditor(state.editorId)
            })
        }

        if (state.error !== null) {
            section.createDiv({
                cls: 'ai-editor-panel-error',
                text: `${state.error.code}: ${state.error.message}`
            })
        }

        if (state.summary !== null && state.summary.length > 0) {
            section.createDiv({ cls: 'ai-editor-panel-summary', text: state.summary })
        }

        const live = state.findingIds
            .map((id) => binding.run.findings.get(id))
            .filter((finding): finding is TrackedFinding => finding !== null)
            .filter((finding) => finding.status === 'open' || finding.status === 'preview')
        // The severity lens governs the LIST (and the bulk buttons below it);
        // the section's status line above keeps reporting what the editor found.
        const findings = live.filter((finding) =>
            passesSeverityFilter(binding.severityFilter, finding.raw.severity)
        )
        const hidden = live.length - findings.length
        const anchored = findings.filter((finding) => finding.anchor !== null)
        const unanchored = findings.filter((finding) => finding.anchor === null)

        if (live.length === 0 && state.status === 'done') {
            section.createDiv({ cls: 'ai-editor-panel-none', text: 'Nothing to report.' })
        } else if (findings.length === 0 && hidden > 0) {
            section.createDiv({
                cls: 'ai-editor-panel-none',
                text:
                    hidden === 1
                        ? '1 finding hidden by the severity filter.'
                        : `${hidden} findings hidden by the severity filter.`
            })
        }

        this.renderBulkActions(section, binding, state, findings)

        const list = section.createDiv({ cls: 'ai-editor-panel-findings' })
        for (const finding of anchored) {
            this.renderFinding(list, binding, finding, true)
        }
        if (unanchored.length > 0) {
            section.createDiv({ cls: 'ai-editor-panel-subheader', text: 'Not anchored' })
            const orphanList = section.createDiv({ cls: 'ai-editor-panel-findings' })
            for (const finding of unanchored) {
                this.renderFinding(orphanList, binding, finding, false)
            }
        }
    }

    /**
     * Per-editor bulk triage (plan M4): "Accept all (n)" applies every
     * non-conflicting suggestion of this editor as ONE undoable transaction,
     * "Dismiss all (m)" clears them. Counts come from the findings this
     * section actually shows, so the buttons never promise more than the user
     * can see; each button is hidden when its count is zero (no dead UI).
     */
    private renderBulkActions(
        section: HTMLElement,
        binding: SidePanelBinding,
        state: EditorRunState,
        findings: readonly TrackedFinding[]
    ): void {
        const acceptable = findings.filter((finding) =>
            binding.run.findings.isActionable(finding.id)
        ).length
        if (acceptable === 0 && findings.length === 0) {
            return
        }
        const row = section.createDiv({ cls: 'ai-editor-panel-bulk' })
        if (acceptable > 0) {
            this.addBulkButton(
                row,
                `Accept all (${acceptable})`,
                `Accept all ${acceptable} non-conflicting findings from ${state.editorName}`,
                () => binding.acceptAll(state.editorId)
            )
        }
        if (findings.length > 0) {
            this.addBulkButton(
                row,
                `Dismiss all (${findings.length})`,
                `Dismiss all ${findings.length} findings from ${state.editorName}`,
                () => binding.dismissAll(state.editorId)
            )
        }
    }

    private addBulkButton(
        row: HTMLElement,
        text: string,
        ariaLabel: string,
        onClick: () => void
    ): void {
        const button = row.createEl('button', { cls: 'ai-editor-panel-bulk-button', text })
        button.setAttribute('aria-label', ariaLabel)
        button.addEventListener('click', onClick)
    }

    private renderFinding(
        list: HTMLElement,
        binding: SidePanelBinding,
        finding: TrackedFinding,
        clickable: boolean
    ): void {
        const stale = finding.anchor?.state === 'stale'
        const item = list.createDiv({
            cls: `ai-editor-panel-finding${clickable && !stale ? ' is-clickable' : ''}${
                stale ? ' is-stale' : ''
            }`
        })
        const iconEl = item.createSpan({
            cls: `ai-editor-panel-severity ai-editor-panel-severity-${finding.raw.severity}`
        })
        setIcon(iconEl, SEVERITY_ICONS[finding.raw.severity])
        const body = item.createDiv({ cls: 'ai-editor-panel-finding-body' })
        body.createDiv({
            cls: 'ai-editor-panel-critique',
            text: truncate(finding.raw.critique, CRITIQUE_EXCERPT_MAX)
        })
        body.createDiv({
            cls: 'ai-editor-panel-quote',
            text: truncate(finding.raw.quote, QUOTE_EXCERPT_MAX)
        })
        if (stale) {
            body.createDiv({
                cls: 'ai-editor-panel-stale-note',
                text: 'Stale — the text changed since this finding was made.'
            })
        }
        if (clickable && !stale) {
            item.setAttribute('role', 'button')
            item.setAttribute('tabindex', '0')
            const reveal = (): void => binding.revealFinding(finding.id)
            item.addEventListener('click', reveal)
            item.addEventListener('keydown', (event: KeyboardEvent) => {
                if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault()
                    reveal()
                }
            })
        }
    }
}
