import { generateId } from '../../domain/ids'
import { CONTRACT_VERSION, type OperationRequest } from '../../domain/operations/contract'
import type { EditorConfig, PluginSettingsV1 } from '../../domain/settings/settings-schema'
import { hashText } from '../../domain/snapshot'
import { createBackendExecutor } from '../backends/backend-executor'
import { resolveFetchImpl, type FetchFn } from '../backends/resolve-fetch'
import { isExcluded } from '../context/exclusions'
import type { VaultReader } from '../context/vault-reader.intf'
import type { Semaphore } from '../orchestration/semaphore'
import { noteRuleOutcome } from '../rules/note-rules'
import { resolveEditorBackend, type EditorSkip } from '../review-service'
import type { MemoryJournal, MemoryJournalEvent } from './memory-journal'
import { clipMemory, deriveNoteMemory, normalizeMemoryNotePath } from './memory-note'

/**
 * Memory distillation (issue #4): turns one editor's session triage journal
 * into a PROPOSED rewritten memory — one backend request on the editor's own
 * backend, user-command-only (Business Rules #1), and nothing is saved here:
 * the caller shows the proposal in an editable confirmation modal and only a
 * confirmed save writes anywhere (Business Rules #2/#22).
 *
 * Obsidian-free like `thread-service.ts`: vault, journal, gate and fetch are
 * injected. Refusals are typed results, never throws; error messages pass the
 * executor's redaction seam (Business Rules #12).
 *
 * The journal is deliberately NOT cleared here — clearing happens on the save
 * path, after the user confirmed, so a failed or cancelled request never eats
 * the session's signal.
 *
 * System prompt: a fixed distiller preamble + the editor's DIRECT persona
 * text (`editor.prompt.text`, clipped). Deliberately not `buildEditorPrompt`
 * — that assembly is note-centric (voice profile, linked notes, a review
 * target this operation does not have) and the voice profile is irrelevant to
 * "what did the author accept": the persona text alone tells the model who
 * "you" is in the rules it writes (see Architecture.md § Memory distillation).
 */

/** Bound on the persona text carried into the distiller system prompt. */
const PERSONA_TEXT_CLIP = 20_000

const DISTILLER_PREAMBLE =
    'You are maintaining your own learning memory: a short list of rules about ' +
    'what this author accepts, rejects, and argues about, distilled from how they ' +
    'triaged your findings. The memory is injected into your future reviews, so ' +
    'write it as instructions to yourself. Your persona follows.'

export type DistillMemoryOutcome =
    /** A proposed memory came back; show it for confirmation, then save. */
    | {
          readonly status: 'distilled'
          readonly editor: EditorConfig
          /** The memory the proposal replaces (settings text or note body). */
          readonly previousMemory: string
          readonly proposedMemory: string
          /** Events actually sent. */
          readonly eventCount: number
          /** Events dropped because their note is now excluded/kill-switched. */
          readonly droppedEvents: number
          /**
           * Newest journal `seq` this distillation snapshotted (sent OR
           * dropped). The save path clears the journal up to exactly this
           * mark — decisions recorded mid-flight carry a higher seq and
           * survive.
           */
          readonly snapshotSeq: number
      }
    /** The editor cannot run; `skip` says why (null: id no longer resolves). */
    | { readonly status: 'no-editor'; readonly skip: EditorSkip | null }
    /** The editor's memory feature is off — nowhere to save a distillation. */
    | { readonly status: 'memory-off' }
    /** `memory: 'note'` with no note path configured — no save destination. */
    | { readonly status: 'no-memory-note-path' }
    /**
     * `memory: 'note'` with a path that cannot stay inside the vault
     * (absolute, or carrying `.`/`..` segments) — refused before any vault
     * access, read or write (AGENTS.md path-safety rule).
     */
    | { readonly status: 'invalid-memory-note-path'; readonly notePath: string }
    /** The memory note is excluded: its content must not be sent (BR #7). */
    | { readonly status: 'memory-note-excluded'; readonly notePath: string }
    /** No journal events survive the exclusion filter (or none exist). */
    | { readonly status: 'nothing-to-distill'; readonly droppedEvents: number }
    | { readonly status: 'cancelled' }
    | { readonly status: 'failed'; readonly message: string }

export interface DistillEditorMemoryInput {
    readonly settings: PluginSettingsV1
    readonly vault: VaultReader
    readonly journal: MemoryJournal
    /** The plugin-wide request gate (BR #15: one shared budget). */
    readonly requestGate: Semaphore
    readonly editorId: string
    readonly signal: AbortSignal
    /** Injected network seam; defaults to the runtime's `fetch`. */
    readonly fetchImpl?: FetchFn
}

/** Events whose note is NOW excluded or rule-disabled are dropped (BR #7). */
function eligibleEvents(
    events: readonly MemoryJournalEvent[],
    vault: VaultReader,
    settings: PluginSettingsV1
): readonly MemoryJournalEvent[] {
    return events.filter(
        (event) =>
            !isExcluded(event.notePath, vault.getNoteMetadata(event.notePath), settings.behavior) &&
            noteRuleOutcome(event.notePath, vault, settings).kind !== 'disabled'
    )
}

export async function distillEditorMemory(
    input: DistillEditorMemoryInput
): Promise<DistillMemoryOutcome> {
    const { settings, vault, journal, editorId } = input

    // -- Resolve the editor and its backend (typed refusals) -----------------
    const editor = settings.editors.find((candidate) => candidate.id === editorId)
    if (!editor) {
        return { status: 'no-editor', skip: null }
    }
    const skipOf = (reason: EditorSkip['reason']): DistillMemoryOutcome => ({
        status: 'no-editor',
        skip: { editorId: editor.id, editorName: editor.name, reason }
    })
    if (!editor.enabled) {
        return skipOf('editor-disabled')
    }
    if (editor.memory === 'off') {
        return { status: 'memory-off' }
    }
    const resolution = resolveEditorBackend(settings, editor)
    if (!resolution.ok) {
        return skipOf(resolution.reason)
    }

    // -- Journal events, re-filtered against exclusions at consume time ------
    const recorded = journal.eventsFor(editorId)
    const events = eligibleEvents(recorded, vault, settings)
    const droppedEvents = recorded.length - events.length
    if (events.length === 0) {
        return { status: 'nothing-to-distill', droppedEvents }
    }
    // Newest seq this snapshot covers (sent or dropped) — the save path
    // clears up to it, by identity, so mid-flight decisions survive even
    // when the ring evicts under them.
    const snapshotSeq = recorded[recorded.length - 1]?.seq ?? 0

    // -- Current memory (what the proposal replaces) -------------------------
    let currentMemory: string
    if (editor.memory === 'settings') {
        currentMemory = clipMemory(editor.memoryText)
    } else {
        const rawPath = editor.memoryNotePath.trim()
        if (rawPath.length === 0) {
            return { status: 'no-memory-note-path' }
        }
        const notePath = normalizeMemoryNotePath(editor.memoryNotePath)
        if (notePath.length === 0) {
            // Non-empty input the normalizer refused: the path would escape
            // the vault. Named distinctly — "no path is set" would misdirect.
            return { status: 'invalid-memory-note-path', notePath: rawPath }
        }
        const content = await vault.readNote(notePath)
        // BR #7: the memory note's CONTENT would be sent as `currentMemory`,
        // so an excluded memory note refuses the whole distillation. An
        // ABSENT note (content null — the documented create-on-save flow)
        // factually has no tags and no frontmatter, so it is checked with
        // empty metadata: folder exclusions still apply to the would-be
        // path, while the fail-closed null-metadata branch (meant for cold
        // caches on EXISTING notes) no longer makes the default
        // `respectFrontmatterOptOut` swallow the first distillation.
        const metadata =
            content === null ? { tags: [], frontmatter: {} } : vault.getNoteMetadata(notePath)
        if (isExcluded(notePath, metadata, settings.behavior)) {
            return { status: 'memory-note-excluded', notePath }
        }
        // Missing note: first distillation, empty current memory.
        currentMemory = deriveNoteMemory(content)
    }

    // -- One request, on the editor's own backend ----------------------------
    const personaText = editor.prompt.text.trim().slice(0, PERSONA_TEXT_CLIP)
    const systemPrompt = [DISTILLER_PREAMBLE, personaText]
        .filter((segment) => segment.length > 0)
        .join('\n\n')
    const request: OperationRequest = {
        contractVersion: CONTRACT_VERSION,
        runId: generateId(),
        snapshotHash: hashText(currentMemory),
        kind: 'distill-memory',
        currentMemory,
        events: events.map((event) => ({
            quote: event.quote,
            critique: event.critique,
            severity: event.severity,
            decision: event.decision,
            thread: event.thread.map((turn) => ({ role: turn.role, content: turn.content }))
        }))
    }
    const executor = createBackendExecutor({
        backend: resolution.backend,
        model: resolution.model,
        systemPrompt,
        behavior: settings.behavior,
        fetchImpl: resolveFetchImpl(input.fetchImpl)
    })

    // Foreground work on the shared budget (BR #15): an explicit user gesture
    // acquires the gate directly, exactly like a review editor does.
    let release: () => void
    try {
        release = await input.requestGate.acquire(input.signal)
    } catch {
        return { status: 'cancelled' }
    }
    try {
        for await (const event of executor.execute(request, input.signal)) {
            if (event.type === 'result') {
                if (event.result.kind !== 'distill-memory') {
                    return {
                        status: 'failed',
                        message: `Expected a 'distill-memory' result, got '${event.result.kind}'`
                    }
                }
                return {
                    status: 'distilled',
                    editor,
                    previousMemory: currentMemory,
                    proposedMemory: event.result.memory,
                    eventCount: events.length,
                    droppedEvents,
                    snapshotSeq
                }
            }
            if (event.type === 'error') {
                if (event.error.code === 'cancelled') {
                    return { status: 'cancelled' }
                }
                return { status: 'failed', message: executor.redactError(event.error.message) }
            }
            // progress / finding events carry nothing for this operation.
        }
        return { status: 'failed', message: 'The backend produced no result.' }
    } finally {
        release()
    }
}
