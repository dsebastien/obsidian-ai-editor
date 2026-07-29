import { MarkdownView, Modal, Notice, Setting, TFile } from 'obsidian'
import type { App, Editor, EditorPosition, Plugin, WorkspaceLeaf } from 'obsidian'
import type { Extension } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import type { ViewUpdate } from '@codemirror/view'
import { navigableFindings, stepFinding } from '../commands/finding-navigation'
import type { NavigationDirection } from '../commands/finding-navigation'
import { asFindingId } from '../domain/ids'
import type { FindingId } from '../domain/ids'
import type { PluginSettingsV1 } from '../domain/settings/settings-schema'
import { createSnapshot, hashText } from '../domain/snapshot'
import type { DocumentSnapshot } from '../domain/snapshot'
import { isReviewable, reviewCapableEditors } from '../services/reviewability'
import type {
    EditorRunStatus,
    RetryEditorResult,
    RunController,
    RunHandle
} from '../services/orchestration/run-controller'
import { skipReasonLabel, startReview } from '../services/review-service'
import type { EditorSkip, RunInstruction } from '../services/review-service'
import { AskEditorModal } from './ask-editor-modal'
import { changesFromTransaction } from './editor/changes-adapter'
import type { CardAcceptOutcome, FindingCardData, FindingLookup } from './editor/finding-card'
import {
    clearFindingsEffect,
    markStaleEffect,
    setFindingsEffect
} from './editor/finding-decorations'
import type { FindingDecorationSpec } from './editor/finding-decorations'
import { newlyStaleIds, staleIds } from './editor/stale-diff'
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

/**
 * How `snapshotView` treats a live selection: `auto` embeds it when non-empty
 * (the legacy behavior of the Review command and the rail button — a selected
 * range scopes the review), `whole-note` ignores it (explicit whole-note
 * surfaces: the file context menu's "Review note" and the CLI, where a
 * selection the user happens to have open must not silently narrow the run).
 */
type SnapshotScope = 'auto' | 'whole-note'

/**
 * Caller-captured selection riding into the review pipeline. `capturedHash`
 * is filled by `startReview` from the first snapshot (capture and snapshot
 * happen in the same synchronous block) and carried unchanged through the
 * size-confirmation round trip so the service validates against the text the
 * offsets were actually captured on.
 */
interface RequestedSelection {
    readonly from: number
    readonly to: number
    readonly capturedHash?: string
}

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
        // Runs and skip reports are keyed by file path, so both must follow the
        // file: without these, a renamed file orphans its run (holding the full
        // snapshot text forever) and a deleted file leaves skip notices that a
        // later, unrelated run on the same path would inherit.
        plugin.registerEvent(
            app.vault.on('rename', (file, oldPath) => {
                if (!(file instanceof TFile)) {
                    return
                }
                this.deps.runController.discardRun(oldPath)
                this.skipsByFile.delete(oldPath)
                if (this.lastActiveMarkdownFile === oldPath) {
                    this.lastActiveMarkdownFile = file.path
                }
                this.scheduleRefresh()
            })
        )
        plugin.registerEvent(
            app.vault.on('delete', (file) => {
                this.deps.runController.discardRun(file.path)
                this.skipsByFile.delete(file.path)
                if (this.lastActiveMarkdownFile === file.path) {
                    this.lastActiveMarkdownFile = null
                }
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

    /**
     * Command availability: an open markdown file that is not excluded AND at
     * least one enabled review-capable editor whose backend resolves (shared
     * `isReviewable` predicate — command gates, menus and the CLI all agree
     * with what `startReview` would refuse).
     */
    canReview(view: MarkdownView): boolean {
        const file = view.file
        if (!file) {
            return false
        }
        return this.canReviewPath(file.path)
    }

    /**
     * Same predicate for a note that may not be open in any view (file
     * context menu, CLI): metadata is read through the vault reader, so a
     * closed note fails closed exactly like `startReview` would.
     */
    canReviewPath(path: string): boolean {
        return isReviewable(path, this.vaultReader.getNoteMetadata(path), this.deps.getSettings())
    }

    /**
     * Starts (or restarts) a review for the view's note. Snapshot is whole
     * note, selection-scoped when a selection exists. All refusals surface as
     * Notices; the size guard round-trips through an explicit confirmation.
     *
     * `requestedSelection` implements the selection-capture contract for
     * selection-scoped surfaces (context menu, Review selection command): the
     * caller captures the range synchronously in its own callback and the
     * service re-validates it against the fresh snapshot at run start,
     * falling back to whole-note scope (with a Notice) when it went stale.
     */
    async startReview(
        view: MarkdownView,
        confirmedLargeNote = false,
        requestedSelection?: RequestedSelection,
        scope: SnapshotScope = 'auto',
        instruction?: RunInstruction
    ): Promise<void> {
        const file = view.file
        if (!file || this.disposed) {
            return
        }
        const snapshot = this.snapshotView(view, file.path, scope)
        // Capture-time baseline for the selection re-validation: on the FIRST
        // invocation this snapshot is taken in the same synchronous block as
        // the selection capture, so its hash IS the capture-time hash. The
        // size-confirmation retry passes the filled object back in, so the
        // ORIGINAL hash survives the round trip — re-deriving it from the
        // post-modal snapshot would validate stale offsets against themselves.
        const requested = requestedSelection
            ? {
                  ...requestedSelection,
                  capturedHash: requestedSelection.capturedHash ?? snapshot.hash
              }
            : undefined

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
                view.file?.path === file.path ? this.snapshotView(view, file.path, scope) : null,
            ...(requested ? { requestedSelection: requested } : {}),
            ...(instruction ? { instruction } : {})
        })

        switch (result.status) {
            case 'excluded':
                new Notice('This note is excluded from AI review by your privacy settings.')
                return
            case 'needs-confirmation':
                new SizeConfirmModal(this.deps.app, result.wordCount, result.limit, () => {
                    // The originally captured selection rides along WITH its
                    // capture-time hash; the service re-validates it after
                    // the confirmation delay and falls back to whole-note
                    // scope when the note was edited meanwhile. A per-run
                    // instruction survives the round trip unchanged.
                    void this.startReview(view, true, requested, scope, instruction)
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
                if (result.selectionFallback) {
                    new Notice('Selection changed — reviewing the whole note')
                }
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

    /**
     * Whole-note review entry for surfaces not bound to an open view (file
     * context menu "Review note"): opens the file in a markdown view when it
     * is not already open, then dispatches through the exact same
     * `startReview` path as the "Review current note" command — explicitly
     * whole-note: a live selection in the opened view must not silently
     * narrow the review the user asked for from the file menu (design §2).
     */
    async reviewFile(filePath: string): Promise<void> {
        const view = await this.openMarkdownView(filePath)
        if (!view) {
            return
        }
        await this.startReview(view, false, undefined, 'whole-note')
    }

    /**
     * Snapshot of the view's current text; `auto` scope embeds a non-empty
     * live selection, `whole-note` ignores it (see `SnapshotScope`).
     */
    private snapshotView(
        view: MarkdownView,
        filePath: string,
        scope: SnapshotScope = 'auto'
    ): DocumentSnapshot {
        const editor = view.editor
        const from = editor.posToOffset(editor.getCursor('from'))
        const to = editor.posToOffset(editor.getCursor('to'))
        const selectionScoped = scope === 'auto' && from !== to
        return createSnapshot({
            filePath,
            text: editor.getValue(),
            ...(selectionScoped ? { selection: { from, to } } : {})
        })
    }

    /**
     * Selection-capture contract entry (design §1) shared by the editor
     * context menu and the `Review selection` command: the selection range is
     * read synchronously in the invoking callback and rides into the review
     * pipeline as `requestedSelection`; the service re-validates it against
     * the fresh snapshot at run start and falls back to whole-note scope
     * (with a Notice) when it went stale. If the selection collapsed between
     * gating and dispatch, there is no range to request — the review runs on
     * the whole note.
     */
    startSelectionReview(view: MarkdownView, editor: Editor): void {
        const from = editor.posToOffset(editor.getCursor('from'))
        const to = editor.posToOffset(editor.getCursor('to'))
        if (from === to) {
            void this.startReview(view)
            return
        }
        void this.startReview(view, false, { from, to })
    }

    /**
     * Freeform "Ask an editor" entry (design §6 decision 1), shared by the
     * editor context menu and the `Ask an editor` command. The selection AND
     * its capture-time hash are read synchronously HERE, in the invoking
     * callback — the modal introduces an arbitrarily long gap before
     * dispatch, so unlike `startSelectionReview` the capture-time hash cannot
     * be derived from the dispatch-time snapshot (the service would validate
     * stale offsets against themselves). On submit the review runs through
     * the exact same `startReview` path, narrowed to the chosen editor with
     * its prompt augmented for this run only; a selection invalidated while
     * the modal was open falls back to whole-note scope with the usual
     * Notice. A collapsed selection at capture time (gate raced the click)
     * simply asks about the whole note — dispatch uses `whole-note` scope,
     * so a selection made WHILE the modal was open can never silently narrow
     * the run (a valid captured selection still overrides it explicitly; the
     * selection-capture contract, design §1, stays the only scoping path).
     * If the view switched to a different note while the modal was open
     * (programmatic openFile, workspace restore), the submit is refused with
     * a Notice — the instruction was written about the captured note, and
     * dispatching it against whatever note replaced it would silently
     * redirect user intent.
     */
    openAskEditorModal(view: MarkdownView, editor: Editor): void {
        if (!view.file || this.disposed) {
            return
        }
        const capturedPath = view.file.path
        const choices = reviewCapableEditors(this.deps.getSettings()).map((candidate) => ({
            id: candidate.id,
            name: candidate.name
        }))
        if (choices.length === 0) {
            // Unreachable behind the `canReviewSelection` gates; fail closed.
            return
        }
        const from = editor.posToOffset(editor.getCursor('from'))
        const to = editor.posToOffset(editor.getCursor('to'))
        const requested: RequestedSelection | undefined =
            from !== to ? { from, to, capturedHash: hashText(editor.getValue()) } : undefined
        new AskEditorModal(this.deps.app, choices, (editorId, instruction) => {
            if (view.file?.path !== capturedPath) {
                new Notice('The note changed while the dialog was open — ask cancelled.')
                return
            }
            void this.startReview(view, false, requested, 'whole-note', {
                editorId,
                text: instruction
            })
        }).open()
    }

    // -- CLI dispatch seam ----------------------------------------------------

    /**
     * Live-buffer snapshot machinery for a CLI-dispatched run
     * (`cli/register-review-cli.ts`): when the note is open in a markdown
     * view, the CLI must review the editor buffer, not the saved vault state
     * — the buffer may hold unsaved edits, and a run opened on vault text
     * would compute anchors/decorations against different offsets than the
     * document the view displays. Whole-note on purpose: CLI v1 has no
     * selection scope, so a live selection must not silently narrow the run.
     * `null` when the note is not open in any view (the CLI then reviews the
     * vault state and discards the run after reporting).
     */
    cliRunBinding(filePath: string): {
        snapshot: DocumentSnapshot
        refreshSnapshot: () => DocumentSnapshot | null
    } | null {
        const view = this.findMarkdownView(filePath)
        if (!view || view.file?.path !== filePath) {
            return null
        }
        return {
            snapshot: this.snapshotView(view, filePath, 'whole-note'),
            refreshSnapshot: (): DocumentSnapshot | null =>
                view.file?.path === filePath
                    ? this.snapshotView(view, filePath, 'whole-note')
                    : null
        }
    }

    /**
     * Binds a run started outside the controller (CLI) to the view glue. Must
     * run synchronously in the same block that started the run — the exact
     * rationale of the `started` branch in `startReview`: edit forwarding
     * (`handleEditorUpdate`) only covers edits made after `glue.run` is
     * bound, and nothing else refreshes until an unrelated workspace event.
     * Also records the run's skip report so the side panel shows it like any
     * command-started run. Does NOT force the side panel open — a script
     * invocation should not rearrange the workspace.
     */
    bindCliRun(filePath: string, skips: readonly EditorSkip[]): void {
        if (this.disposed) {
            return
        }
        this.skipsByFile.set(filePath, skips)
        this.refreshAll()
    }

    /** Whether the note is open in some markdown view (CLI run retention). */
    hasOpenMarkdownView(filePath: string): boolean {
        return this.findMarkdownView(filePath) !== null
    }

    /** Cancels the active run for the view's note (rail Cancel button). */
    cancelReview(view: MarkdownView): void {
        const path = view.file?.path
        if (!path) {
            return
        }
        this.deps.runController.getRun(path)?.cancelRun()
    }

    /**
     * Per-editor retry entry shared by the rail chip and the side-panel
     * section header: re-runs ONE failed/cancelled editor inside the note's
     * EXISTING run. The fresh anchor-base text is the CURRENT live buffer of
     * the canonical view, read synchronously in the same block as the retry
     * start so no keystroke can interleave between capture and the resumed
     * per-editor edit recording (Business Rules #3/#4 — edit forwarding is
     * already active because the run stays bound to the view glue after
     * settle). Without an open view (run kept alive for the panel after the
     * note was closed) the vault state IS the current text; no forwarding
     * happens without a view, and Accept re-verifies against the live text
     * anyway.
     */
    retryEditor(filePath: string, editorId: string): void {
        if (this.disposed) {
            return
        }
        const run = this.deps.runController.getRun(filePath)
        if (!run) {
            return
        }
        const view = this.findMarkdownView(filePath)
        if (view && view.file?.path === filePath) {
            this.reportRetry(run.retryEditor(editorId, view.editor.getValue()))
            return
        }
        void this.vaultReader.readNote(filePath).then((text) => {
            if (this.disposed || text === null) {
                return
            }
            // The run may have been replaced or discarded during the await.
            if (this.deps.runController.getRun(filePath) !== run) {
                return
            }
            this.reportRetry(run.retryEditor(editorId, text))
        })
    }

    /** Retry refusals surface as a Notice; success updates via run notify. */
    private reportRetry(result: RetryEditorResult): void {
        if (!result.ok) {
            new Notice('This editor cannot be retried right now.')
        }
    }

    /**
     * The run bound to the (last) active markdown file, if any — the run the
     * ambient surfaces follow. Command gates (`Cancel review`) read run state
     * through this instead of duplicating the sticky-file resolution.
     */
    getActiveRun(): RunHandle | null {
        const path = this.resolveActiveFilePath()
        return path ? this.deps.runController.getRun(path) : null
    }

    /** `Next/previous finding` gate: the active run has revealable findings. */
    canNavigateFindings(): boolean {
        const run = this.getActiveRun()
        return run !== null && navigableFindings(run.findings.list()).length > 0
    }

    /**
     * Steps to the next/previous navigable finding of the active file's run,
     * ordered by anchor position with wrap-around (pure logic in
     * `finding-navigation.ts`). The step is cursor-relative when the note is
     * open in an editor; the reveal then moves the cursor onto the target, so
     * repeated invocations cycle through all findings.
     */
    navigateFinding(direction: NavigationDirection): void {
        const path = this.resolveActiveFilePath()
        const run = path ? this.deps.runController.getRun(path) : null
        if (!path || !run) {
            return
        }
        const ordered = navigableFindings(run.findings.list())
        const view = this.findMarkdownView(path)
        const cursorOffset =
            view && view.file?.path === path
                ? view.editor.posToOffset(view.editor.getCursor('from'))
                : null
        const target = stepFinding(ordered, cursorOffset, direction)
        if (!target) {
            return
        }
        void this.revealFinding(path, asFindingId(target.id))
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
        const path = this.resolveActiveFilePath()
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
            },
            retryEditor: (editorId: string): void => {
                this.retryEditor(path, editorId)
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
        // Incremental stale-marking (M3): the FindingStore is the staleness
        // authority — snapshot which findings are stale before forwarding the
        // batch, diff after, and dim exactly the transitioned ones in place.
        const staleBefore = staleIds(glue.run.findings.list())
        let forwarded = false
        for (const tr of update.transactions) {
            const changes = changesFromTransaction(tr)
            if (changes.length > 0) {
                glue.run.applyTextChanges(changes)
                forwarded = true
            }
        }
        if (!forwarded) {
            return
        }
        const wentStale = newlyStaleIds(staleBefore, glue.run.findings.list())
        if (wentStale.length === 0) {
            return
        }
        // CM6 forbids dispatching from within an update listener (it would
        // re-enter `EditorView.update`), so the effect goes out on a
        // microtask — still ahead of the deferred `scheduleRefresh` rebuild
        // (setTimeout 0), which remains the eventual-consistency backstop.
        // Safe without further guards: dispatch on a destroyed EditorView is
        // a CM6 no-op, and `markStaleEffect` ignores ids the decoration set
        // no longer holds (note switch, cleared run).
        const editorView = update.view
        queueMicrotask(() => {
            if (this.disposed) {
                return
            }
            editorView.dispatch({ effects: markStaleEffect.of(wentStale) })
        })
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
                },
                onRetry: (editorId): void => {
                    // Resolve the path at click time: the view may have
                    // switched notes since the rail was mounted.
                    const path = view.file?.path
                    if (path) {
                        this.retryEditor(path, editorId)
                    }
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

    /**
     * The file whose run the ambient surfaces (status bar, side panel) follow.
     *
     * Sticky tracking is event-fed, so it is empty until the first
     * leaf/file-open event: right after a plugin (re)load, or when a review is
     * started programmatically (CLI, another plugin) without the workspace
     * emitting anything, the live active view is the only source of truth.
     * Both ambient surfaces must use this — reading `lastActiveMarkdownFile`
     * directly is what left the status-bar counter blank with findings on
     * screen.
     */
    private resolveActiveFilePath(): string | null {
        if (this.lastActiveMarkdownFile) {
            return this.lastActiveMarkdownFile
        }
        const view = this.deps.app.workspace.getActiveViewOfType(MarkdownView)
        this.lastActiveMarkdownFile = view?.file?.path ?? null
        return this.lastActiveMarkdownFile
    }

    private updateStatusBar(): void {
        const path = this.resolveActiveFilePath()
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
        const view = await this.openMarkdownView(filePath)
        if (!view) {
            return
        }
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
            // The leaf may have closed, switched file, or entered reading mode
            // in the meantime: touching a detached editor can throw, and moving
            // the cursor in a view that now shows a different note is worse.
            const current = this.findMarkdownView(filePath)
            if (!current || current.editor !== editor || current.file?.path !== filePath) {
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

    /**
     * Finds a markdown view showing `filePath`, opening the file in a new
     * leaf when none exists, and reveals the leaf. Shared by every surface
     * that must land the user on the note (side-panel reveal, file context
     * menu). `null` when the file does not exist or the controller was
     * disposed while awaiting.
     */
    private async openMarkdownView(filePath: string): Promise<MarkdownView | null> {
        let view = this.findMarkdownView(filePath)
        if (!view) {
            const file = this.deps.app.vault.getFileByPath(filePath)
            if (!file) {
                return null
            }
            await this.deps.app.workspace.getLeaf(false).openFile(file)
            view = this.findMarkdownView(filePath)
        }
        if (!view || this.disposed) {
            return null
        }
        await this.deps.app.workspace.revealLeaf(view.leaf)
        return view
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
            // Distinct from 'idle' so the rail can offer the per-editor
            // retry affordance on cancelled editors too.
            return 'cancelled'
    }
}

function posEquals(a: EditorPosition, b: EditorPosition): boolean {
    return a.line === b.line && a.ch === b.ch
}
