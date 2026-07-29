import { MarkdownView, Modal, Notice, Setting } from 'obsidian'
import type { App, Editor, EditorPosition, Plugin, WorkspaceLeaf } from 'obsidian'
import type { Extension } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import type { ViewUpdate } from '@codemirror/view'
import { asFindingId } from '../domain/ids'
import type { FindingId } from '../domain/ids'
import type { PluginSettingsV1 } from '../domain/settings/settings-schema'
import { createSnapshot } from '../domain/snapshot'
import type { DocumentSnapshot } from '../domain/snapshot'
import { isExcluded } from '../services/context/exclusions'
import type { RunController, RunHandle } from '../services/orchestration/run-controller'
import type { EditorRunStatus } from '../services/orchestration/run-controller'
import { skipReasonLabel, startReview } from '../services/review-service'
import type { EditorSkip } from '../services/review-service'
import { changesFromTransaction } from './editor/changes-adapter'
import type { CardAcceptOutcome, FindingCardData, FindingLookup } from './editor/finding-card'
import { clearFindingsEffect, setFindingsEffect } from './editor/finding-decorations'
import type { FindingDecorationSpec } from './editor/finding-decorations'
import { PersonaRail } from './editor/rail'
import type { RailEditorState, RailEditorStatus } from './editor/rail-model'
import { ObsidianVaultReader } from './obsidian-vault-reader'
import { REVIEW_PANEL_VIEW_TYPE, ReviewSidePanelView } from './side-panel'
import type { SidePanelBinding } from './side-panel'

/**
 * Per-view glue between the review pipeline and the Obsidian editor UI:
 * mounts the persona rail on every markdown view, projects run findings into
 * the CM6 decoration field, forwards user edits to the run handle (anchor
 * remapping, Business Rules #3), and drives the side panel + status bar.
 *
 * Everything here is user-initiated: the only paths into `startReview` are
 * the Review command and the rail button (Business Rules #1).
 */

// ---------------------------------------------------------------------------
// CM6 access — the ONE place the private `editor.cm` is touched
// ---------------------------------------------------------------------------

/**
 * Obsidian's public API does not expose the CM6 `EditorView` behind
 * `MarkdownView.editor`; `editor.cm` is the long-standing community pattern
 * for reaching it. This accessor is the single sanctioned cast site: the
 * `instanceof` guard makes a future API change degrade to "no editor view"
 * (decorations simply not dispatched) instead of a crash.
 */
function editorViewOf(view: MarkdownView): EditorView | null {
    const cm = (view.editor as Editor & { cm?: unknown }).cm
    return cm instanceof EditorView ? cm : null
}

// ---------------------------------------------------------------------------
// Size-warning confirmation (window.confirm is forbidden — see AGENTS.md)
// ---------------------------------------------------------------------------

class SizeConfirmModal extends Modal {
    private readonly wordCount: number
    private readonly limit: number
    private readonly onConfirm: () => void

    constructor(app: App, wordCount: number, limit: number, onConfirm: () => void) {
        super(app)
        this.wordCount = wordCount
        this.limit = limit
        this.onConfirm = onConfirm
    }

    override onOpen(): void {
        this.setTitle('Review a large note?')
        this.modalEl.addClass('ai-editor-modal')
        this.contentEl.createEl('p', {
            text:
                `This note has about ${this.wordCount} words — above your size warning ` +
                `threshold of ${this.limit}. Reviewing it sends the full text to your ` +
                'configured AI backends, which may be slow or costly.'
        })
        new Setting(this.contentEl)
            .addButton((button) => {
                button.setButtonText('Cancel').onClick(() => this.close())
            })
            .addButton((button) => {
                button
                    .setButtonText('Review anyway')
                    .setCta()
                    .onClick(() => {
                        this.close()
                        this.onConfirm()
                    })
            })
    }

    override onClose(): void {
        this.contentEl.empty()
    }
}

// ---------------------------------------------------------------------------
// Controller
// ---------------------------------------------------------------------------

export interface ReviewControllerDeps {
    readonly app: App
    /** Owning plugin, for lifecycle-managed event registration. */
    readonly plugin: Plugin
    readonly getSettings: () => PluginSettingsV1
    readonly runController: RunController
    /** Status-bar projection (open finding count for the active note). */
    readonly setFindingCount: (count: number) => void
}

/** One markdown view's UI attachments. */
interface ViewGlue {
    readonly view: MarkdownView
    readonly railWrapperEl: HTMLElement
    readonly rail: PersonaRail
    filePath: string | null
    run: RunHandle | null
    unsubscribe: (() => void) | null
    /** Serialized last-dispatched decoration specs (skip no-op dispatches). */
    lastSpecsKey: string
}

const REVEAL_SELECTION_MS = 1_500

export class ReviewController {
    private readonly deps: ReviewControllerDeps
    private readonly vaultReader: ObsidianVaultReader
    private readonly glues = new Map<MarkdownView, ViewGlue>()
    private readonly skipsByFile = new Map<string, readonly EditorSkip[]>()
    private readonly pendingTimers = new Set<number>()
    /** Sticky: survives focus moving to the side panel itself. */
    private lastActiveMarkdownFile: string | null = null
    private refreshTimer: number | null = null
    private disposed = false

    constructor(deps: ReviewControllerDeps) {
        this.deps = deps
        this.vaultReader = new ObsidianVaultReader(deps.app)
    }

    /** Registers workspace listeners; call once from `onload`. */
    initialize(): void {
        const { plugin, app } = this.deps
        plugin.registerEvent(app.workspace.on('layout-change', () => this.scheduleRefresh()))
        plugin.registerEvent(
            app.workspace.on('active-leaf-change', () => {
                this.trackActiveFile()
                this.scheduleRefresh()
            })
        )
        plugin.registerEvent(
            app.workspace.on('file-open', () => {
                this.trackActiveFile()
                this.scheduleRefresh()
            })
        )
        app.workspace.onLayoutReady(() => {
            this.trackActiveFile()
            this.scheduleRefresh()
        })
    }

    /**
     * CM6 extension forwarding document changes of the run's own file to the
     * run handle, so anchors remap and intersecting edits go stale (Business
     * Rules #3/#4). Register once via `Plugin.registerEditorExtension`.
     *
     * Only the file's CANONICAL view forwards (see `canonicalGlueFor`):
     * Obsidian mirrors every edit into all panes showing the same file, so
     * the canonical view sees each change exactly once — its own edits,
     * mirrors of edits typed in other panes, and programmatic edits
     * (search-and-replace-all, other plugins, menu-driven undo). Focus is
     * deliberately NOT the criterion: programmatic edits happen without view
     * focus, and dropping them would leave every anchor on stale offsets —
     * with repeated text, an unforwarded edit can shift an identical
     * occurrence into a stale range and Accept's precondition would pass
     * against the WRONG occurrence (Business Rules #3/#4).
     */
    editorExtension(): Extension {
        return EditorView.updateListener.of((update) => this.handleEditorUpdate(update))
    }

    /** Tears down rails, subscriptions and timers; call from `onunload`. */
    dispose(): void {
        this.disposed = true
        if (this.refreshTimer !== null) {
            window.clearTimeout(this.refreshTimer)
            this.refreshTimer = null
        }
        for (const timer of this.pendingTimers) {
            window.clearTimeout(timer)
        }
        this.pendingTimers.clear()
        for (const glue of this.glues.values()) {
            this.destroyGlue(glue)
        }
        this.glues.clear()
    }

    /** Command availability: an open markdown file that is not excluded. */
    canReview(view: MarkdownView): boolean {
        const file = view.file
        if (!file) {
            return false
        }
        return !isExcluded(
            file.path,
            this.vaultReader.getNoteMetadata(file.path),
            this.deps.getSettings().behavior
        )
    }

    /**
     * Starts (or restarts) a review for the view's note. Snapshot is whole
     * note, selection-scoped when a selection exists. All refusals surface as
     * Notices; the size guard round-trips through an explicit confirmation.
     */
    async startReview(view: MarkdownView, confirmedLargeNote = false): Promise<void> {
        const file = view.file
        if (!file || this.disposed) {
            return
        }
        const snapshot = this.snapshotView(view, file.path)

        const result = await startReview({
            settings: this.deps.getSettings(),
            snapshot,
            vault: this.vaultReader,
            runController: this.deps.runController,
            fetchImpl: window.fetch.bind(window),
            confirmedLargeNote,
            // Called by the service synchronously right before the run
            // starts: edits typed while context assembly awaited vault reads
            // would otherwise be invisible to the run's remap history (the
            // run anchors against its snapshot, and edit forwarding only
            // starts once the run exists). Null when the view switched to
            // another note mid-await — the service then falls back to the
            // command-time snapshot.
            refreshSnapshot: (): DocumentSnapshot | null =>
                view.file?.path === file.path ? this.snapshotView(view, file.path) : null
        })

        switch (result.status) {
            case 'excluded':
                new Notice('This note is excluded from AI review by your privacy settings.')
                return
            case 'needs-confirmation':
                new SizeConfirmModal(this.deps.app, result.wordCount, result.limit, () => {
                    void this.startReview(view, true)
                }).open()
                return
            case 'no-editors': {
                const details = result.skips
                    .map((skip) => `${skip.editorName} — ${skipReasonLabel(skip.reason)}`)
                    .join('; ')
                new Notice(
                    details.length > 0
                        ? `No editor could run: ${details}`
                        : 'No enabled editors. Configure editors and a backend in the settings.'
                )
                return
            }
            case 'started':
                this.skipsByFile.set(file.path, result.skips)
                if (result.skips.length > 0) {
                    const details = result.skips
                        .map((skip) => `${skip.editorName} (${skipReasonLabel(skip.reason)})`)
                        .join(', ')
                    new Notice(`Skipped: ${details}`)
                }
                // Synchronous on purpose (NOT the deferred scheduleRefresh):
                // edit forwarding only covers edits made after the glue holds
                // the run, so `glue.run` must be bound in the same synchronous
                // block that started the run — no keystroke can interleave.
                // Safe here: this is a command/button continuation, never a
                // CM6 update cycle.
                this.refreshAll()
                void this.activateSidePanel()
                return
        }
    }

    /** Snapshot of the view's current text (selection-scoped when present). */
    private snapshotView(view: MarkdownView, filePath: string): DocumentSnapshot {
        const editor = view.editor
        const from = editor.posToOffset(editor.getCursor('from'))
        const to = editor.posToOffset(editor.getCursor('to'))
        return createSnapshot({
            filePath,
            text: editor.getValue(),
            ...(from !== to ? { selection: { from, to } } : {})
        })
    }

    /** Cancels the active run for the view's note (rail Cancel button). */
    cancelReview(view: MarkdownView): void {
        const path = view.file?.path
        if (!path) {
            return
        }
        this.deps.runController.getRun(path)?.cancelRun()
    }

    /** Opens (or reveals) the side panel leaf and pushes the current binding. */
    async activateSidePanel(): Promise<void> {
        const { workspace } = this.deps.app
        let leaf: WorkspaceLeaf | null =
            workspace.getLeavesOfType(REVIEW_PANEL_VIEW_TYPE)[0] ?? null
        if (!leaf) {
            leaf = workspace.getRightLeaf(false)
            if (!leaf) {
                return
            }
            await leaf.setViewState({ type: REVIEW_PANEL_VIEW_TYPE, active: true })
        }
        await workspace.revealLeaf(leaf)
        this.updatePanels()
    }

    /** Current side-panel binding for the (last) active markdown file. */
    getPanelBinding(): SidePanelBinding | null {
        const path = this.lastActiveMarkdownFile
        if (!path) {
            return null
        }
        const run = this.deps.runController.getRun(path)
        if (!run) {
            return null
        }
        const colors = this.editorColors()
        return {
            filePath: path,
            fileName: path.split('/').pop() ?? path,
            run,
            editors: run.getEditorStates().map((state) => ({
                id: state.editorId,
                name: state.editorName,
                color: colors.get(state.editorId) ?? 'var(--text-accent)'
            })),
            skips: this.skipsByFile.get(path) ?? [],
            revealFinding: (findingId: FindingId): void => {
                void this.revealFinding(path, findingId)
            }
        }
    }

    // -- Finding card lookup --------------------------------------------------

    /**
     * The resolution seam injected into `findingCardExtension` (registered
     * once alongside the decoration field in `plugin.ts`). Findings are
     * resolved by id across all runs — finding ids are UUIDs, so the card
     * never needs to know which file/run its clicked highlight belongs to.
     */
    findingLookup(): FindingLookup {
        return {
            getCardData: (findingId): FindingCardData | null => this.getCardData(findingId),
            acceptFinding: (findingId, currentText): CardAcceptOutcome =>
                this.acceptFinding(findingId, currentText),
            dismissFinding: (findingId): void => {
                this.dismissFinding(findingId)
            }
        }
    }

    /** Card content for one finding; `null` once terminal (card drops it). */
    private getCardData(rawId: string): FindingCardData | null {
        const id = asFindingId(rawId)
        const run = this.deps.runController.findRunWithFinding(id)
        const finding = run?.findings.get(id)
        if (!run || !finding) {
            return null
        }
        if (finding.status !== 'open' && finding.status !== 'preview') {
            return null
        }
        const editor = this.deps
            .getSettings()
            .editors.find((candidate) => candidate.id === finding.editorId)
        return {
            findingId: finding.id,
            editorName:
                editor?.name ?? run.getEditorState(finding.editorId)?.editorName ?? 'Editor',
            editorColor: editor?.color ?? 'var(--text-accent)',
            severity: finding.raw.severity,
            critique: finding.raw.critique,
            quote: finding.anchoredText ?? finding.raw.quote,
            suggestion: finding.raw.suggestion ?? null,
            acceptable: run.findings.isActionable(id)
        }
    }

    /**
     * Accept path (Business Rules #2/#3): `FindingStore.accept` re-verifies
     * the precondition against the CURRENT document text; only then is the
     * replacement returned for the card to dispatch as a regular undoable
     * transaction. The dispatched edit reaches the domain anchor store
     * through the canonical-view forwarding in `handleEditorUpdate` exactly
     * like any user edit — directly when the card's view is the canonical
     * one, via the mirrored transaction Obsidian dispatches into the
     * canonical view otherwise — so every other finding's anchor remaps
     * exactly once (intersecting anchors go stale per Business Rules #3).
     */
    private acceptFinding(rawId: string, currentText: string): CardAcceptOutcome {
        const id = asFindingId(rawId)
        const run = this.deps.runController.findRunWithFinding(id)
        if (!run) {
            return { ok: false }
        }
        const result = run.findings.accept(id, currentText)
        if (!result.ok) {
            this.scheduleRefresh()
            return { ok: false }
        }
        const { anchor, raw } = result.finding
        if (anchor === null || typeof raw.suggestion !== 'string') {
            // Unreachable after a successful accept; guarded for type safety.
            return { ok: false }
        }
        return { ok: true, from: anchor.from, to: anchor.to, insert: raw.suggestion }
    }

    /** Dismiss: terminal status; the refresh cycle drops its decoration. */
    private dismissFinding(rawId: string): void {
        const id = asFindingId(rawId)
        this.deps.runController.findRunWithFinding(id)?.findings.dismiss(id)
    }

    // -- Editor update forwarding --------------------------------------------

    /**
     * Forwards every document change of a file to its run exactly once: only
     * the file's canonical view forwards, and it forwards ALL doc-changing
     * transactions — regardless of focus, and including the review card's
     * Accept dispatch (marked by `removeFindingsEffect`). Non-canonical views
     * only ever see mirrors of transactions the canonical view also receives,
     * so they stay silent; skipping by focus instead would drop programmatic
     * edits (search-and-replace-all, other plugins, menu-driven undo) and
     * leave anchors on stale offsets (Business Rules #3/#4).
     */
    private handleEditorUpdate(update: ViewUpdate): void {
        if (this.disposed || !update.docChanged) {
            return
        }
        const glue = this.findGlueByEditorView(update.view)
        if (!glue || !glue.run || glue.filePath === null) {
            return
        }
        // The file shown by this view changed (doc-replacing transaction of a
        // note switch): never forward it to the previous note's run.
        if (glue.view.file?.path !== glue.filePath) {
            return
        }
        if (this.canonicalGlueFor(glue.filePath) !== glue) {
            return // non-canonical pane: the canonical view forwards this edit
        }
        for (const tr of update.transactions) {
            const changes = changesFromTransaction(tr)
            if (changes.length > 0) {
                glue.run.applyTextChanges(changes)
            }
        }
    }

    /**
     * The single view designated to forward edits for a file: the first
     * mounted glue (map insertion order — stable) whose refreshed and live
     * file paths both match. Every other view showing the same file receives
     * Obsidian's mirrors of the same edits and must not forward them.
     */
    private canonicalGlueFor(filePath: string): ViewGlue | null {
        for (const candidate of this.glues.values()) {
            if (candidate.filePath === filePath && candidate.view.file?.path === filePath) {
                return candidate
            }
        }
        return null
    }

    private findGlueByEditorView(editorView: EditorView): ViewGlue | null {
        for (const glue of this.glues.values()) {
            if (editorViewOf(glue.view) === editorView) {
                return glue
            }
        }
        return null
    }

    // -- Refresh cycle --------------------------------------------------------

    /**
     * Coalesced deferred refresh. Deferral is load-bearing: run notifications
     * fire synchronously from `applyTextChanges` inside a CM6 update cycle,
     * and dispatching decoration effects from there would re-enter
     * `EditorView.update`.
     */
    private scheduleRefresh(): void {
        if (this.disposed || this.refreshTimer !== null) {
            return
        }
        this.refreshTimer = window.setTimeout(() => {
            this.refreshTimer = null
            this.refreshAll()
        }, 0)
    }

    private refreshAll(): void {
        if (this.disposed) {
            return
        }
        this.syncGlues()
        for (const glue of this.glues.values()) {
            this.refreshGlue(glue)
        }
        this.updateStatusBar()
        this.updatePanels()
    }

    private syncGlues(): void {
        const seen = new Set<MarkdownView>()
        for (const leaf of this.deps.app.workspace.getLeavesOfType('markdown')) {
            const view = leaf.view
            if (!(view instanceof MarkdownView)) {
                continue // deferred leaf: attach once it materializes
            }
            seen.add(view)
            if (!this.glues.has(view)) {
                this.glues.set(view, this.createGlue(view))
            }
        }
        for (const [view, glue] of [...this.glues]) {
            if (!seen.has(view)) {
                this.destroyGlue(glue)
                this.glues.delete(view)
            }
        }
    }

    private createGlue(view: MarkdownView): ViewGlue {
        // Popout safety: every element is created via the view's own document.
        const doc = view.contentEl.ownerDocument
        view.contentEl.addClass('ai-editor-rail-host')
        const railWrapperEl = doc.createElement('div')
        railWrapperEl.classList.add('ai-editor-rail-wrapper')
        view.contentEl.appendChild(railWrapperEl)
        const rail = new PersonaRail(
            railWrapperEl,
            {
                onReview: (): void => {
                    void this.startReview(view)
                },
                onCancel: (): void => {
                    this.cancelReview(view)
                },
                onEditorClick: (): void => {
                    void this.activateSidePanel()
                }
            },
            doc
        )
        return {
            view,
            railWrapperEl,
            rail,
            filePath: null,
            run: null,
            unsubscribe: null,
            lastSpecsKey: ''
        }
    }

    private destroyGlue(glue: ViewGlue): void {
        glue.unsubscribe?.()
        glue.unsubscribe = null
        glue.rail.destroy()
        glue.railWrapperEl.remove()
        glue.view.contentEl.removeClass('ai-editor-rail-host')
    }

    private refreshGlue(glue: ViewGlue): void {
        const filePath = glue.view.file?.path ?? null
        const run = filePath ? this.deps.runController.getRun(filePath) : null
        if (glue.run !== run) {
            glue.unsubscribe?.()
            glue.unsubscribe = run ? run.subscribe(() => this.scheduleRefresh()) : null
            glue.run = run
            glue.lastSpecsKey = ''
        }
        glue.filePath = filePath

        // Rail only makes sense over an editable editor (Reading view is out
        // of scope for v1 interactions).
        glue.railWrapperEl.toggleClass('ai-editor-hidden', glue.view.getMode() === 'preview')
        glue.rail.render({
            editors: this.buildRailEditors(run),
            running: run !== null && !run.isSettled()
        })
        this.dispatchDecorations(glue, run)
    }

    private buildRailEditors(run: RunHandle | null): RailEditorState[] {
        const settings = this.deps.getSettings()
        return settings.editors
            .filter((editor) => editor.enabled && editor.capabilities.review)
            .map((editor) => {
                const state = run?.getEditorState(editor.id) ?? null
                return {
                    id: editor.id,
                    name: editor.name,
                    color: editor.color,
                    status: state ? railStatusOf(state.status) : 'idle',
                    findingCount: state ? state.findingIds.length : 0
                }
            })
    }

    private dispatchDecorations(glue: ViewGlue, run: RunHandle | null): void {
        const editorView = editorViewOf(glue.view)
        if (!editorView) {
            return
        }
        const specs = run ? this.buildDecorationSpecs(run) : []
        const key = JSON.stringify(specs)
        if (key === glue.lastSpecsKey) {
            return
        }
        glue.lastSpecsKey = key
        editorView.dispatch({
            effects:
                specs.length > 0 ? [setFindingsEffect.of(specs)] : [clearFindingsEffect.of(null)]
        })
    }

    private buildDecorationSpecs(run: RunHandle): FindingDecorationSpec[] {
        const colors = this.editorColors()
        const specs: FindingDecorationSpec[] = []
        for (const finding of run.findings.list()) {
            if (finding.anchor === null) {
                continue
            }
            if (finding.status !== 'open' && finding.status !== 'preview') {
                continue
            }
            specs.push({
                findingId: finding.id,
                editorId: finding.editorId,
                from: finding.anchor.from,
                to: finding.anchor.to,
                color: colors.get(finding.editorId) ?? 'var(--text-accent)',
                stale: finding.anchor.state === 'stale'
            })
        }
        return specs
    }

    private editorColors(): Map<string, string> {
        return new Map(this.deps.getSettings().editors.map((editor) => [editor.id, editor.color]))
    }

    // -- Ambient surfaces -----------------------------------------------------

    private trackActiveFile(): void {
        const view = this.deps.app.workspace.getActiveViewOfType(MarkdownView)
        if (view?.file) {
            this.lastActiveMarkdownFile = view.file.path
        }
    }

    private updateStatusBar(): void {
        const path = this.lastActiveMarkdownFile
        const run = path ? this.deps.runController.getRun(path) : null
        const count = run
            ? run.findings
                  .list()
                  .filter((finding) => finding.status === 'open' || finding.status === 'preview')
                  .length
            : 0
        this.deps.setFindingCount(count)
    }

    private updatePanels(): void {
        const binding = this.getPanelBinding()
        for (const leaf of this.deps.app.workspace.getLeavesOfType(REVIEW_PANEL_VIEW_TYPE)) {
            const view = leaf.view
            if (view instanceof ReviewSidePanelView) {
                view.setBinding(binding)
            }
        }
    }

    // -- Reveal from the side panel ------------------------------------------

    private async revealFinding(filePath: string, findingId: FindingId): Promise<void> {
        const run = this.deps.runController.getRun(filePath)
        const finding = run?.findings.get(findingId) ?? null
        if (!finding || finding.anchor === null || finding.anchor.state !== 'anchored') {
            return
        }
        let view = this.findMarkdownView(filePath)
        if (!view) {
            const file = this.deps.app.vault.getFileByPath(filePath)
            if (!file) {
                return
            }
            await this.deps.app.workspace.getLeaf(false).openFile(file)
            view = this.findMarkdownView(filePath)
        }
        if (!view || this.disposed) {
            return
        }
        await this.deps.app.workspace.revealLeaf(view.leaf)
        const editor = view.editor
        const docLength = editor.getValue().length
        const from = Math.min(finding.anchor.from, docLength)
        const to = Math.min(finding.anchor.to, docLength)
        const fromPos = editor.offsetToPos(from)
        const toPos = editor.offsetToPos(to)
        editor.setSelection(fromPos, toPos)
        editor.scrollIntoView({ from: fromPos, to: toPos }, true)
        editor.focus()
        // Brief selection: collapse after a moment, unless the user moved it.
        const timer = window.setTimeout(() => {
            this.pendingTimers.delete(timer)
            if (this.disposed) {
                return
            }
            if (
                posEquals(editor.getCursor('from'), fromPos) &&
                posEquals(editor.getCursor('to'), toPos)
            ) {
                editor.setSelection(fromPos)
            }
        }, REVEAL_SELECTION_MS)
        this.pendingTimers.add(timer)
    }

    private findMarkdownView(filePath: string): MarkdownView | null {
        const active = this.deps.app.workspace.getActiveViewOfType(MarkdownView)
        if (active?.file?.path === filePath) {
            return active
        }
        for (const leaf of this.deps.app.workspace.getLeavesOfType('markdown')) {
            const view = leaf.view
            if (view instanceof MarkdownView && view.file?.path === filePath) {
                return view
            }
        }
        return null
    }
}

function railStatusOf(status: EditorRunStatus): RailEditorStatus {
    switch (status) {
        case 'pending':
        case 'running':
            return 'running'
        case 'done':
            return 'done'
        case 'error':
            return 'error'
        case 'cancelled':
            return 'idle'
    }
}

function posEquals(a: EditorPosition, b: EditorPosition): boolean {
    return a.line === b.line && a.ch === b.ch
}
