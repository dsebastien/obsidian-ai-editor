import { MarkdownView, Modal, Notice, Setting, TFile, setTooltip } from 'obsidian'
import type { App, Editor, EditorPosition, Plugin, WorkspaceLeaf } from 'obsidian'
import { isolateHistory } from '@codemirror/commands'
import { Prec } from '@codemirror/state'
import type { Extension } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import type { ViewUpdate } from '@codemirror/view'
import {
    cycleFinding,
    navigableEditorFindings,
    navigableFindings,
    rebaseTriageMemory,
    stepFinding,
    triageCurrent,
    triageStep
} from '../commands/finding-navigation'
import type {
    NavigationDirection,
    NavigationTarget,
    TriageMemory
} from '../commands/finding-navigation'
import { TriageCursorStore } from '../commands/triage-cursor'
import {
    bulkAcceptNotice,
    bulkDismissNotice,
    dismissableFindingIds,
    planBulkAccept
} from '../commands/bulk-triage'
import { getBuiltInVerb } from '../domain/actions/verb-registry'
import { wordDiff } from '../domain/diff/word-diff'
import type { DiffSegment } from '../domain/diff/word-diff'
import { asFindingId } from '../domain/ids'
import type { FindingId } from '../domain/ids'
import type { PluginSettingsV1 } from '../domain/settings/settings-schema'
import { createSnapshot, hashText } from '../domain/snapshot'
import type { DocumentSnapshot } from '../domain/snapshot'
import { resolveActionById, resolveCustomInstruction } from '../services/actions/action-resolution'
import type { ResolvedAction } from '../services/actions/action-resolution'
import { isExcluded, isReviewable, reviewCapableEditors } from '../services/reviewability'
import type { TrackedFinding } from '../services/orchestration/finding-store'
import type {
    EditorRunStatus,
    RetryEditorResult,
    RunController,
    RunHandle,
    ThreadTurnResolution
} from '../services/orchestration/run-controller'
import type {
    TransformController,
    TransformOutcome,
    TransformRunHandle
} from '../services/orchestration/transform-run'
import { countWords, skipReasonLabel, startReview } from '../services/review-service'
import type { EditorSkip, RunInstruction } from '../services/review-service'
import { startThreadTurn } from '../services/thread-service'
import { startAction } from '../services/transform-service'
import { AskEditorModal } from './ask-editor-modal'
import type { DaemonController } from './daemon-controller'
import { changesFromTransaction } from './editor/changes-adapter'
import {
    refreshFindingCardEffect,
    showFindingCardEffect,
    threadRefusalNotice
} from './editor/finding-card'
import type { CardAcceptOutcome, FindingCardData, FindingLookup } from './editor/finding-card'
import {
    clearFindingsEffect,
    emphasizeEditorEffect,
    markStaleEffect,
    removeFindingsEffect,
    setFindingsEffect
} from './editor/finding-decorations'
import type { FindingDecorationSpec } from './editor/finding-decorations'
import { nextLayoutMode } from './editor/layout-mode'
import type { PaneLayoutMode } from './editor/layout-mode'
import { newlyStaleIds, staleIds } from './editor/stale-diff'
import { clearTransformPreviewEffect, showTransformPreviewEffect } from './editor/transform-preview'
import type { TransformPreviewSpec } from './editor/transform-preview'
import { PersonaRail } from './editor/rail'
import { chipClickAction, railErrorReason } from './editor/rail-model'
import type { RailEditorState, RailEditorStatus } from './editor/rail-model'
import { ObsidianVaultReader } from './obsidian-vault-reader'
import { SeverityFilterStore, passesSeverityFilter, severityFilterNotice } from './severity-filter'
import type { SeverityFilterMode } from './severity-filter'
import { REVIEW_PANEL_VIEW_TYPE, ReviewSidePanelView } from './side-panel'
import type { SidePanelBinding } from './side-panel'

/**
 * Per-view glue between the review pipeline and the Obsidian editor UI:
 * mounts the persona rail on every markdown view, projects run findings into
 * the CM6 decoration field, forwards user edits to the run handle (anchor
 * remapping, Business Rules #3), and drives the side panel + status bar.
 *
 * Everything here is user-authorized (Business Rules #1): the paths into
 * `startReview` are the Review command/rail button/menus/CLI — plus daemon
 * refreshes via `startDaemonReview`, authorized by the explicit
 * `behavior.daemonMode` opt-in (the rule's documented carve-out).
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

/** Copy variants for the size-warning modal (reviews vs bound actions). */
interface SizeConfirmLabels {
    readonly title: string
    /** Sentence subject: "Reviewing it" / "Running it". */
    readonly action: string
    readonly cta: string
}

const REVIEW_SIZE_LABELS: SizeConfirmLabels = {
    title: 'Review a large note?',
    action: 'Reviewing it',
    cta: 'Review anyway'
}

const ACTION_SIZE_LABELS: SizeConfirmLabels = {
    title: 'Run the action on a large note?',
    action: 'Running it',
    cta: 'Run anyway'
}

class SizeConfirmModal extends Modal {
    private readonly wordCount: number
    private readonly limit: number
    private readonly onConfirm: () => void
    private readonly labels: SizeConfirmLabels

    constructor(
        app: App,
        wordCount: number,
        limit: number,
        onConfirm: () => void,
        labels: SizeConfirmLabels = REVIEW_SIZE_LABELS
    ) {
        super(app)
        this.wordCount = wordCount
        this.limit = limit
        this.onConfirm = onConfirm
        this.labels = labels
    }

    override onOpen(): void {
        this.setTitle(this.labels.title)
        this.modalEl.addClass('ai-editor-modal')
        this.contentEl.createEl('p', {
            text:
                `This note has about ${this.wordCount} words — above your size warning ` +
                `threshold of ${this.limit}. ${this.labels.action} sends the full text to ` +
                'your configured AI backends, which may be slow or costly.'
        })
        new Setting(this.contentEl)
            .addButton((button) => {
                button.setButtonText('Cancel').onClick(() => this.close())
            })
            .addButton((button) => {
                button
                    .setButtonText(this.labels.cta)
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
    /** Transform/generate runs (one per file); shares the request gate. */
    readonly transformController: TransformController
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
    /** The file's transform run this glue follows (rail + preview widget). */
    transformRun: TransformRunHandle | null
    transformUnsubscribe: (() => void) | null
    /** RunId of the currently presented preview ('' = none presented). */
    transformPreviewKey: string
    /**
     * Chip-click cycle memory (plan §0 "Live-testing feedback #3"): the
     * finding the last chip click on `editorId` revealed, so the next click
     * steps to the one after it (wrap-around). Cleared on note switch and on
     * run change; a remembered finding that left the cycle set restarts the
     * cycle at the first target (`cycleFinding`).
     */
    chipCycle: { editorId: string; findingId: string } | null
    /** Auto-clear timer of the ~2 s chip-click highlight emphasis. */
    emphasisTimer: number | null
    /**
     * Adaptive layout (plan M4): how much room this pane gives the chrome.
     * Driven by `paneObserver` through `nextLayoutMode` (hysteresis lives
     * there); consumed by the rail render. The finding card measures its own
     * pane at open time, so it needs nothing from here.
     */
    layout: PaneLayoutMode
    /** Pane-width observer; disconnected when the glue is destroyed. */
    paneObserver: ResizeObserver | null
}

const REVEAL_SELECTION_MS = 1_500

/** How long a chip click emphasizes its editor's highlights. */
const CHIP_EMPHASIS_MS = 2_000

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
    /** Transform runs whose failure Notice already fired (once per run). */
    private readonly notifiedTransformErrors = new Set<string>()
    /** Transform runs whose stale-dismiss Notice already fired. */
    private readonly notifiedTransformStale = new Set<string>()
    /**
     * Keyboard-triage cursors (plan M4, stage D slice 1): one per file,
     * validated against the file's RunHandle so a replaced run evicts the
     * stale cursor. Distinct from the per-glue chip-click cycle memory —
     * the chip contract is locked to restart-at-first, the triage cursor
     * survives note switches and falls back position-based on eviction.
     */
    private readonly triageCursors = new TriageCursorStore()
    /**
     * Severity filter (plan M4): a per-file VIEW lens. Respected by the
     * decorations, the panel list, triage stepping, chip cycling and the bulk
     * operations — accepting or stepping onto a finding the user cannot see
     * would be a surprise. Run-report surfaces (rail chip counts, panel
     * section status) keep reporting what the editors actually found; the
     * panel's filter control says how much it is hiding.
     */
    private readonly severityFilters = new SeverityFilterStore()
    /** Sticky: survives focus moving to the side panel itself. */
    private lastActiveMarkdownFile: string | null = null
    private refreshTimer: number | null = null
    private disposed = false
    /** Daemon-mode glue, attached after construction (see `attachDaemon`). */
    private daemon: DaemonController | null = null

    constructor(deps: ReviewControllerDeps) {
        this.deps = deps
        this.vaultReader = new ObsidianVaultReader(deps.app)
    }

    /**
     * Wires the daemon controller (created after this controller because it
     * dispatches through it — `plugin.ts` breaks the cycle here). Once
     * attached, the canonical-view update listener feeds it edits, the
     * refresh cycle feeds it live run state, and the file lifecycle hooks
     * (close/delete/rename) clear its per-file timers.
     */
    attachDaemon(daemon: DaemonController): void {
        this.daemon = daemon
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
                this.deps.transformController.discardRun(oldPath)
                this.skipsByFile.delete(oldPath)
                this.triageCursors.clear(oldPath)
                this.severityFilters.clear(oldPath)
                this.daemon?.fileClosed(oldPath)
                if (this.lastActiveMarkdownFile === oldPath) {
                    this.lastActiveMarkdownFile = file.path
                }
                this.scheduleRefresh()
            })
        )
        plugin.registerEvent(
            app.vault.on('delete', (file) => {
                this.deps.runController.discardRun(file.path)
                this.deps.transformController.discardRun(file.path)
                this.skipsByFile.delete(file.path)
                this.triageCursors.clear(file.path)
                this.severityFilters.clear(file.path)
                this.daemon?.fileClosed(file.path)
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
        return [
            EditorView.updateListener.of((update) => this.handleEditorUpdate(update)),
            // Escape precedence (documented contract, plan M4 triage): while
            // a finding card is open, its document-level CAPTURE listener
            // consumes Escape (closes the card, stops propagation) before
            // the editor ever sees the key — the triage cursor survives so
            // stepping can continue. Only when NO card is open does Escape
            // reach this handler, which clears the file's triage cursor.
            // It NEVER consumes the event (returns false): Obsidian and
            // other plugins keep their own Escape behaviors, this is a
            // side-effect-only observer, hence Prec.highest so a consuming
            // lower-precedence handler cannot starve it.
            Prec.highest(
                EditorView.domEventHandlers({
                    keydown: (event, editorView) => {
                        if (event.key === 'Escape') {
                            this.handleEditorEscape(editorView)
                        }
                        return false
                    }
                })
            )
        ]
    }

    /** Escape in an editor with no card open: leave triage for that file. */
    private handleEditorEscape(editorView: EditorView): void {
        const glue = this.findGlueByEditorView(editorView)
        const path = glue?.filePath ?? null
        if (!path || this.disposed || !this.triageCursors.has(path)) {
            return
        }
        this.triageCursors.clear(path)
        this.scheduleRefresh() // drops the current ring from the decorations
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
        this.triageCursors.clearAll()
        this.severityFilters.clearAll()
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
        return isReviewable(path, this.vaultReader, this.deps.getSettings())
    }

    /**
     * Privacy exclusion alone (Business Rules #7) — the gate for bound
     * actions, which dispatch independently of the note being "reviewable"
     * (a vault whose editors are all rewrite-only still runs transforms).
     */
    isNoteExcluded(path: string): boolean {
        return isExcluded(
            path,
            this.vaultReader.getNoteMetadata(path),
            this.deps.getSettings().behavior
        )
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
            case 'aborted':
                // Only daemon dispatches pass `abortWhen`; unreachable here.
                return
            case 'excluded':
                new Notice('This note is excluded from AI review by your privacy settings.')
                return
            case 'rule-disabled':
                new Notice(`AI Editor is turned off for this note by the rule ${result.ruleLabel}.`)
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
     * Bound-action dispatch entry (design §1/§3), shared by the editor
     * context menu items and the dynamic `action-<bindingId>` commands. The
     * binding is re-resolved against the CURRENT settings in this callback
     * (menus and commands may hold a stale view), and the selection + its
     * capture-time hash are read synchronously HERE (selection-capture
     * contract — the dispatch path awaits vault reads before the run
     * starts).
     *
     * Routing by verb class:
     * - review-class → the exact `startReview` path, narrowed to the
     *   resolved editor set (one editor, or every panel member) with the
     *   verb instruction augmented onto each prompt; a non-empty selection
     *   scopes the review, a caret reviews the whole note.
     * - transform → `startAction` (`transform-selection`); requires a
     *   non-empty selection.
     * - generate → `startAction` (`insert-at`); inserts after the selection
     *   or at the caret.
     */
    startBoundAction(view: MarkdownView, editor: Editor, bindingId: string): void {
        if (!view.file || this.disposed) {
            return
        }
        const resolved = resolveActionById(this.deps.getSettings(), bindingId)
        if (!resolved) {
            new Notice('This action is no longer available — check the Actions settings tab.')
            return
        }
        const from = editor.posToOffset(editor.getCursor('from'))
        const to = editor.posToOffset(editor.getCursor('to'))

        if (resolved.verbClass === 'review') {
            const verb = getBuiltInVerb(resolved.actionId)
            if (!verb) {
                // Custom actions are transform-class; unreachable.
                return
            }
            void this.startReview(view, false, from !== to ? { from, to } : undefined, 'auto', {
                editorIds: resolved.editorIds,
                text: verb.instruction
            })
            return
        }

        if (resolved.verbClass === 'transform' && from === to) {
            new Notice('Select the text to transform first.')
            return
        }
        const selection = { from, to, capturedHash: hashText(editor.getValue()) }
        void this.runTransformAction(view, resolved, selection, false)
    }

    /**
     * Transform/generate dispatch continuation: resolves a custom action's
     * instruction fresh from the vault (Business Rules #8), snapshots the
     * view, and routes every `startAction` refusal to a Notice. Mirrors the
     * `startReview` continuation — including the size-confirmation round
     * trip, which re-enters with `confirmedLargeNote` and the ORIGINAL
     * captured selection (the service re-validates it against the fresh
     * snapshot and refuses staleness as `selection-changed`).
     */
    private async runTransformAction(
        view: MarkdownView,
        resolved: ResolvedAction,
        selection: { from: number; to: number; capturedHash: string },
        confirmedLargeNote: boolean
    ): Promise<void> {
        const file = view.file
        if (!file || this.disposed) {
            return
        }
        const filePath = file.path
        const settings = this.deps.getSettings()
        const editorId = resolved.editorIds[0]
        if (editorId === undefined) {
            return
        }
        let custom: { label: string; instruction: string } | undefined
        if (resolved.kind === 'custom') {
            const binding = settings.actions.find(
                (candidate) => candidate.id === resolved.bindingId
            )
            if (!binding) {
                return
            }
            const instruction = await resolveCustomInstruction(
                binding.customInstruction,
                this.vaultReader,
                settings.behavior
            )
            if (instruction.trim().length === 0) {
                new Notice(
                    `${resolved.label}: its instruction notes are missing or excluded — nothing to send.`
                )
                return
            }
            custom = { label: resolved.label, instruction }
        }
        const snapshot = this.snapshotView(view, filePath, 'whole-note')
        const result = await startAction({
            settings,
            snapshot,
            vault: this.vaultReader,
            runController: this.deps.runController,
            transformController: this.deps.transformController,
            actionId: resolved.actionId,
            ...(custom ? { custom } : {}),
            editorId,
            fetchImpl: window.fetch.bind(window),
            confirmedLargeNote,
            selection,
            refreshSnapshot: (): DocumentSnapshot | null =>
                view.file?.path === filePath
                    ? this.snapshotView(view, filePath, 'whole-note')
                    : null
        })
        switch (result.status) {
            case 'review':
                // Review-class verbs dispatch via `startReview` upstream.
                return
            case 'started':
                // Synchronous on purpose (same invariant as the review
                // 'started' branch): the glue must subscribe to the transform
                // run in the same block that started it so terminal states
                // and the preview present without an unrelated refresh.
                this.refreshAll()
                return
            case 'unknown-action':
                new Notice('This action is no longer available — check the Actions settings tab.')
                return
            case 'excluded':
                new Notice('This note is excluded from AI actions by your privacy settings.')
                return
            case 'rule-disabled':
                new Notice(`AI Editor is turned off for this note by the rule ${result.ruleLabel}.`)
                return
            case 'needs-confirmation':
                new SizeConfirmModal(
                    this.deps.app,
                    result.wordCount,
                    result.limit,
                    () => {
                        void this.runTransformAction(view, resolved, selection, true)
                    },
                    ACTION_SIZE_LABELS
                ).open()
                return
            case 'no-editor': {
                const details = result.skips
                    .map((skip) => `${skip.editorName} — ${skipReasonLabel(skip.reason)}`)
                    .join('; ')
                new Notice(
                    details.length > 0
                        ? `${resolved.label} could not run: ${details}`
                        : `${resolved.label} could not run: its editor is unavailable.`
                )
                return
            }
            case 'selection-required':
                new Notice('Select the text to transform first.')
                return
            case 'selection-changed':
                new Notice('The text changed — run the action again.')
                return
        }
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
                editorIds: [editorId],
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

    // -- Daemon dispatch seam (`DaemonReviewPort`) ----------------------------

    /**
     * Live-buffer facts for the daemon's fire-time gates: hash (changed-text
     * compare against the last run's snapshot) and word count (silent
     * oversized skip). Null when the note is not open in any markdown view —
     * the daemon then fails closed (nothing to dispatch against).
     */
    probeDaemonNote(filePath: string): { hash: string; wordCount: number } | null {
        const view = this.findMarkdownView(filePath)
        if (!view || view.file?.path !== filePath) {
            return null
        }
        const text = view.editor.getValue()
        return { hash: hashText(text), wordCount: countWords(text) }
    }

    /**
     * Daemon refresh entry (`DaemonReviewPort`): the SAME `startReview`
     * pipeline as every other surface (exclusions, size guard, editor/backend
     * resolution, concurrency gate all apply), with the daemon-specific
     * contract on top (plan §0 daemon row):
     * - whole-note scope — a live selection must never narrow an automatic
     *   refresh;
     * - `editorIds` re-dispatches the note's previous run's editor set (null
     *   = never reviewed → all enabled review-capable editors);
     * - SILENT on every refusal: no Notices, no size-confirmation modal (the
     *   daemon pre-checks size and skips oversized notes with one log line),
     *   no side-panel activation — an automatic refresh must not rearrange
     *   the workspace or nag;
     * - `abortWhen` guards the context-assembly awaits: if a user summon
     *   started a run meanwhile, the dispatch aborts WITHOUT starting a run —
     *   `startRun` would cancel the user's run, and explicit interactions
     *   always win over the daemon. The same guard aborts when daemon mode
     *   was toggled OFF mid-flight (the toggle is the cost kill-switch — a
     *   dispatch already past the timer must not bill the backends after it)
     *   or when the controller was disposed (plugin unload — `cancelAll`
     *   settles runs, so the run-in-flight check alone would let a mid-await
     *   dispatch start a fresh run whose backend requests outlive the
     *   plugin).
     */
    async startDaemonReview(
        filePath: string,
        editorIds: readonly string[] | null
    ): Promise<'started' | 'refused'> {
        if (this.disposed) {
            return 'refused'
        }
        const view = this.findMarkdownView(filePath)
        if (!view || view.file?.path !== filePath) {
            return 'refused'
        }
        const snapshot = this.snapshotView(view, filePath, 'whole-note')
        const result = await startReview({
            settings: this.deps.getSettings(),
            snapshot,
            vault: this.vaultReader,
            runController: this.deps.runController,
            fetchImpl: window.fetch.bind(window),
            confirmedLargeNote: false,
            refreshSnapshot: (): DocumentSnapshot | null =>
                view.file?.path === filePath
                    ? this.snapshotView(view, filePath, 'whole-note')
                    : null,
            abortWhen: (): boolean => {
                if (this.disposed || !this.deps.getSettings().behavior.daemonMode) {
                    return true
                }
                const run = this.deps.runController.getRun(filePath)
                return run !== null && !run.isSettled()
            },
            ...(editorIds ? { editorIds } : {})
        })
        if (result.status !== 'started') {
            return 'refused'
        }
        this.skipsByFile.set(filePath, result.skips)
        // Synchronous bind, same invariant as the command path's 'started'
        // branch: `glue.run` must hold the run before any keystroke can
        // interleave. Safe: timer callback context, never a CM6 update cycle.
        this.refreshAll()
        return 'started'
    }

    /** Deferred refresh entry for the daemon's armed-state indicator. */
    requestRefresh(): void {
        this.scheduleRefresh()
    }

    /**
     * Cancels the in-flight work for the view's note (rail Cancel button):
     * the review run AND any in-flight transform/generate run — the button
     * shows Cancel while either is running, so it must stop both.
     */
    cancelReview(view: MarkdownView): void {
        const path = view.file?.path
        if (!path) {
            return
        }
        this.deps.runController.getRun(path)?.cancelRun()
        this.deps.transformController.getRun(path)?.cancel()
    }

    /**
     * The transform run bound to the (last) active markdown file, if any —
     * the `Cancel review or action` command gate reads through this.
     */
    getActiveTransformRun(): TransformRunHandle | null {
        const path = this.resolveActiveFilePath()
        return path ? this.deps.transformController.getRun(path) : null
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

    // -- Rail chip click (plan §0 "Live-testing feedback #3") -----------------

    /**
     * Chip-click dispatch: the pure decision lives in `chipClickAction`, the
     * pure cycle stepping in `cycleFinding` — this method only assembles
     * their inputs from live state and executes the verdict.
     *
     * - `cycle-findings`: reveal the first / next revealable finding of that
     *   editor (the exact side-panel reveal path) and emphasize the editor's
     *   highlights for ~2 s.
     * - `open-panel`: nothing revealable inline, but the editor has a
     *   summary or failure — open the side panel scrolled to its section.
     * - `none`: chip in flight (the tooltip already says so) or nothing to
     *   show.
     *
     * The chip status is derived exactly like `buildRailEditors` derives it
     * (including the in-flight transform overlay), so the decision always
     * matches what the user sees on the chip.
     */
    private handleChipClick(view: MarkdownView, editorId: string): void {
        const glue = this.glues.get(view)
        const path = view.file?.path
        if (!glue || !path || this.disposed) {
            return
        }
        const run = this.deps.runController.getRun(path)
        const transformRun = this.deps.transformController.getRun(path)
        const transformActive =
            transformRun !== null && !transformRun.isSettled() && transformRun.editorId === editorId
        const state = run?.getEditorState(editorId) ?? null
        const status = transformActive
            ? 'transforming'
            : state
              ? railStatusOf(state.status)
              : 'idle'
        const revealable = run
            ? navigableEditorFindings(this.visibleFindings(path, run), editorId)
            : []
        const hasSummaryOrError =
            state !== null &&
            ((state.summary !== null && state.summary.length > 0) ||
                state.status === 'error' ||
                state.status === 'cancelled')
        switch (chipClickAction(status, revealable.length, hasSummaryOrError)) {
            case 'cycle-findings': {
                const last = glue.chipCycle?.editorId === editorId ? glue.chipCycle.findingId : null
                const target = cycleFinding(revealable, last)
                if (!target) {
                    return
                }
                glue.chipCycle = { editorId, findingId: target.id }
                this.emphasizeEditor(glue, editorId)
                void this.revealFinding(path, asFindingId(target.id))
                return
            }
            case 'open-panel':
                void this.activateSidePanelAtEditor(editorId)
                return
            case 'none':
                return
        }
    }

    /**
     * Flashes one editor's highlights for ~2 s (`emphasizeEditorEffect` adds
     * the `ai-editor-finding-emphasized` class to exactly that editor's
     * marks; the stylesheet keeps the pulse reduced-motion aware). Re-clicks
     * restart the window; the timer is cleared on note switch, glue teardown
     * and dispose (`pendingTimers`). The clear dispatch is safe on a
     * destroyed `EditorView` (CM6 no-op) and after a note switch (the
     * decoration set was rebuilt without emphasis, so clearing is a no-op).
     */
    private emphasizeEditor(glue: ViewGlue, editorId: string): void {
        const editorView = editorViewOf(glue.view)
        if (!editorView) {
            return
        }
        this.clearEmphasisTimer(glue)
        editorView.dispatch({ effects: emphasizeEditorEffect.of(editorId) })
        const timer = window.setTimeout(() => {
            this.pendingTimers.delete(timer)
            glue.emphasisTimer = null
            if (this.disposed) {
                return
            }
            editorView.dispatch({ effects: emphasizeEditorEffect.of(null) })
        }, CHIP_EMPHASIS_MS)
        glue.emphasisTimer = timer
        this.pendingTimers.add(timer)
    }

    private clearEmphasisTimer(glue: ViewGlue): void {
        if (glue.emphasisTimer !== null) {
            window.clearTimeout(glue.emphasisTimer)
            this.pendingTimers.delete(glue.emphasisTimer)
            glue.emphasisTimer = null
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
        const context = this.activeRunContext()
        return (
            context !== null &&
            navigableFindings(this.visibleFindings(context.path, context.run)).length > 0
        )
    }

    /**
     * Triage stepping (plan M4, stage D slice 1): moves the per-file triage
     * cursor to the next/previous navigable finding — ALL editors, anchor
     * order, wrap-around — reveals it, rings it as current, and opens its
     * card (card-on-jump). Pure decisions live in `finding-navigation.ts`:
     * the very first step (no cursor yet) seeds cursor-relative via
     * `stepFinding` (the pre-triage behavior of these commands), every
     * later step is memory-based via the shared `triageStep` engine — so a
     * cursor invalidated in place (its finding accepted from the card, went
     * stale under an edit, was dismissed) resumes from where it USED to sit
     * instead of restarting.
     */
    navigateFinding(direction: NavigationDirection): void {
        const context = this.activeRunContext()
        if (!context) {
            return
        }
        const { path, run } = context
        const ordered = navigableFindings(this.visibleFindings(path, run))
        const memory = this.liveTriageMemory(path, run)
        let target: NavigationTarget | null
        if (memory) {
            target = triageStep(ordered, memory, direction)
        } else {
            const view = this.findMarkdownView(path)
            const cursorOffset =
                view && view.file?.path === path
                    ? view.editor.posToOffset(view.editor.getCursor('from'))
                    : null
            target = stepFinding(ordered, cursorOffset, direction)
        }
        if (!target) {
            return
        }
        this.moveTriageCursor(path, run, target)
    }

    /**
     * The file's triage cursor with its position re-read from the remembered
     * finding's LIVE anchor. The cursor store holds a raw offset that nothing
     * remaps (only anchors travel through `applyTextChanges`), and that offset
     * is the eviction fallback every step compares live anchors against — so
     * an edit before the cursor would otherwise send `next`/`prev` to the
     * wrong finding once the remembered one leaves the navigable set.
     */
    private liveTriageMemory(path: string, run: RunHandle): TriageMemory | null {
        const memory = this.triageCursors.get(path, run)
        if (memory === null) {
            return null
        }
        return rebaseTriageMemory(
            memory,
            run.findings.get(asFindingId(memory.id))?.anchor?.from ?? null
        )
    }

    /**
     * Commits a triage step: remember the cursor (id + position — the
     * position is the eviction fallback), refresh so the decoration layer
     * rings the new current finding, reveal it through the exact side-panel
     * path, then open its card at the revealed span (card-on-jump).
     */
    private moveTriageCursor(path: string, run: RunHandle, target: NavigationTarget): void {
        this.triageCursors.set(path, run, { id: target.id, from: target.from })
        this.scheduleRefresh()
        void this.revealFinding(path, asFindingId(target.id)).then((view) => {
            if (view && !this.disposed) {
                editorViewOf(view)?.dispatch({ effects: showFindingCardEffect.of(target.id) })
            }
        })
    }

    // -- Keyboard triage: accept/dismiss the current finding ------------------

    /**
     * The active file's triage state, when a CURRENT finding exists: the
     * cursor points at a finding that is still navigable (non-terminal,
     * anchored, not stale) under the file's CURRENT run. Everything the
     * `accept-finding`/`dismiss-finding` gates and actions need.
     */
    private currentTriageContext(): {
        path: string
        run: RunHandle
        current: NavigationTarget
    } | null {
        const context = this.activeRunContext()
        if (!context) {
            return null
        }
        const { path, run } = context
        const ordered = navigableFindings(this.visibleFindings(path, run))
        const current = triageCurrent(ordered, this.triageCursors.get(path, run))
        return current ? { path, run, current } : null
    }

    /**
     * `Accept current finding` gate: a current finding exists, the store
     * reports it actionable (suggestion present, anchored, not stale, not
     * terminal — the exact card-button condition), and its note is open in
     * an editor to dispatch the replacement into.
     */
    canAcceptCurrentFinding(): boolean {
        const context = this.currentTriageContext()
        if (!context) {
            return false
        }
        return (
            context.run.findings.isActionable(asFindingId(context.current.id)) &&
            this.editorViewFor(context.path) !== null
        )
    }

    /**
     * `Dismiss current finding` gate: a current finding exists — navigable
     * implies non-terminal, so it is dismissable by construction.
     */
    canDismissCurrentFinding(): boolean {
        return this.currentTriageContext() !== null
    }

    /**
     * Accepts the CURRENT finding through the exact card-button path:
     * `FindingStore.accept` re-verifies the precondition against the live
     * document (Business Rules #3), then ONE undoable, history-isolated
     * transaction applies the replacement and drops the mark — the
     * canonical-view forwarding remaps every other anchor exactly like a user
     * edit. Then the triage loop auto-advances onto the next remaining
     * finding.
     */
    acceptCurrentFinding(): void {
        const context = this.currentTriageContext()
        if (!context) {
            return
        }
        const editorView = this.editorViewFor(context.path)
        if (!editorView) {
            return
        }
        const outcome = this.acceptFinding(context.current.id, editorView.state.doc.toString())
        if (!outcome.ok) {
            // Same stale race the card handles by re-rendering; a command
            // has no card to refresh, so say why nothing happened.
            new Notice('The text changed since this suggestion was made.')
            this.scheduleRefresh()
            return
        }
        editorView.dispatch({
            changes: { from: outcome.from, to: outcome.to, insert: outcome.insert },
            effects: removeFindingsEffect.of([context.current.id]),
            annotations: isolateHistory.of('full')
        })
        this.advanceTriage(context.path, context.run, context.current)
    }

    /**
     * Dismisses the CURRENT finding (terminal status via the same store
     * path as the card button, decoration dropped in place) and advances
     * the triage loop.
     */
    dismissCurrentFinding(): void {
        const context = this.currentTriageContext()
        if (!context) {
            return
        }
        this.dismissFinding(context.current.id)
        this.editorViewFor(context.path)?.dispatch({
            effects: removeFindingsEffect.of([context.current.id])
        })
        this.advanceTriage(context.path, context.run, context.current)
    }

    /**
     * The triage loop's auto-advance: the judged finding just left the
     * navigable set (terminal, or its accept edit staled a neighbor too),
     * so `triageStep` from its remembered position lands on the next
     * remaining finding, wrapping around. Nothing left → triage is done:
     * clear the cursor, close the card, say so once.
     */
    private advanceTriage(path: string, run: RunHandle, judged: NavigationTarget): void {
        const ordered = navigableFindings(this.visibleFindings(path, run))
        const target = triageStep(ordered, { id: judged.id, from: judged.from }, 'next')
        if (!target) {
            this.triageCursors.clear(path)
            const view = this.findMarkdownView(path)
            if (view) {
                editorViewOf(view)?.dispatch({ effects: showFindingCardEffect.of(null) })
            }
            new Notice('No more findings to triage.')
            this.scheduleRefresh()
            return
        }
        this.moveTriageCursor(path, run, target)
    }

    // -- Bulk triage (plan M4 "Bulk triage") ----------------------------------

    /**
     * The (last) active markdown file and its run — the scope every ambient
     * triage surface operates on (`null` when nothing is bound).
     */
    private activeRunContext(): { path: string; run: RunHandle } | null {
        const path = this.resolveActiveFilePath()
        const run = path ? this.deps.runController.getRun(path) : null
        return path && run ? { path, run } : null
    }

    /**
     * Run scope for an operation: an EXPLICIT file when the caller knows which
     * one it acted on (the side panel's buttons carry the file they were
     * rendered for), otherwise the active file (command palette).
     */
    private runContextFor(filePath: string | null): { path: string; run: RunHandle } | null {
        if (filePath === null) {
            return this.activeRunContext()
        }
        const run = this.deps.runController.getRun(filePath)
        return run ? { path: filePath, run } : null
    }

    /**
     * The findings a bulk operation may touch: the file's VISIBLE findings
     * (severity filter applied — never accept or dismiss what the user cannot
     * see) narrowed to one editor (`null` = every editor of the run).
     */
    private bulkCandidates(
        path: string,
        run: RunHandle,
        editorId: string | null
    ): readonly TrackedFinding[] {
        const findings = this.visibleFindings(path, run)
        return editorId === null
            ? findings
            : findings.filter((finding) => finding.editorId === editorId)
    }

    // -- Severity filter (plan M4 "Bulk triage") ------------------------------

    /**
     * The findings the file's severity filter lets the interaction surfaces
     * see. Everything stays in the store — this is a lens, not a mutation.
     */
    private visibleFindings(filePath: string, run: RunHandle): readonly TrackedFinding[] {
        const mode = this.severityFilters.get(filePath)
        if (mode === 'all') {
            return run.findings.list()
        }
        return run.findings
            .list()
            .filter((finding) => passesSeverityFilter(mode, finding.raw.severity))
    }

    /** How many of the run's live findings the given mode hides. */
    private hiddenFindingCount(run: RunHandle, mode: SeverityFilterMode): number {
        return run.findings
            .list()
            .filter((finding) => finding.status === 'open' || finding.status === 'preview')
            .filter((finding) => !passesSeverityFilter(mode, finding.raw.severity)).length
    }

    /** `Cycle severity filter` gate: the active run has findings to filter. */
    canCycleSeverityFilter(): boolean {
        const context = this.activeRunContext()
        if (!context) {
            return false
        }
        return context.run.findings
            .list()
            .some((finding) => finding.status === 'open' || finding.status === 'preview')
    }

    /**
     * Advances the active file's severity filter one step (all → warnings and
     * suggestions → warnings only → all) and says what is shown now: the
     * command palette gives no other feedback, and the number of hidden
     * findings is what makes the lens trustworthy.
     */
    cycleSeverityFilter(): void {
        const context = this.activeRunContext()
        if (!context || this.disposed) {
            return
        }
        const mode = this.severityFilters.cycle(context.path)
        new Notice(severityFilterNotice(mode, this.hiddenFindingCount(context.run, mode)))
        this.scheduleRefresh()
    }

    /**
     * `Accept all …` gate: the note is open in an editor to dispatch into and
     * at least one candidate finding is actionable (the store is the
     * authority; `planBulkAccept` may still skip it for a failed precondition
     * or an overlap, which the Notice reports).
     */
    canAcceptAll(editorId: string | null): boolean {
        const context = this.activeRunContext()
        if (!context || this.editorViewFor(context.path) === null) {
            return false
        }
        return this.bulkCandidates(context.path, context.run, editorId).some((finding) =>
            context.run.findings.isActionable(asFindingId(finding.id))
        )
    }

    /** `Dismiss all …` gate: at least one non-terminal candidate finding. */
    canDismissAll(editorId: string | null): boolean {
        const context = this.activeRunContext()
        if (!context) {
            return false
        }
        return (
            dismissableFindingIds(this.bulkCandidates(context.path, context.run, editorId)).length >
            0
        )
    }

    /**
     * Accept-all-non-conflicting (plan M4): applies every candidate finding
     * that is actionable, still matches the live text (`FindingStore.accept`
     * re-verifies each precondition — Business Rules #3) and does not overlap
     * an earlier accepted span, as ONE undoable, history-isolated transaction
     * — so a single Ctrl+Z restores the whole batch and neighbouring typing
     * is never swallowed (`finding-accept.spec.ts`).
     *
     * `filePath` scopes the operation explicitly — the side panel passes the
     * file its buttons were RENDERED for, so a bulk mutation can never land on
     * a different note than the one whose counts the user clicked (the sticky
     * active-file pointer moves synchronously, the panel re-renders on a
     * coalesced refresh). The command palette passes null and keeps the active
     * file, matching the gate it was checked against.
     *
     * Overlaps keep the EARLIER anchor and the later suggestion is skipped
     * (applying both would compose two rewrites of the same span into
     * nonsense); skipped counts — overlapping and no-longer-matching — are
     * reported in one Notice so nothing is silently dropped.
     *
     * The dispatched edit reaches the domain anchor store through the
     * canonical-view forwarding like any user edit, so every finding left in
     * the run remaps (intersecting ones go stale).
     */
    acceptAllFindings(editorId: string | null, filePath: string | null = null): void {
        const context = this.runContextFor(filePath)
        if (!context || this.disposed) {
            return
        }
        const editorView = this.editorViewFor(context.path)
        if (!editorView) {
            new Notice('Open the note in an editor to apply findings.')
            return
        }
        const currentText = editorView.state.doc.toString()
        const plan = planBulkAccept(
            this.bulkCandidates(context.path, context.run, editorId),
            currentText
        )
        const applied = plan.edits.filter(
            (edit) => context.run.findings.accept(asFindingId(edit.findingId), currentText).ok
        )
        if (applied.length > 0) {
            editorView.dispatch({
                changes: applied.map((edit) => ({
                    from: edit.from,
                    to: edit.to,
                    insert: edit.insert
                })),
                effects: removeFindingsEffect.of(applied.map((edit) => edit.findingId)),
                annotations: isolateHistory.of('full')
            })
        }
        new Notice(bulkAcceptNotice(applied.length, plan))
        this.scheduleRefresh()
    }

    /**
     * Dismiss-all: every non-terminal candidate finding goes terminal through
     * the same store path as the card button (stale and unanchored ones
     * included — dismissing is always allowed) and their marks are dropped in
     * one dispatch. No document change, so nothing to undo; an open card is
     * closed because its findings may no longer exist. `filePath` scopes the
     * operation like `acceptAllFindings`.
     */
    dismissAllFindings(editorId: string | null, filePath: string | null = null): void {
        const context = this.runContextFor(filePath)
        if (!context || this.disposed) {
            return
        }
        const ids = dismissableFindingIds(this.bulkCandidates(context.path, context.run, editorId))
        for (const id of ids) {
            context.run.findings.dismiss(asFindingId(id))
        }
        if (ids.length > 0) {
            this.editorViewFor(context.path)?.dispatch({
                effects: [removeFindingsEffect.of(ids), showFindingCardEffect.of(null)]
            })
        }
        new Notice(bulkDismissNotice(ids.length))
        this.scheduleRefresh()
    }

    /** The CM6 view of an open markdown view showing `path`, if any. */
    private editorViewFor(path: string): EditorView | null {
        const view = this.findMarkdownView(path)
        return view ? editorViewOf(view) : null
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

    /**
     * Opens the side panel scrolled to one editor's section — the chip
     * click-through when there is nothing to reveal inline. The scroll runs
     * after `activateSidePanel` pushed the binding, so the section exists.
     */
    private async activateSidePanelAtEditor(editorId: string): Promise<void> {
        await this.activateSidePanel()
        if (this.disposed) {
            return
        }
        for (const leaf of this.deps.app.workspace.getLeavesOfType(REVIEW_PANEL_VIEW_TYPE)) {
            const view = leaf.view
            if (view instanceof ReviewSidePanelView) {
                view.revealEditorSection(editorId)
            }
        }
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
            severityFilter: this.severityFilters.get(path),
            cycleSeverityFilter: (): void => {
                this.cycleSeverityFilter()
            },
            revealFinding: (findingId: FindingId): void => {
                void this.revealFinding(path, findingId)
            },
            retryEditor: (editorId: string): void => {
                this.retryEditor(path, editorId)
            },
            // Scoped to the file this binding was built for, like the reveal
            // and retry closures above: the panel must never mutate a run
            // other than the one it is displaying.
            acceptAll: (editorId: string): void => {
                this.acceptAllFindings(editorId, path)
            },
            dismissAll: (editorId: string): void => {
                this.dismissAllFindings(editorId, path)
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
            },
            pushBack: (findingId, message): Promise<boolean> =>
                this.pushBackOnFinding(findingId, message)
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
            acceptable: run.findings.isActionable(id),
            thread: finding.thread,
            threadTurn: finding.threadTurn
        }
    }

    /**
     * Push-back (plan M4 threads): sends the user's message to the editor that
     * produced the finding. The live document text is read SYNCHRONOUSLY here
     * so the turn discusses the span as it currently reads (`currentSpanText`),
     * then `startThreadTurn` resolves the persona/backend and dispatches.
     *
     * The REPLY is fire and forget: it lands on the finding in the store and
     * reaches an open card through the refresh cycle — closing the card (or
     * navigating away) never cancels the turn, only cancelling the run does.
     * Every refusal and every completed turn is reported as a Notice, because
     * the card may well be closed by the time the answer arrives.
     *
     * The returned promise settles on the DISPATCH, resolving `true` only when
     * the store now holds a pending turn. The card needs that to hand its
     * optimistic pending row over to the store — or to give the typed message
     * back when nothing was recorded.
     */
    private async pushBackOnFinding(rawId: string, message: string): Promise<boolean> {
        const id = asFindingId(rawId)
        const run = this.deps.runController.findRunWithFinding(id)
        if (!run) {
            new Notice('That finding is no longer available.')
            return false
        }
        const finding = run.findings.get(id)
        const editorName =
            finding === null
                ? 'The editor'
                : (run.getEditorState(finding.editorId)?.editorName ??
                  this.deps.getSettings().editors.find((e) => e.id === finding.editorId)?.name ??
                  'The editor')
        // The card lives in a view of this file; read the live buffer through
        // the canonical glue so the quote matches what the user sees, falling
        // back to the run snapshot when no view is mounted (popout closed).
        const glue = this.canonicalGlueFor(run.snapshot.filePath)
        const editorView = glue ? editorViewOf(glue.view) : null
        const currentText = editorView?.state.doc.toString() ?? run.snapshot.text

        const start = await startThreadTurn({
            settings: this.deps.getSettings(),
            vault: this.vaultReader,
            runController: this.deps.runController,
            findingId: id,
            message,
            currentText,
            fetchImpl: window.fetch.bind(window)
        })
        if (this.disposed) {
            return false
        }
        switch (start.status) {
            case 'started':
                this.scheduleRefresh()
                void start.settled.then((resolution) => {
                    this.reportThreadResolution(editorName, resolution)
                })
                return true
            case 'no-run':
                new Notice('That finding is no longer available.')
                return false
            case 'excluded':
                new Notice(`${start.notePath} is excluded from AI review.`)
                return false
            case 'rule-disabled':
                new Notice(`AI Editor is turned off for that note by the rule ${start.ruleLabel}.`)
                return false
            case 'no-editor':
                new Notice(
                    start.skip === null
                        ? 'That finding’s editor is no longer available.'
                        : `${start.skip.editorName} cannot answer: ${skipReasonLabel(start.skip.reason)}.`
                )
                return false
            case 'refused':
                new Notice(threadRefusalNotice(start.reason, editorName))
                this.scheduleRefresh()
                return false
        }
    }

    /** One Notice per completed turn — the card may be closed by then. */
    private reportThreadResolution(editorName: string, resolution: ThreadTurnResolution): void {
        if (this.disposed) {
            return
        }
        this.scheduleRefresh()
        switch (resolution.status) {
            case 'conceded':
                new Notice(`${editorName} withdrew the finding: ${resolution.reply}`)
                return
            case 'held':
                new Notice(
                    resolution.revised
                        ? `${editorName} revised the finding: ${resolution.reply}`
                        : `${editorName} replied: ${resolution.reply}`
                )
                return
            case 'failed':
                new Notice(`Push-back failed: ${resolution.reason}`)
                return
            case 'cancelled':
            case 'discarded':
                // Cancelling the run is a user action with its own feedback,
                // and a discarded turn means the finding is gone — silence.
                return
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
        if (!glue || glue.filePath === null) {
            return
        }
        // The file shown by this view changed (doc-replacing transaction of a
        // note switch): never forward it to the previous note's run.
        if (glue.view.file?.path !== glue.filePath) {
            return
        }
        // A presented transform preview may go stale with this edit: defer a
        // refresh so `dispatchTransformPreview` re-checks the apply
        // precondition and auto-dismisses (coalesced timer, cheap no-op when
        // nothing changed). Runs BEFORE the canonical check — the widget can
        // live in a non-canonical pane too.
        if (glue.transformRun?.isSettled() === true) {
            this.scheduleRefresh()
        }
        if (this.canonicalGlueFor(glue.filePath) !== glue) {
            return // non-canonical pane: the canonical view forwards this edit
        }
        // Daemon mode reuses this exact-once-per-file edit stream — no second
        // CM6 listener exists. Fires for files WITHOUT a run too (a
        // never-reviewed note arms just as well); near-zero cost while the
        // daemon toggle is off.
        this.daemon?.recordEdit(glue.filePath)
        if (!glue.run) {
            return
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
        const removedPaths = new Set<string>()
        for (const [view, glue] of [...this.glues]) {
            if (!seen.has(view)) {
                if (glue.filePath !== null) {
                    removedPaths.add(glue.filePath)
                }
                this.destroyGlue(glue)
                this.glues.delete(view)
            }
        }
        // Daemon timers are keyed by file path (popouts/splits share one
        // schedule); clear a file's schedule only when its LAST view is gone.
        for (const path of removedPaths) {
            const stillOpen = [...this.glues.values()].some((glue) => glue.view.file?.path === path)
            if (!stillOpen) {
                this.daemon?.fileClosed(path)
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
                onEditorClick: (editorId): void => {
                    this.handleChipClick(view, editorId)
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
            doc,
            // Native themed tooltips on every chip: name + live status.
            // The rail sits at the editor's right edge, so place them left.
            (el, tooltip) => setTooltip(el, tooltip, { placement: 'left' })
        )
        const glue: ViewGlue = {
            view,
            railWrapperEl,
            rail,
            filePath: null,
            run: null,
            unsubscribe: null,
            lastSpecsKey: '',
            transformRun: null,
            transformUnsubscribe: null,
            transformPreviewKey: '',
            chipCycle: null,
            emphasisTimer: null,
            // First measurement, so a pane that is ALREADY narrow never
            // renders the wide rail for a frame. A pane being measured while
            // hidden reports 0 and keeps the default (see `nextLayoutMode`).
            layout: nextLayoutMode(view.contentEl.clientWidth, 'wide'),
            paneObserver: null
        }
        this.observePaneWidth(glue, doc)
        return glue
    }

    /**
     * Watches the markdown view content for width changes (plan M4 adaptive
     * layout). The observer comes from the view's OWN window so panes in
     * popout windows are observed by their own document's implementation.
     * Only a mode CHANGE schedules work — dragging a split fires this per
     * frame, and the layout mode has hysteresis around the threshold.
     */
    private observePaneWidth(glue: ViewGlue, doc: Document): void {
        const observer = doc.defaultView?.ResizeObserver
        if (!observer) {
            return // no observer in this window: the rail stays in wide form
        }
        glue.paneObserver = new observer((entries) => {
            const entry = entries[entries.length - 1]
            if (entry === undefined) {
                return
            }
            this.handlePaneResize(glue, entry.contentRect.width)
        })
        glue.paneObserver.observe(glue.view.contentEl)
    }

    private handlePaneResize(glue: ViewGlue, width: number): void {
        if (this.disposed) {
            return
        }
        const layout = nextLayoutMode(width, glue.layout)
        if (layout === glue.layout) {
            return
        }
        glue.layout = layout
        // Rail re-render only — never synchronous DOM work inside the
        // observer callback (that is how ResizeObserver loops start).
        this.scheduleRefresh()
    }

    private destroyGlue(glue: ViewGlue): void {
        this.clearEmphasisTimer(glue)
        glue.unsubscribe?.()
        glue.unsubscribe = null
        glue.transformUnsubscribe?.()
        glue.transformUnsubscribe = null
        glue.paneObserver?.disconnect()
        glue.paneObserver = null
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
            // A new (or cleared) run means new finding ids: the chip-click
            // cycle restarts at the first finding.
            glue.chipCycle = null
        }
        // Terminal transform failures/cancellations are reconciled (Notice +
        // discard) BEFORE binding, so the rail and preview only ever see a
        // pending/running/done transform run.
        const transformRun = filePath ? this.reconcileTransformRun(filePath) : null
        if (glue.transformRun !== transformRun) {
            glue.transformUnsubscribe?.()
            glue.transformUnsubscribe = transformRun
                ? transformRun.subscribe(() => this.scheduleRefresh())
                : null
            glue.transformRun = transformRun
        }
        const previousPath = glue.filePath
        glue.filePath = filePath
        // Note switch: the chip-click cycle and the emphasis flash belong to
        // the previous note — drop both. The decorations themselves are
        // rebuilt (or cleared) by `dispatchDecorations` below, which resets
        // emphasis too (`setFindingsEffect` specs never carry it).
        if (previousPath !== filePath) {
            glue.chipCycle = null
            this.clearEmphasisTimer(glue)
        }
        // Same-pane navigation (view rebound from note A to note B): clear
        // A's daemon schedule when this was the LAST view showing A — the
        // same last-view rule the removed-view sweep in `syncGlues` applies.
        // Checked against live view paths, so loop order in `refreshAll`
        // cannot matter.
        if (previousPath !== null && previousPath !== filePath) {
            const stillOpen = [...this.glues.values()].some(
                (other) => other.view.file?.path === previousPath
            )
            if (!stillOpen) {
                this.daemon?.fileClosed(previousPath)
            }
        }

        // Daemon glue rides the refresh cycle: run notifications and
        // workspace events land here, so the scheduler always sees the live
        // in-flight state (summons, CLI runs, daemon runs, retries alike)
        // and re-arms after settle when edits happened mid-run.
        if (filePath !== null) {
            this.daemon?.syncRunState(filePath, run !== null && !run.isSettled())
        }

        // Rail only makes sense over an editable editor (Reading view is out
        // of scope for v1 interactions).
        glue.railWrapperEl.toggleClass('ai-editor-hidden', glue.view.getMode() === 'preview')
        // Narrow pane: the wrapper hugs the edge (every reclaimed pixel is a
        // pixel of text) and the rail itself renders in its compact form.
        const narrow = glue.layout === 'narrow'
        glue.railWrapperEl.toggleClass('ai-editor-rail-wrapper-compact', narrow)
        glue.rail.render({
            editors: this.buildRailEditors(run, transformRun),
            running:
                (run !== null && !run.isSettled()) ||
                (transformRun !== null && !transformRun.isSettled()),
            daemonArmed: filePath !== null && (this.daemon?.isArmed(filePath) ?? false),
            narrow
        })
        this.dispatchDecorations(glue, run)
        this.dispatchCardRefresh(glue, run)
        // File/doc coherence: right after this glue rebound to a different
        // file (note switch, fresh mount), Obsidian has assigned `view.file`
        // but the async content load may not have replaced the CM document
        // yet — the same load window `handleEditorUpdate`'s file-path guard
        // defends against. The preview dispatch must not treat that stale
        // document as evidence the file's text changed.
        this.dispatchTransformPreview(glue, transformRun, previousPath !== filePath)
    }

    /**
     * Keeps an open finding card in sync with the store while a push-back
     * thread is live (plan M4): the reply arrives long after the click that
     * opened the card, so nothing else would re-render it. Dispatched only
     * when some finding of the run actually has thread activity — the common
     * (thread-free) refresh path stays a no-op, and the card's own handler
     * ignores the effect when no card is open.
     */
    private dispatchCardRefresh(glue: ViewGlue, run: RunHandle | null): void {
        if (
            run === null ||
            !run.findings
                .list()
                .some((finding) => finding.thread.length > 0 || finding.threadTurn !== null)
        ) {
            return
        }
        editorViewOf(glue.view)?.dispatch({ effects: refreshFindingCardEffect.of(null) })
    }

    private buildRailEditors(
        run: RunHandle | null,
        transformRun: TransformRunHandle | null
    ): RailEditorState[] {
        const settings = this.deps.getSettings()
        // An in-flight transform overlays its editor's review status: the
        // chip pulses ("transforming" / "waiting") while the action runs,
        // and falls back to the review projection once it settles.
        const transformActive =
            transformRun !== null && !transformRun.isSettled() ? transformRun : null
        return settings.editors
            .filter((editor) => editor.enabled && editor.capabilities.review)
            .map((editor) => {
                const state = run?.getEditorState(editor.id) ?? null
                const errorReason =
                    state?.status === 'error' && state.error
                        ? railErrorReason(state.error.code)
                        : undefined
                const reviewStatus = state ? railStatusOf(state.status) : 'idle'
                const status: RailEditorStatus =
                    transformActive && transformActive.editorId === editor.id
                        ? transformActive.getState().status === 'pending'
                            ? 'pending'
                            : 'transforming'
                        : reviewStatus
                return {
                    id: editor.id,
                    name: editor.name,
                    color: editor.color,
                    status,
                    findingCount: state ? state.findingIds.length : 0,
                    ...(errorReason === undefined ? {} : { errorReason })
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
        // The triage cursor rides the specs so it survives full rebuilds
        // (see finding-decorations.ts). Reading through the store validates
        // run identity: a cursor left behind by a replaced run is evicted
        // right here, on the first rebuild that could have shown it.
        const cursor = this.triageCursors.get(run.snapshot.filePath, run)
        const specs: FindingDecorationSpec[] = []
        // Severity filter: hidden findings render nothing at all (they stay in
        // the store, and the panel's filter control says how many are hidden).
        for (const finding of this.visibleFindings(run.snapshot.filePath, run)) {
            if (finding.anchor === null) {
                continue
            }
            if (finding.status !== 'open' && finding.status !== 'preview') {
                continue
            }
            const stale = finding.anchor.state === 'stale'
            specs.push({
                findingId: finding.id,
                editorId: finding.editorId,
                from: finding.anchor.from,
                to: finding.anchor.to,
                color: colors.get(finding.editorId) ?? 'var(--text-accent)',
                stale,
                current: cursor !== null && cursor.id === finding.id && !stale
            })
        }
        return specs
    }

    private editorColors(): Map<string, string> {
        return new Map(this.deps.getSettings().editors.map((editor) => [editor.id, editor.color]))
    }

    // -- Transform preview (non-destructive inline diff, Business Rules #2/#3)

    /**
     * Resolves the file's transform run for presentation, absorbing terminal
     * failures: an errored run surfaces ONE Notice (message already redacted
     * by the handle) and is discarded; a cancelled run is discarded silently.
     * Returns null for both so no surface renders a dead run.
     */
    private reconcileTransformRun(filePath: string): TransformRunHandle | null {
        const run = this.deps.transformController.getRun(filePath)
        if (!run) {
            return null
        }
        const state = run.getState()
        if (state.status === 'error') {
            if (!this.notifiedTransformErrors.has(String(run.runId))) {
                this.notifiedTransformErrors.add(String(run.runId))
                const label = run.actionLabel ?? 'Action'
                new Notice(
                    `${label} failed (${run.editorName}): ${state.error?.message ?? 'unknown error'}`
                )
            }
            this.deps.transformController.discardRun(filePath)
            return null
        }
        if (state.status === 'cancelled') {
            this.deps.transformController.discardRun(filePath)
            return null
        }
        return run
    }

    /**
     * Projects the glue's transform run into the preview widget: a run that
     * is done AND still applicable (apply precondition against the CURRENT
     * document, Business Rules #3) shows the inline diff; everything else
     * clears it. When a presented result goes stale (an edit touched the
     * target), the widget auto-dismisses with one Notice — stale proposals
     * are never fuzzy-relocated, the user re-runs the action (BR #3/#4).
     * Dispatch is keyed by runId so refresh cycles are no-ops while nothing
     * changed (the decoration maps itself through unrelated edits).
     *
     * `fileRebound` marks a refresh cycle in which the glue just rebound to
     * this file: the CM document may still hold the PREVIOUS note's text
     * (Obsidian assigns `view.file` before the async content load replaces
     * the doc), so a failed precondition proves nothing about the file's
     * actual content. On such a cycle the widget stays cleared but the done
     * run is NOT discarded — the doc-replacing load transaction schedules
     * the next refresh (via `handleEditorUpdate`'s settled-transform hook),
     * which re-checks against the real document and then either presents
     * the result or discards it for good.
     */
    private dispatchTransformPreview(
        glue: ViewGlue,
        run: TransformRunHandle | null,
        fileRebound: boolean
    ): void {
        const editorView = editorViewOf(glue.view)
        if (!editorView) {
            return
        }
        let spec: TransformPreviewSpec | null = null
        if (run && glue.filePath === run.snapshot.filePath) {
            const state = run.getState()
            if (state.status === 'done' && state.outcome !== null) {
                const precondition = run.checkPrecondition(editorView.state.doc.toString())
                if (precondition.ok) {
                    spec = this.buildTransformPreviewSpec(glue, run, state.outcome)
                } else if (precondition.reason === 'text-changed' && !fileRebound) {
                    if (!this.notifiedTransformStale.has(String(run.runId))) {
                        this.notifiedTransformStale.add(String(run.runId))
                        new Notice(
                            'The text changed — the proposed edit was discarded. Run the action again.'
                        )
                    }
                    this.deps.transformController.discardRun(run.snapshot.filePath)
                }
            }
        }
        const key = spec ? spec.runId : ''
        if (key === glue.transformPreviewKey) {
            return
        }
        glue.transformPreviewKey = key
        editorView.dispatch({
            effects: spec
                ? [showTransformPreviewEffect.of(spec)]
                : [clearTransformPreviewEffect.of(null)]
        })
    }

    /** Widget content for one applicable done transform run (per glue). */
    private buildTransformPreviewSpec(
        glue: ViewGlue,
        run: TransformRunHandle,
        outcome: TransformOutcome
    ): TransformPreviewSpec {
        const target = run.target
        const segments: readonly DiffSegment[] =
            target.kind === 'replace-span'
                ? wordDiff(target.spanText, outcome.text)
                : [{ kind: 'ins', text: outcome.text }]
        const editor = this.deps
            .getSettings()
            .editors.find((candidate) => candidate.id === run.editorId)
        const label =
            run.actionLabel ??
            (target.kind === 'replace-span' ? 'Proposed replacement' : 'Proposed insertion')
        return {
            runId: String(run.runId),
            kind: run.kind,
            anchor: target.kind === 'replace-span' ? target.to : target.position,
            title: `${label} — ${run.editorName}`,
            editorColor: editor?.color ?? 'var(--text-accent)',
            segments,
            rationale: outcome.rationale,
            actions: {
                onAccept: (): void => {
                    this.acceptTransform(glue, run)
                },
                onReject: (): void => {
                    this.rejectTransform(glue, run)
                }
            }
        }
    }

    /**
     * Accept (Business Rules #2/#3): the precondition is re-verified against
     * the CURRENT document in the same synchronous block as the apply; only
     * then does the replacement/insertion go out as ONE editor transaction
     * (single undo step) that also removes the widget. The transaction is
     * `isolateHistory`-annotated ('full') so it never merges with adjacent
     * user typing in either direction — without it, CM6's history joins an
     * annotation-less transaction to the previous event (and later
     * `input.type` events to it) when adjacent and within `newGroupDelay`,
     * making Ctrl+Z revert the transform AND the user's own keystrokes.
     * On failure the widget
     * stays and a Notice explains — a stale race additionally auto-dismisses
     * through the refresh cycle. The dispatched edit reaches the review
     * run's anchor store through the canonical-view forwarding like any
     * user edit.
     */
    private acceptTransform(glue: ViewGlue, run: TransformRunHandle): void {
        const editorView = editorViewOf(glue.view)
        if (!editorView || this.disposed) {
            return
        }
        const precondition = run.checkPrecondition(editorView.state.doc.toString())
        if (!precondition.ok) {
            new Notice('The text changed since this result was computed — run the action again.')
            this.scheduleRefresh()
            return
        }
        const target = run.target
        const from = target.kind === 'replace-span' ? target.from : target.position
        const to = target.kind === 'replace-span' ? target.to : target.position
        const insert = precondition.outcome.text
        editorView.dispatch({
            changes: { from, to, insert },
            effects: clearTransformPreviewEffect.of(null),
            selection: { anchor: from + insert.length },
            scrollIntoView: true,
            annotations: isolateHistory.of('full')
        })
        editorView.focus()
        glue.transformPreviewKey = ''
        this.deps.transformController.discardRun(run.snapshot.filePath)
        this.scheduleRefresh()
    }

    /** Reject: remove the widget and forget the run — nothing else. */
    private rejectTransform(glue: ViewGlue, run: TransformRunHandle): void {
        const editorView = editorViewOf(glue.view)
        if (editorView) {
            editorView.dispatch({ effects: clearTransformPreviewEffect.of(null) })
            editorView.focus()
        }
        glue.transformPreviewKey = ''
        this.deps.transformController.discardRun(run.snapshot.filePath)
        this.scheduleRefresh()
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

    /**
     * Returns the view the finding was revealed in (`null` when nothing was
     * revealed) so triage stepping can chain the card open onto it.
     */
    private async revealFinding(
        filePath: string,
        findingId: FindingId
    ): Promise<MarkdownView | null> {
        const run = this.deps.runController.getRun(filePath)
        const finding = run?.findings.get(findingId) ?? null
        if (!finding || finding.anchor === null || finding.anchor.state !== 'anchored') {
            return null
        }
        const view = await this.openMarkdownView(filePath)
        if (!view) {
            return null
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
        return view
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
            // Distinct from 'running' so the chip tooltip can say "waiting"
            // while the editor queues behind the concurrency limit.
            return 'pending'
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
