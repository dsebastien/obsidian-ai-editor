import { ItemView, setIcon } from 'obsidian'
import type { WorkspaceLeaf } from 'obsidian'
import type { FindingId } from '../domain/ids'
import type { Severity } from '../domain/operations/contract'
import type { TrackedFinding } from '../services/orchestration/finding-store'
import type { EditorRunState, RunHandle } from '../services/orchestration/run-controller'
import type { EditorSkip } from '../services/review-service'
import { skipReasonLabel } from '../services/review-service'

/**
 * Side panel (`ItemView` workspace leaf): the list view over the active
 * file's review run — per-editor status sections, findings (anchored ones
 * click through to the editor span, unanchored ones grouped separately),
 * summaries/verdicts, and the skip report.
 *
 * The view is deliberately dumb: the `ReviewController` computes a
 * `SidePanelBinding` (run handle + display metadata + reveal callback) and
 * pushes it via `setBinding`; the panel subscribes to the run handle itself
 * for live updates while bound. All DOM goes through `createEl`/`createDiv`
 * (never `innerHTML`) on `contentEl`, so popout placement is safe.
 */

export const REVIEW_PANEL_VIEW_TYPE = 'ai-editor-review'

export interface SidePanelEditorInfo {
    readonly id: string
    readonly name: string
    readonly color: string
}

export interface SidePanelBinding {
    readonly filePath: string
    readonly fileName: string
    readonly run: RunHandle
    readonly editors: readonly SidePanelEditorInfo[]
    readonly skips: readonly EditorSkip[]
    readonly revealFinding: (findingId: FindingId) => void
}

/** Pulls the current binding when the panel (re)opens or refreshes itself. */
export type SidePanelBindingProvider = () => SidePanelBinding | null

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

function verdictLabel(verdict: NonNullable<EditorRunState['verdict']>): string {
    switch (verdict) {
        case 'publish':
            return 'Publish'
        case 'needs-work':
            return 'Needs work'
        case 'kill':
            return 'Kill'
    }
}

export class ReviewSidePanelView extends ItemView {
    private readonly provider: SidePanelBindingProvider
    private binding: SidePanelBinding | null = null
    private unsubscribe: (() => void) | null = null

    constructor(leaf: WorkspaceLeaf, provider: SidePanelBindingProvider) {
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
        this.setBinding(this.provider())
        return Promise.resolve()
    }

    override onClose(): Promise<void> {
        this.unsubscribe?.()
        this.unsubscribe = null
        this.binding = null
        return Promise.resolve()
    }

    /**
     * Binds the panel to a run (or clears it). Re-subscribes only when the
     * run handle actually changed, so streaming updates keep flowing while
     * the controller pushes refreshed bindings for the same run.
     */
    setBinding(binding: SidePanelBinding | null): void {
        if (this.binding?.run !== binding?.run) {
            this.unsubscribe?.()
            this.unsubscribe = binding ? binding.run.subscribe(() => this.render()) : null
        }
        this.binding = binding
        this.render()
    }

    private render(): void {
        const { contentEl } = this
        contentEl.empty()
        const root = contentEl.createDiv({ cls: 'ai-editor-panel' })

        const binding = this.binding
        if (!binding) {
            root.createDiv({
                cls: 'ai-editor-panel-empty',
                text: 'No review yet. Open a note and run “Review current note”.'
            })
            return
        }

        root.createDiv({ cls: 'ai-editor-panel-file', text: binding.fileName })

        this.renderSkips(root, binding.skips)

        const colorById = new Map(binding.editors.map((editor) => [editor.id, editor.color]))
        for (const state of binding.run.getEditorStates()) {
            this.renderEditorSection(root, binding, state, colorById.get(state.editorId) ?? '')
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
        color: string
    ): void {
        const section = root.createEl('section', { cls: 'ai-editor-panel-section' })

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

        if (state.error !== null) {
            section.createDiv({
                cls: 'ai-editor-panel-error',
                text: `${state.error.code}: ${state.error.message}`
            })
        }

        if (state.summary !== null && state.summary.length > 0) {
            section.createDiv({ cls: 'ai-editor-panel-summary', text: state.summary })
        }

        const findings = state.findingIds
            .map((id) => binding.run.findings.get(id))
            .filter((finding): finding is TrackedFinding => finding !== null)
            .filter((finding) => finding.status === 'open' || finding.status === 'preview')
        const anchored = findings.filter((finding) => finding.anchor !== null)
        const unanchored = findings.filter((finding) => finding.anchor === null)

        if (findings.length === 0 && state.status === 'done') {
            section.createDiv({ cls: 'ai-editor-panel-none', text: 'Nothing to report.' })
        }

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
