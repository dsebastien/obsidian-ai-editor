import { FuzzySuggestModal, Notice } from 'obsidian'
import type { App, Plugin } from 'obsidian'
import type { EditorConfig, PluginSettingsV1 } from '../domain/settings/settings-schema'
import { distillEditorMemory } from '../services/memory/memory-distiller'
import type { DistillMemoryOutcome } from '../services/memory/memory-distiller'
import type { MemoryJournal } from '../services/memory/memory-journal'
import {
    clipMemory,
    deriveNoteMemory,
    normalizeMemoryNotePath,
    replaceMemoryBody
} from '../services/memory/memory-note'
import type { Semaphore } from '../services/orchestration/semaphore'
import { skipReasonLabel } from '../services/review-service'
import { MemoryReviewModal } from '../ui/memory-review-modal'
import { ObsidianVaultReader } from '../ui/obsidian-vault-reader'

/**
 * `Distill editor learnings` (issue #4): the ONE trigger of the memory
 * learning loop. Business Rules #1/#22 — distillation never fires
 * automatically; this explicit command consumes the session's triage journal,
 * runs one request on the editor's own backend, and routes the proposal
 * through the editable confirmation modal (BR #2). The journal is cleared
 * only after a confirmed save.
 */

/** The slice of an editor the availability gate reads (pure, spec-covered). */
export interface DistillGateEditor {
    readonly id: string
    readonly enabled: boolean
    readonly memory: 'off' | 'settings' | 'note'
}

/**
 * Editors the command can target: enabled, memory on, and at least one
 * journal event this session. Empty → the command is hidden (BR #14: gated
 * commands are hidden, never shown dead).
 */
export function distillableEditorIds(
    editors: readonly DistillGateEditor[],
    hasEvents: (editorId: string) => boolean
): readonly string[] {
    return editors
        .filter((editor) => editor.enabled && editor.memory !== 'off' && hasEvents(editor.id))
        .map((editor) => editor.id)
}

export interface MemoryCommandDeps {
    readonly getSettings: () => PluginSettingsV1
    readonly journal: MemoryJournal
    /** The plugin-wide request gate (`RunController.requestGate`, BR #15). */
    readonly requestGate: Semaphore
    /**
     * Persists `memoryText` for one editor — a narrow seam injected from
     * `plugin.ts` (the `setDaemonAlwaysOn` precedent): the command never
     * holds the whole settings facade.
     */
    readonly saveEditorMemory: (editorId: string, memory: string) => Promise<void>
}

/** Editor picker when several editors qualify (AGENTS.md: never hand-rolled). */
class DistillEditorSuggestModal extends FuzzySuggestModal<EditorConfig> {
    constructor(
        app: App,
        private readonly editors: readonly EditorConfig[],
        private readonly onPick: (editor: EditorConfig) => void
    ) {
        super(app)
        this.setPlaceholder('Distill learnings for which editor?')
    }

    override getItems(): EditorConfig[] {
        return [...this.editors]
    }

    override getItemText(editor: EditorConfig): string {
        return editor.name
    }

    override onChooseItem(editor: EditorConfig): void {
        this.onPick(editor)
    }
}

export function registerMemoryCommands(plugin: Plugin, deps: MemoryCommandDeps): void {
    // Editors with a distillation in flight (request running OR review modal
    // pending). The command hides them — a second invoke would run a second
    // paid request over the same events and stack two modals whose saves
    // silently overwrite each other. Cleared when the flow settles (refusal,
    // failure, or the modal closing either way).
    const inFlight = new Set<string>()
    // One unload registration for every distillation this session — Obsidian
    // has no unregister, so a per-invocation `plugin.register` would leak one
    // dead closure per run onto the unload list.
    const activeAborts = new Set<AbortController>()
    plugin.register(() => {
        for (const abort of activeAborts) {
            abort.abort()
        }
    })
    plugin.addCommand({
        id: 'distill-editor-memory',
        name: 'Distill editor learnings',
        checkCallback: (checking: boolean): boolean => {
            const settings = deps.getSettings()
            const eligible = distillableEditorIds(
                settings.editors,
                (editorId) => !inFlight.has(editorId) && deps.journal.countFor(editorId) > 0
            )
            if (eligible.length === 0) {
                return false
            }
            if (checking) {
                return true
            }
            const editors = settings.editors.filter((editor) => eligible.includes(editor.id))
            const first = editors[0]
            if (editors.length === 1 && first) {
                void runDistillation(plugin, deps, first.id, inFlight, activeAborts)
            } else {
                new DistillEditorSuggestModal(plugin.app, editors, (editor) => {
                    void runDistillation(plugin, deps, editor.id, inFlight, activeAborts)
                }).open()
            }
            return true
        }
    })
}

async function runDistillation(
    plugin: Plugin,
    deps: MemoryCommandDeps,
    editorId: string,
    inFlight: Set<string>,
    activeAborts: Set<AbortController>
): Promise<void> {
    if (inFlight.has(editorId)) {
        return
    }
    inFlight.add(editorId)
    const abort = new AbortController()
    // Dies with the plugin: an unload must not leave the request running.
    activeAborts.add(abort)
    new Notice('AI Editor: distilling learnings…')
    let outcome: DistillMemoryOutcome
    try {
        outcome = await distillEditorMemory({
            settings: deps.getSettings(),
            vault: new ObsidianVaultReader(plugin.app),
            journal: deps.journal,
            requestGate: deps.requestGate,
            editorId,
            signal: abort.signal
        })
    } catch (error) {
        inFlight.delete(editorId)
        new Notice(
            `AI Editor: distillation failed (${error instanceof Error ? error.message : String(error)})`
        )
        return
    } finally {
        activeAborts.delete(abort)
    }
    if (outcome.status !== 'distilled') {
        // Every refusal path ends the flow here; only a distilled outcome
        // keeps the editor in-flight until its review modal closes.
        inFlight.delete(editorId)
    }
    switch (outcome.status) {
        case 'distilled':
            // Stays in-flight until the review modal closes (save or cancel).
            openReviewModal(plugin, deps, outcome, () => inFlight.delete(editorId))
            return
        case 'no-editor':
            new Notice(
                outcome.skip
                    ? `AI Editor: ${outcome.skip.editorName} cannot distill — ${skipReasonLabel(outcome.skip.reason)}.`
                    : 'AI Editor: that editor no longer exists.'
            )
            return
        case 'memory-off':
            new Notice('AI Editor: learning memory is off for this editor — enable it first.')
            return
        case 'no-memory-note-path':
            new Notice(
                'AI Editor: this editor stores memory in a vault note, but no note path is set.'
            )
            return
        case 'invalid-memory-note-path':
            new Notice(
                `AI Editor: the memory note path must stay inside the vault — remove leading slashes and "." or ".." segments (${outcome.notePath}).`
            )
            return
        case 'memory-note-excluded':
            new Notice(
                `AI Editor: the memory note is excluded from AI processing (${outcome.notePath}).`
            )
            return
        case 'nothing-to-distill':
            new Notice(
                outcome.droppedEvents > 0
                    ? 'AI Editor: nothing to distill — every recorded decision is on a now-excluded note.'
                    : 'AI Editor: nothing to distill yet — triage some findings first.'
            )
            return
        case 'cancelled':
            return
        case 'failed':
            new Notice(`AI Editor: distillation failed (${outcome.message})`)
            return
    }
}

function openReviewModal(
    plugin: Plugin,
    deps: MemoryCommandDeps,
    outcome: Extract<DistillMemoryOutcome, { status: 'distilled' }>,
    onDone: () => void
): void {
    const editor = outcome.editor
    const toNote = editor.memory === 'note'
    const notePath = normalizeMemoryNotePath(editor.memoryNotePath)
    new MemoryReviewModal(plugin.app, {
        editorName: editor.name,
        destinationLabel: toNote ? `"${notePath}"` : 'the plugin settings',
        eventCount: outcome.eventCount,
        previousMemory: outcome.previousMemory,
        proposedMemory: outcome.proposedMemory,
        onSave: async (memory): Promise<void> => {
            // The proposal was distilled FROM `previousMemory`. If the
            // destination changed while the request ran or the modal sat
            // open (the user edited the note or the settings field), a
            // silent overwrite would destroy edits the proposal never saw —
            // surface the conflict instead (the modal stays open; BR #2's
            // exact-review promise covers what the save REPLACES too).
            const current = toNote
                ? await readCurrentNoteMemory(plugin.app, notePath)
                : currentSettingsMemory(deps.getSettings(), editor.id)
            if (memoryChangedOutside(current, outcome.previousMemory)) {
                throw new Error(
                    'the memory changed while this proposal was open — cancel, review the current memory, and distill again'
                )
            }
            if (toNote) {
                await writeMemoryNote(plugin.app, notePath, memory)
            } else {
                await deps.saveEditorMemory(editor.id, memory)
            }
            // Only a confirmed, successful save consumes the session's
            // signal — and only the events the distillation actually SAW
            // (its snapshot, identified by seq: sent + dropped-as-excluded).
            // Decisions recorded while the request or the modal was pending
            // carry a higher seq and stay journaled.
            deps.journal.clear(editor.id, outcome.snapshotSeq)
            new Notice(`AI Editor: ${editor.name}'s memory updated.`)
        },
        onDone
    }).open()
}

/**
 * The destination's memory as a save would see it NOW — derived exactly like
 * the distiller derived `previousMemory` (same `deriveNoteMemory`), so the
 * conflict comparison in `onSave` can never misfire on a derivation
 * difference.
 */
async function readCurrentNoteMemory(app: App, path: string): Promise<string> {
    const file = app.vault.getFileByPath(path)
    return deriveNoteMemory(file ? await app.vault.read(file) : null)
}

/**
 * Settings-mode counterpart of `readCurrentNoteMemory`. `null` when the
 * editor no longer exists — no comparison then; `saveEditorMemory` raises
 * its own "editor no longer exists" error, which is the accurate message.
 */
export function currentSettingsMemory(settings: PluginSettingsV1, editorId: string): string | null {
    const editor = settings.editors.find((candidate) => candidate.id === editorId)
    return editor ? clipMemory(editor.memoryText) : null
}

/**
 * The save path's conflict predicate: the destination changed under the
 * open proposal exactly when its CURRENT memory (derived the same way the
 * distiller derived `previousMemory`) no longer matches. `null` current
 * (editor deleted) is not a content conflict — the save itself reports the
 * missing editor.
 */
export function memoryChangedOutside(current: string | null, previousMemory: string): boolean {
    return current !== null && current !== previousMemory
}

/**
 * Writes the confirmed memory into the designated vault note, replacing the
 * body and preserving frontmatter (`replaceMemoryBody`); creates the note —
 * and its parent folders — when missing. The plugin's only vault-note write
 * outside CM6 edits: user-confirmed content into a note the user explicitly
 * designated (BR #22; distinct from BR #13's margin comments).
 */
async function writeMemoryNote(app: App, path: string, memory: string): Promise<void> {
    // Defense in depth on the ONE vault-note write seam: the path always
    // comes from `normalizeMemoryNotePath`, which maps traversal/absolute
    // input to '' — never let that reach `createFolder`/`create`.
    if (path.length === 0) {
        throw new Error('the memory note path is empty or would leave the vault')
    }
    const file = app.vault.getFileByPath(path)
    if (file) {
        await app.vault.process(file, (existing) => replaceMemoryBody(existing, memory))
        return
    }
    const segments = path.split('/').slice(0, -1)
    let folder = ''
    for (const segment of segments) {
        folder = folder.length === 0 ? segment : `${folder}/${segment}`
        if (app.vault.getFolderByPath(folder) === null) {
            await app.vault.createFolder(folder)
        }
    }
    await app.vault.create(path, replaceMemoryBody('', memory))
}
