import { ItemView, setIcon } from 'obsidian'
import type { WorkspaceLeaf } from 'obsidian'
import type { NavigationDirection } from '../commands/finding-navigation'
import type { FindingId } from '../domain/ids'
import type { Severity } from '../domain/operations/contract'
import type { TrackedFinding } from '../services/orchestration/finding-store'
import type { EditorRunState, RunHandle } from '../services/orchestration/run-controller'
import type { EditorSkip } from '../services/review-service'
import { skipReasonLabel } from '../services/review-service'
import type { ReviewGate } from '../services/reviewability'
import type { CommentJobRow, CommentJobsSection } from './comment-jobs-model'
import { undecoratedNoticeText } from './editor/decoration-budget'
import { SEVERITY_WORDS } from './editor/finding-identity'
import { memberSectionName } from './entity-label'
import { generateMoreView } from './generate-more'
import { isSettledClean } from './acknowledged-editors'
import { orderRowsByPosition, sectionNavigationView } from './panel-finding-nav'
import type { SectionNavigationView } from './panel-finding-nav'
import { panelEmptyStateText, panelReviewButtonState } from './panel-review-button'
import { buildScorecardView, scorecardMemberName } from './panel-scorecard'
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

export const REVIEW_PANEL_VIEW_TYPE = 'editor-ai-daemons-review'

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
    /**
     * How many of this note's findings the decoration budget left without a
     * highlight (see `editor/decoration-budget.ts`). They are all still listed
     * below; the panel says so rather than letting the note look under-marked.
     */
    readonly undecoratedFindings: number
    /** Active severity lens for this file (view state, never a mutation). */
    readonly severityFilter: SeverityFilterMode
    /** Advances the lens: all → warnings and suggestions → warnings only. */
    readonly cycleSeverityFilter: () => void
    readonly revealFinding: (findingId: FindingId) => void
    /**
     * The file's shared triage cursor — the finding the palette's next/prev,
     * the decoration layer's current ring and this panel all consider current.
     *
     * A THUNK, not a value: stepping moves the cursor through a coalesced
     * refresh, and a captured id would leave every section's counter reporting
     * the position the state was pushed at.
     */
    readonly currentFindingId: () => string | null
    /**
     * Steps the shared triage cursor through ONE editor's revealable findings
     * and reveals the target — the section header's previous/next pair. Same
     * engine as the rail's chip cycling, with a direction and wrap-around.
     */
    readonly stepEditorFinding: (editorId: string, direction: NavigationDirection) => void
    /** Retry the one failed/cancelled editor inside the existing run. */
    readonly retryEditor: (editorId: string) => void
    /** Ask one completed editor for MORE findings, keeping the ones it made. */
    readonly continueEditor: (editorId: string) => void
    /** Accept every non-conflicting finding of one editor (one undo step). */
    readonly acceptAll: (editorId: string) => void
    /** Dismiss every open finding of one editor. */
    readonly dismissAll: (editorId: string) => void
    /**
     * Reports a non-mutating panel interaction (scrolling the list) so the
     * daemon's idle window resets on it (issue #20). Every mutating callback
     * above already reports through the controller method it calls.
     */
    readonly noteActivity: () => void
    /**
     * Editor ids acknowledged as "all good" for this note (issue #24) —
     * already pruned by the controller, so every id here is still clean.
     * Their sections are skipped and counted in a restorable footer line.
     */
    readonly acknowledgedEditors: readonly string[]
    /** Acknowledge one settled-clean editor: its section leaves the list. */
    readonly acknowledgeEditor: (editorId: string) => void
    /** The footer's "Show" action: clears this note's acknowledgements. */
    readonly clearAcknowledgements: () => void
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

/**
 * Background comment jobs for the bound note (plan §5.5 / M8).
 *
 * The side panel is where they surface — see the decision recorded in
 * `services/comments/comment-job-registry.ts`: the status bar was rejected as
 * global chrome that would animate a per-second timer for a feature the user
 * is deliberately not watching.
 *
 * `section` is a THUNK, not a value: the registry's ticker re-renders the
 * panel once a second while something is in flight, and a captured section
 * would freeze every elapsed timer at the moment the state was pushed.
 */
export interface SidePanelCommentJobs {
    readonly section: () => CommentJobsSection
    /** Re-asks an interrupted or failed comment. Never a resumption. */
    readonly retry: (commentId: string) => void
    /** Aborts an in-flight job. */
    readonly cancel: (commentId: string) => void
    /** Closes the comment, keeping the record so it is not re-asked. */
    readonly resolve: (commentId: string) => void
    /** Removes the comment for good, after asking. */
    readonly remove: (commentId: string) => void
    /**
     * Opens the "Ask for comments" dialog for the active note's selection.
     * Deliberately not gated by the panel: enablement would be derived at
     * render time from a selection the user changes constantly, and a button
     * that greys out while they are selecting text is worse than one that
     * says what it needs. It refuses on its own terms.
     */
    readonly ask: () => void
}

/** Everything the panel renders: the bound note's header + its run, if any. */
export interface SidePanelState {
    readonly review: PanelReviewTarget
    readonly binding: SidePanelBinding | null
    /** Null when the plugin has no comment store (headless/test callers). */
    readonly commentJobs: SidePanelCommentJobs | null
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

/**
 * Identifies one section's previous/next button across a full rebuild.
 *
 * Every render starts with `contentEl.empty()`, so a control the user is
 * standing on is destroyed and re-created on every state push — and the
 * stepper is the plugin's first control MEANT to be pressed repeatedly.
 * Without a stable identity, one Enter on "Next" would cost a keyboard user
 * the whole traversal back through the header, the filter and the scorecard
 * before they could press it again.
 */
function navFocusKey(editorId: string, direction: NavigationDirection): string {
    return `${editorId}:${direction}`
}

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
    /**
     * The panel's polite live region. Created OUTSIDE `contentEl` and never
     * removed: `contentEl.empty()` would take it with the rest of the tree,
     * and text written into a live region created in the same tick is
     * routinely not announced at all.
     */
    private liveEl: HTMLElement | null = null
    /** Which editor's stepper was last activated here — what to announce. */
    private pendingStepEditorId: string | null = null
    /** Set during a render when that editor's section was (re)built. */
    private pendingAnnouncement: string | null = null

    constructor(leaf: WorkspaceLeaf, provider: SidePanelStateProvider) {
        super(leaf)
        this.provider = provider
        this.navigation = false
    }

    getViewType(): string {
        return REVIEW_PANEL_VIEW_TYPE
    }

    /**
     * The leaf's tab title, and what `Open review panel` reveals. "AI Editor
     * Review" rather than "AI review": the plugin is called AI Editor
     * everywhere else, and a tab named after something else reads as a
     * different feature. The view TYPE id above is untouched — it is a
     * registered identifier no user sees, and changing it orphans open leaves.
     */
    getDisplayText(): string {
        // eslint-disable-next-line obsidianmd/ui/sentence-case -- reason: proper noun. "AI Editor" is the plugin's name (manifest.json), so the tab title is a name, not a sentence — the same exemption the plugin name itself gets.
        return 'AI Editor Review'
    }

    override getIcon(): string {
        return 'bot'
    }

    override onOpen(): Promise<void> {
        // Scrolling the findings list is user activity for the daemon's idle
        // window (issue #20). One passive listener on the persistent
        // `contentEl` (renders empty its CHILDREN, listeners on it survive);
        // the binding is read at event time, so it always reports for the
        // note the panel currently shows.
        this.registerDomEvent(
            this.contentEl,
            'scroll',
            () => {
                this.panelState?.binding?.noteActivity()
            },
            { capture: true, passive: true }
        )
        this.setPanelState(this.provider())
        return Promise.resolve()
    }

    override onClose(): Promise<void> {
        this.unsubscribe?.()
        this.unsubscribe = null
        this.panelState = null
        this.liveEl?.remove()
        this.liveEl = null
        this.pendingStepEditorId = null
        this.pendingAnnouncement = null
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
     * (Architecture.md § Triage surfaces). Instant scroll on purpose: no
     * smooth animation to be reduced-motion safe without a media query. A
     * no-op when the editor has no section (no run state yet).
     */
    revealEditorSection(editorId: string): void {
        const section = this.contentEl.querySelector(
            `.editor-ai-daemons-panel-section[data-editor-id="${CSS.escape(editorId)}"]`
        )
        if (section instanceof HTMLElement) {
            section.scrollIntoView({ block: 'start' })
        }
    }

    /**
     * Rebuilds the whole panel, keeping the two things a full rebuild would
     * otherwise destroy: where the keyboard was, and what a screen reader
     * still has to be told.
     *
     * The rebuild is deliberate (one state push, one tree — no diffing), but
     * it means the control the user is standing on is a NEW element after
     * every push. The stepper is pressed repeatedly by design, so its focus
     * is captured before the tree goes and restored onto its replacement.
     */
    private render(): void {
        const focusKey = this.focusedNavKey()
        this.contentEl.empty()
        this.pendingAnnouncement = null
        this.renderTree()
        this.restoreNavFocus(focusKey)
        this.flushAnnouncement()
    }

    /** The nav button the keyboard is on right now, or null. */
    private focusedNavKey(): string | null {
        const active = this.contentEl.ownerDocument.activeElement
        if (!(active instanceof HTMLElement) || !this.contentEl.contains(active)) {
            return null
        }
        return active.getAttribute('data-nav-step')
    }

    /**
     * Puts the keyboard back on the equivalent button in the fresh tree.
     * `preventScroll`: the step already scrolled the note to the finding, and
     * the panel must not fight that with a scroll of its own.
     */
    private restoreNavFocus(key: string | null): void {
        if (key === null) {
            return
        }
        const button = this.contentEl.querySelector(`[data-nav-step="${CSS.escape(key)}"]`)
        if (button instanceof HTMLElement) {
            button.focus({ preventScroll: true })
        }
    }

    /**
     * Says where the step landed, once the section has been rebuilt with the
     * new cursor.
     *
     * The visible counter is `aria-hidden` and the position otherwise lives
     * only in the control group's `aria-label` — a static accessible name,
     * which no screen reader announces when it changes. Without this, a
     * screen-reader user pressing "Next" is told nothing at all about where
     * they landed.
     */
    private flushAnnouncement(): void {
        const text = this.pendingAnnouncement
        if (text === null) {
            return
        }
        this.pendingAnnouncement = null
        this.pendingStepEditorId = null
        this.liveRegion().setText(text)
    }

    private liveRegion(): HTMLElement {
        let region = this.liveEl
        if (region === null || !region.isConnected) {
            region = this.containerEl.createDiv({ cls: 'editor-ai-daemons-panel-live' })
            region.setAttribute('role', 'status')
            region.setAttribute('aria-live', 'polite')
            region.setAttribute('aria-atomic', 'true')
            this.liveEl = region
        }
        return region
    }

    private renderTree(): void {
        const { contentEl } = this
        const root = contentEl.createDiv({ cls: 'editor-ai-daemons-panel' })

        const state = this.panelState
        if (!state) {
            return
        }
        this.renderHeader(root, state)

        const binding = state.binding
        if (!binding) {
            root.createDiv({
                cls: 'editor-ai-daemons-panel-empty',
                text: panelEmptyStateText({
                    noteName: state.review.noteName,
                    gate: state.review.gate,
                    busy: state.review.isBusy()
                })
            })
            // Parked comments outlive every run, so they are rendered even
            // when the note has no findings on screen — that IS the state a
            // background job is usually observed in.
            this.renderCommentJobs(root, state)
            return
        }
        this.renderCommentJobs(root, state)

        this.renderScorecard(root, binding)
        this.renderSeverityFilter(root, binding)
        this.renderSkips(root, binding.skips)
        this.renderUndecoratedNotice(root, binding.undecoratedFindings)

        const colorById = new Map(binding.editors.map((editor) => [editor.id, editor.color]))
        // Every editor of a panel run IS one of its members (the pool is the
        // panel's membership — `resolveReviewParticipants`), so the panel's
        // name is what each section below belongs to.
        const panelName = binding.run.getPanelState()?.panelName ?? null
        // Acknowledged all-good sections (issue #24) are skipped — and
        // COUNTED: a panel that silently omits editors would leave the user
        // wondering whether they ran. The scorecard above is never hidden.
        const acknowledged = new Set(binding.acknowledgedEditors)
        let acknowledgedCount = 0
        for (const editorState of binding.run.getEditorStates()) {
            if (acknowledged.has(editorState.editorId)) {
                acknowledgedCount += 1
                continue
            }
            this.renderEditorSection(
                root,
                binding,
                editorState,
                colorById.get(editorState.editorId) ?? '',
                panelName
            )
        }
        this.renderAcknowledgedFooter(root, binding, acknowledgedCount)
    }

    /** The restorable trace of acknowledged sections (issue #24). */
    private renderAcknowledgedFooter(
        root: HTMLElement,
        binding: SidePanelBinding,
        count: number
    ): void {
        if (count === 0) {
            return
        }
        const footer = root.createDiv({ cls: 'editor-ai-daemons-panel-acknowledged' })
        footer.createSpan({
            text:
                count === 1
                    ? '1 all-good editor acknowledged'
                    : `${count} all-good editors acknowledged`
        })
        const show = footer.createEl('button', {
            cls: 'editor-ai-daemons-panel-acknowledged-show',
            text: 'Show'
        })
        show.setAttribute('aria-label', 'Show the acknowledged all-good editors again')
        show.addEventListener('click', () => {
            binding.clearAcknowledgements()
        })
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
        const header = root.createDiv({ cls: 'editor-ai-daemons-panel-header' })
        header.createDiv({
            cls: 'editor-ai-daemons-panel-file',
            text: state.review.noteName ?? 'No note'
        })
        const vm = panelReviewButtonState({
            noteName: state.review.noteName,
            gate: state.review.gate,
            busy: state.review.isBusy()
        })
        const button = header.createEl('button', {
            cls: 'editor-ai-daemons-panel-review-button',
            attr: { type: 'button' }
        })
        if (vm.busy) {
            // Purely decorative: the label and the accessible name already say
            // "Reviewing…", so the spinner carries no information of its own
            // and must not be announced.
            button
                .createSpan({ cls: 'editor-ai-daemons-panel-review-spinner' })
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
        const jobs = state.commentJobs
        if (jobs) {
            // Next to Review because it is the same kind of thing — an ask
            // about the note in front of you — and the only difference is
            // that its answer arrives later, in the margin.
            const ask = header.createEl('button', {
                cls: 'editor-ai-daemons-panel-comment-ask',
                text: 'Ask for comments',
                attr: { type: 'button' }
            })
            ask.setAttribute('aria-label', 'Ask for comments on the selected text')
            ask.title = 'Park a question on the selected text; the answer appears in the margin'
            ask.addEventListener('click', () => {
                jobs.ask()
            })
        }
    }

    /**
     * Background comment jobs for the bound note (plan §5.5 / M8).
     *
     * One row per live comment: who was asked, what was asked, the state, and
     * the live elapsed timer while it runs. Every affordance is a real
     * `<button>` (keyboard reachable, accessible name carries the state), and
     * the section is absent entirely when there is nothing parked.
     */
    private renderCommentJobs(root: HTMLElement, state: SidePanelState): void {
        const jobs = state.commentJobs
        if (!jobs) {
            return
        }
        const section = jobs.section()
        if (section.heading === null) {
            return
        }
        const box = root.createDiv({ cls: 'editor-ai-daemons-panel-comments' })
        box.createDiv({ cls: 'editor-ai-daemons-panel-comments-heading', text: section.heading })
        for (const row of section.rows) {
            this.renderCommentJobRow(box, jobs, row)
        }
    }

    private renderCommentJobRow(
        box: HTMLElement,
        jobs: SidePanelCommentJobs,
        row: CommentJobRow
    ): void {
        const item = box.createDiv({ cls: 'editor-ai-daemons-panel-comment' })
        // `role=generic` cannot be named (ARIA 1.2), so the composed sentence
        // needs a role that supports one — same fix as the margin card.
        item.setAttribute('role', 'group')
        item.setAttribute('aria-label', row.accessibleName)
        const head = item.createDiv({ cls: 'editor-ai-daemons-panel-comment-head' })
        head.createSpan({ cls: 'editor-ai-daemons-panel-comment-editor', text: row.editorName })
        const status = head.createSpan({ cls: 'editor-ai-daemons-panel-comment-status' })
        status.setText(
            row.view.timer === null
                ? row.view.statusLabel
                : `${row.view.statusLabel} ${row.view.timer}`
        )
        item.createDiv({ cls: 'editor-ai-daemons-panel-comment-question', text: row.question })
        if (row.view.detail !== null) {
            item.createDiv({ cls: 'editor-ai-daemons-panel-comment-detail', text: row.view.detail })
        }
        const actions = item.createDiv({ cls: 'editor-ai-daemons-panel-comment-actions' })
        if (row.view.canRetry) {
            // Never "Resume": the request died with the session, and the word
            // would promise continuity this cannot deliver (plan M8).
            this.commentActionButton(actions, 'Retry', row.editorName, () => {
                jobs.retry(row.commentId)
            })
        }
        if (row.view.canCancel) {
            this.commentActionButton(actions, 'Cancel', row.editorName, () => {
                jobs.cancel(row.commentId)
            })
        }
        if (row.view.canDismiss) {
            // "Resolve", not "Dismiss": the comment is closed and KEPT (the
            // store remembers it so nothing re-asks it). Deleting is the
            // separate, irreversible action right next to it. One vocabulary
            // across the panel and the margin column.
            this.commentActionButton(actions, 'Resolve', row.editorName, () => {
                jobs.resolve(row.commentId)
            })
        }
        this.commentActionButton(actions, 'Delete', row.editorName, () => {
            jobs.remove(row.commentId)
        })
    }

    private commentActionButton(
        actions: HTMLElement,
        label: string,
        editorName: string,
        onClick: () => void
    ): void {
        const button = actions.createEl('button', {
            cls: 'editor-ai-daemons-panel-comment-action',
            text: label,
            attr: { type: 'button' }
        })
        // Several rows carry identically-labelled buttons; the accessible name
        // has to say which comment this one acts on (WCAG 2.4.6).
        button.setAttribute('aria-label', `${label} the comment asked of ${editorName}`)
        button.addEventListener('click', onClick)
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
            cls: `editor-ai-daemons-scorecard editor-ai-daemons-scorecard-${view.status.kind}`
        })

        const header = box.createDiv({ cls: 'editor-ai-daemons-scorecard-header' })
        // Ringed, like every other panel affordance (Business Rules #11) — and
        // the name itself says "(panel)", because the ring is decoration and
        // the member sections right below it are editors.
        header
            .createSpan({ cls: 'editor-ai-daemons-scorecard-ring' })
            .setAttribute('aria-hidden', 'true')
        header.createSpan({ cls: 'editor-ai-daemons-scorecard-name', text: view.panelLabel })
        if (view.verdict !== null) {
            header.createSpan({
                cls: `editor-ai-daemons-panel-verdict editor-ai-daemons-panel-verdict-${view.verdict.verdict}`,
                text: view.verdict.label
            })
        }

        box.createDiv({ cls: 'editor-ai-daemons-scorecard-status', text: view.status.label })
        if (view.stale) {
            // The scorecard below is the previous round's. It is kept because
            // every finding it weighed is still on the note — but a member is
            // adding to them, so it must not read as current.
            box.createDiv({
                cls: 'editor-ai-daemons-scorecard-stale',
                text: 'From the previous round — a member is generating more, so this will be rewritten.'
            })
        }
        if (view.status.detail !== null) {
            box.createDiv({ cls: 'editor-ai-daemons-scorecard-detail', text: view.status.detail })
        }
        if (view.rationale !== null && view.rationale.length > 0) {
            box.createDiv({ cls: 'editor-ai-daemons-scorecard-rationale', text: view.rationale })
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
        const list = box.createDiv({ cls: 'editor-ai-daemons-scorecard-members' })
        for (const member of view.members) {
            const row = list.createDiv({ cls: 'editor-ai-daemons-scorecard-member' })
            // A row is a stack of unrelated spans; read as one run they blur
            // into the next member's name. `role=group` gives the sentence
            // its boundaries and can carry a name (a plain div cannot).
            row.setAttribute('role', 'group')
            row.setAttribute('aria-label', scorecardMemberName(member))
            row.createSpan({
                cls: 'editor-ai-daemons-scorecard-member-name',
                text: member.editorName
            })
            if (member.missing) {
                row.createSpan({
                    cls: 'editor-ai-daemons-scorecard-missing',
                    text: 'No review — not weighed'
                })
            } else if (member.unnamed) {
                // It ran and produced a review; the scorecard just never
                // mentions it. Saying so beats a row that looks half-rendered.
                row.createSpan({
                    cls: 'editor-ai-daemons-scorecard-missing',
                    text: 'Not named in the scorecard'
                })
            } else if (member.verdict !== null && member.verdictLabel !== null) {
                row.createSpan({
                    cls: `editor-ai-daemons-panel-verdict editor-ai-daemons-panel-verdict-${member.verdict}`,
                    text: member.verdictLabel
                })
            }
            if (member.keyPoint !== null && member.keyPoint.length > 0) {
                row.createSpan({
                    cls: 'editor-ai-daemons-scorecard-keypoint',
                    text: member.keyPoint
                })
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
        box.createDiv({ cls: 'editor-ai-daemons-scorecard-subheader', text: 'Top fixes' })
        const list = box.createEl('ol', { cls: 'editor-ai-daemons-scorecard-fixes' })
        for (const fix of view.topFixes) {
            this.renderTopFix(list.createEl('li'), binding, fix)
        }
    }

    private renderTopFix(item: HTMLElement, binding: SidePanelBinding, fix: ScorecardTopFix): void {
        const findingId = fix.findingId
        if (findingId === null) {
            item.createSpan({ cls: 'editor-ai-daemons-scorecard-fix-text', text: fix.action })
        } else {
            const button = item.createEl('button', {
                cls: 'editor-ai-daemons-scorecard-fix-button',
                text: fix.action
            })
            button.setAttribute('aria-label', `${fix.action} — show the finding it comes from`)
            button.addEventListener('click', () => binding.revealFinding(findingId))
        }
        if (fix.editorName !== null) {
            item.createSpan({ cls: 'editor-ai-daemons-scorecard-fix-source', text: fix.editorName })
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
        box.createDiv({
            cls: 'editor-ai-daemons-scorecard-subheader',
            text: 'Where the members disagreed'
        })
        const list = box.createDiv({ cls: 'editor-ai-daemons-scorecard-dissent' })
        for (const entry of view.dissent) {
            const item = list.createDiv({ cls: 'editor-ai-daemons-scorecard-dissent-item' })
            item.createDiv({
                cls: 'editor-ai-daemons-scorecard-dissent-subject',
                text: entry.subject
            })
            for (const position of entry.positions) {
                const row = item.createDiv({ cls: 'editor-ai-daemons-scorecard-dissent-position' })
                row.createSpan({
                    cls: 'editor-ai-daemons-scorecard-member-name',
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
        const row = root.createDiv({ cls: 'editor-ai-daemons-panel-filter' })
        row.createSpan({ cls: 'editor-ai-daemons-panel-filter-label', text: 'Show' })
        const button = row.createEl('button', {
            cls: 'editor-ai-daemons-panel-filter-button',
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
                cls: 'editor-ai-daemons-panel-filter-hidden',
                text: hidden === 1 ? '1 hidden' : `${hidden} hidden`
            })
        }
    }

    private renderSkips(root: HTMLElement, skips: readonly EditorSkip[]): void {
        if (skips.length === 0) {
            return
        }
        const box = root.createDiv({ cls: 'editor-ai-daemons-panel-skips' })
        for (const skip of skips) {
            box.createDiv({
                cls: 'editor-ai-daemons-panel-skip',
                text: `Skipped ${skip.editorName}: ${skipReasonLabel(skip.reason)}.`
            })
        }
    }

    /**
     * Says how many findings are listed but not highlighted (plan M9,
     * performance pass). Rendered next to the skip notices because it belongs
     * to the same family: things the run did that the user would otherwise
     * have to infer from an absence.
     */
    private renderUndecoratedNotice(root: HTMLElement, undecorated: number): void {
        const text = undecoratedNoticeText(undecorated)
        if (text.length === 0) {
            return
        }
        root.createDiv({ cls: 'editor-ai-daemons-panel-skips' }).createDiv({
            cls: 'editor-ai-daemons-panel-skip',
            text
        })
    }

    private renderEditorSection(
        root: HTMLElement,
        binding: SidePanelBinding,
        state: EditorRunState,
        color: string,
        panelName: string | null
    ): void {
        const section = root.createEl('section', {
            cls: `editor-ai-daemons-panel-section${panelName === null ? '' : ' is-panel-member'}`,
            attr: { 'data-editor-id': state.editorId }
        })
        // Every section is named, not only a panel member's. The indent that
        // groups members under the scorecard is decoration; the name is what
        // tells assistive tech whose findings these are — and a lone editor's
        // section, the commonest case by far, used to have none at all, so a
        // screen-reader user landing on a finding heard the critique with no
        // way to ask who wrote it (Business Rules #11, plan M9).
        section.setAttribute('aria-label', memberSectionName(state.editorName, panelName))

        const live = state.findingIds
            .map((id) => binding.run.findings.get(id))
            .filter((finding): finding is TrackedFinding => finding !== null)
            .filter((finding) => finding.status === 'open' || finding.status === 'preview')
        // The severity lens governs the LIST (and the bulk buttons and the
        // header's stepper below it); the section's status line above keeps
        // reporting what the editor found.
        const findings = live.filter((finding) =>
            passesSeverityFilter(binding.severityFilter, finding.raw.severity)
        )
        const hidden = live.length - findings.length
        // Document order, not arrival order: the header's counter numbers
        // these rows by position in the note, so row N has to BE finding N
        // (see `orderRowsByPosition`).
        const anchored = orderRowsByPosition(findings.filter((finding) => finding.anchor !== null))
        const unanchored = findings.filter((finding) => finding.anchor === null)
        const currentFindingId = binding.currentFindingId()

        const header = section.createDiv({ cls: 'editor-ai-daemons-panel-section-header' })
        const dot = header.createSpan({ cls: 'editor-ai-daemons-panel-dot' })
        if (color.length > 0) {
            dot.style.backgroundColor = color
        }
        header.createSpan({ cls: 'editor-ai-daemons-panel-editor-name', text: state.editorName })
        header.createSpan({
            cls: `editor-ai-daemons-panel-status editor-ai-daemons-panel-status-${state.status}`,
            text: statusLabel(state)
        })
        if (state.verdict !== null) {
            header.createSpan({
                cls: `editor-ai-daemons-panel-verdict editor-ai-daemons-panel-verdict-${state.verdict}`,
                text: verdictLabel(state.verdict)
            })
        }
        if (isSettledClean(state, binding.run.findings)) {
            // Acknowledge an all-good editor (issue #24): manual, never
            // automatic — the clean result is the editor's answer and the
            // user gets to read it before it goes. The section returns by
            // itself when this editor next reports live findings.
            const ackLabel = `Acknowledge ${state.editorName} — hide this section until it reports findings again`
            const ackEl = header.createEl('button', {
                cls: 'editor-ai-daemons-panel-acknowledge',
                text: '✓'
            })
            ackEl.setAttribute('aria-label', ackLabel)
            ackEl.title = ackLabel
            ackEl.addEventListener('click', () => {
                binding.acknowledgeEditor(state.editorId)
            })
        }
        if (state.status === 'error' || state.status === 'cancelled') {
            // Per-editor retry (mirrors the rail chip): re-runs ONLY this
            // editor inside the existing run against the current buffer text.
            const retryLabel = `Retry ${state.editorName}`
            const retryEl = header.createEl('button', { cls: 'editor-ai-daemons-panel-retry' })
            setIcon(retryEl, 'rotate-ccw')
            retryEl.setAttribute('aria-label', retryLabel)
            retryEl.title = retryLabel
            retryEl.addEventListener('click', () => {
                binding.retryEditor(state.editorId)
            })
        }
        this.renderSectionNavigation(header, binding, state, findings, currentFindingId)

        if (state.error !== null) {
            section.createDiv({
                cls: 'editor-ai-daemons-panel-error',
                text: `${state.error.code}: ${state.error.message}`
            })
        }

        // Salvage report (contract v2 design §5): what validation removed from
        // this editor's output is said here, never silently absorbed.
        if (state.salvage !== null) {
            const parts: string[] = []
            if (state.salvage.discardedFindings > 0) {
                const count = state.salvage.discardedFindings
                parts.push(
                    count === 1
                        ? '1 malformed finding was discarded'
                        : `${count} malformed findings were discarded`
                )
            }
            if (state.salvage.invalidProposals > 0) {
                const count = state.salvage.invalidProposals
                parts.push(
                    count === 1
                        ? '1 proposal could not be validated and was removed'
                        : `${count} proposals could not be validated and were removed`
                )
            }
            if (parts.length > 0) {
                section.createDiv({
                    cls: 'editor-ai-daemons-panel-salvage',
                    text: `${parts.join('; ')}.`
                })
            }
        }

        if (state.summary !== null && state.summary.length > 0) {
            section.createDiv({ cls: 'editor-ai-daemons-panel-summary', text: state.summary })
        }

        if (live.length === 0 && state.status === 'done') {
            section.createDiv({ cls: 'editor-ai-daemons-panel-none', text: 'Nothing to report.' })
        } else if (findings.length === 0 && hidden > 0) {
            section.createDiv({
                cls: 'editor-ai-daemons-panel-none',
                text:
                    hidden === 1
                        ? '1 finding hidden by the severity filter.'
                        : `${hidden} findings hidden by the severity filter.`
            })
        }

        this.renderBulkActions(section, binding, state, findings)
        this.renderGenerateMore(section, binding, state, live.length)

        const list = section.createDiv({ cls: 'editor-ai-daemons-panel-findings' })
        for (const finding of anchored) {
            this.renderFinding(list, binding, finding, true, currentFindingId)
        }
        if (unanchored.length > 0) {
            section.createDiv({ cls: 'editor-ai-daemons-panel-subheader', text: 'Not anchored' })
            const orphanList = section.createDiv({ cls: 'editor-ai-daemons-panel-findings' })
            for (const finding of unanchored) {
                // An unanchored finding is never steppable, so it can never be
                // the cursor — passing the id would be dead weight.
                this.renderFinding(orphanList, binding, finding, false, null)
            }
        }
    }

    /**
     * Per-editor finding navigation in the section header: previous/next over
     * THIS editor's revealable findings, with the position between them.
     *
     * Every decision (whether the pair renders, the counter, the accessible
     * names) comes from `sectionNavigationView`, over the very findings the
     * section lists — so the header can never promise a step the list below it
     * does not have. Stepping goes through the shared triage cursor, which is
     * what keeps the palette's next/prev, the rail and this pair pointed at the
     * same current finding.
     *
     * Neither button is ever disabled: stepping wraps, so from any position
     * both directions have somewhere to go. The pair is absent instead of dead
     * when there is nothing to step through.
     *
     * Two things make it usable without a pointer. Each button carries a
     * `data-nav-step` identity so `render` can put the keyboard back on it
     * after the rebuild a step triggers, and a step queues the group's name
     * for the live region — the visible counter is `aria-hidden` and a
     * changing `aria-label` announces nothing.
     */
    private renderSectionNavigation(
        header: HTMLElement,
        binding: SidePanelBinding,
        state: EditorRunState,
        findings: readonly TrackedFinding[],
        currentFindingId: string | null
    ): void {
        const view = sectionNavigationView(
            findings,
            state.editorId,
            state.editorName,
            currentFindingId
        )
        if (!view.visible) {
            return
        }
        if (this.pendingStepEditorId === state.editorId) {
            this.pendingAnnouncement = view.groupAriaLabel
        }
        const nav = header.createDiv({ cls: 'editor-ai-daemons-panel-nav' })
        // A pair of arrows around a number is three unrelated elements read as
        // one run; `role=group` gives them a boundary and can carry a name (a
        // plain div cannot) — the same fix the scorecard member rows use.
        nav.setAttribute('role', 'group')
        nav.setAttribute('aria-label', view.groupAriaLabel)
        // The pill is an em dash before the first step, and a bare "—" with no
        // way to ask what it means is the sighted mirror of an unlabelled
        // control. The tooltip says the same sentence the group's name does.
        nav.title = view.groupAriaLabel
        this.addNavButton(nav, 'chevron-left', view, state.editorId, 'prev', () => {
            binding.stepEditorFinding(state.editorId, 'prev')
        })
        // Decorative: the group's accessible name already says the position,
        // and the rail marks its count badges the same way.
        nav.createSpan({
            cls: 'editor-ai-daemons-panel-nav-count',
            text: view.positionText
        }).setAttribute('aria-hidden', 'true')
        this.addNavButton(nav, 'chevron-right', view, state.editorId, 'next', () => {
            binding.stepEditorFinding(state.editorId, 'next')
        })
    }

    private addNavButton(
        nav: HTMLElement,
        icon: string,
        view: SectionNavigationView,
        editorId: string,
        direction: NavigationDirection,
        onStep: () => void
    ): void {
        const ariaLabel = direction === 'next' ? view.nextAriaLabel : view.previousAriaLabel
        const button = nav.createEl('button', {
            cls: 'editor-ai-daemons-panel-nav-button',
            attr: { 'type': 'button', 'data-nav-step': navFocusKey(editorId, direction) }
        })
        setIcon(button, icon)
        button.setAttribute('aria-label', ariaLabel)
        button.title = ariaLabel
        button.addEventListener('click', () => {
            // Remembered BEFORE the step so the render it triggers knows whose
            // position to announce. Cleared when that announcement is made.
            this.pendingStepEditorId = editorId
            onStep()
        })
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
        const row = section.createDiv({ cls: 'editor-ai-daemons-panel-bulk' })
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

    /**
     * "Generate more" (plan M6): one more pass by this editor, appended to
     * what it already reported. Sits under the bulk row because it is the
     * opposite move — bulk triage clears the list, this one extends it — and
     * the count in its label is the same list both act on.
     *
     * Deliberately NOT filtered by the severity lens: the lens hides findings
     * from view, it does not un-report them, and telling the editor it made
     * fewer findings than it did would invite it to repeat them.
     */
    private renderGenerateMore(
        section: HTMLElement,
        binding: SidePanelBinding,
        state: EditorRunState,
        findingCount: number
    ): void {
        const view = generateMoreView(state, findingCount)
        if (!view.visible) {
            return
        }
        const row = section.createDiv({ cls: 'editor-ai-daemons-panel-more' })
        const button = row.createEl('button', {
            cls: 'editor-ai-daemons-panel-more-button',
            text: view.text
        })
        button.setAttribute('aria-label', view.ariaLabel)
        button.disabled = view.disabled
        button.toggleClass('is-busy', view.busy)
        button.addEventListener('click', () => binding.continueEditor(state.editorId))
        if (view.error !== null) {
            // The completed pass is untouched, so this is a note beside the
            // button, never the section's error state.
            row.createSpan({
                cls: 'editor-ai-daemons-panel-more-error',
                text: `Could not generate more: ${view.error}`
            })
        }
    }

    private addBulkButton(
        row: HTMLElement,
        text: string,
        ariaLabel: string,
        onClick: () => void
    ): void {
        const button = row.createEl('button', { cls: 'editor-ai-daemons-panel-bulk-button', text })
        button.setAttribute('aria-label', ariaLabel)
        button.addEventListener('click', onClick)
    }

    /**
     * One finding row. `currentFindingId` is the file's shared triage cursor:
     * the row it names is marked, because otherwise "2 of 5" in the header
     * points at nothing inside the panel — the ring exists only in the editor
     * and on the rail, and the panel is where findings are read.
     */
    private renderFinding(
        list: HTMLElement,
        binding: SidePanelBinding,
        finding: TrackedFinding,
        clickable: boolean,
        currentFindingId: string | null
    ): void {
        const stale = finding.anchor?.state === 'stale'
        const current = !stale && finding.id === currentFindingId
        const item = list.createDiv({
            cls: `editor-ai-daemons-panel-finding${clickable && !stale ? ' is-clickable' : ''}${
                stale ? ' is-stale' : ''
            }${current ? ' is-current' : ''}${finding.carryover ? ' is-carryover' : ''}`
        })
        if (finding.carryover) {
            // Issue #19: a previous round's finding, kept on screen while the
            // re-review runs. Dimmed by CSS; named for assistive tech.
            item.setAttribute(
                'aria-description',
                'From the previous review — being checked by the running review'
            )
        }
        if (current) {
            // `aria-current` and not `aria-selected`: the row is not part of a
            // selection widget, it is the one item in the set the rest of the
            // plugin is currently pointed at.
            item.setAttribute('aria-current', 'true')
        }
        const iconEl = item.createSpan({
            cls: `editor-ai-daemons-panel-severity editor-ai-daemons-panel-severity-${finding.raw.severity}`
        })
        setIcon(iconEl, SEVERITY_ICONS[finding.raw.severity])
        // The severity was a coloured glyph and nothing else: the shape keeps
        // it off colour alone (WCAG 1.4.1), but an SVG from `setIcon` carries
        // no text, so assistive tech got no severity at all. `role=img` is
        // what makes a span nameable here.
        iconEl.setAttribute('role', 'img')
        iconEl.setAttribute('aria-label', SEVERITY_WORDS[finding.raw.severity])
        const body = item.createDiv({ cls: 'editor-ai-daemons-panel-finding-body' })
        body.createDiv({
            cls: 'editor-ai-daemons-panel-critique',
            text: truncate(finding.raw.critique, CRITIQUE_EXCERPT_MAX)
        })
        body.createDiv({
            cls: 'editor-ai-daemons-panel-quote',
            text: truncate(finding.raw.quote, QUOTE_EXCERPT_MAX)
        })
        if (stale) {
            body.createDiv({
                cls: 'editor-ai-daemons-panel-stale-note',
                text: 'Stale — the text changed since this finding was made.'
            })
        }
        if (clickable && !stale) {
            item.setAttribute('role', 'button')
            item.setAttribute('tabindex', '0')
            const reveal = (): void => binding.revealFinding(finding.id)
            item.addEventListener('click', () => {
                // Selecting text ends with a click on the row (issue #34):
                // jumping to the finding would re-render the panel and
                // destroy the selection the user just made. A click that
                // completes a non-collapsed selection inside this row is the
                // selection gesture, not a navigation request.
                const selection = item.ownerDocument.getSelection()
                if (
                    selection !== null &&
                    !selection.isCollapsed &&
                    selection.anchorNode !== null &&
                    item.contains(selection.anchorNode)
                ) {
                    return
                }
                reveal()
            })
            item.addEventListener('keydown', (event: KeyboardEvent) => {
                if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault()
                    reveal()
                }
            })
        }
    }
}
