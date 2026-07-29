import type {
    ApiBackend,
    BehaviorSettings,
    EditorConfig,
    PluginSettingsV1
} from '../domain/settings/settings-schema'
import type { DocumentSnapshot } from '../domain/snapshot'
import { createApiEditorExecutor } from './backends/api-editor-backend'
import { redactSecret } from './backends/providers'
import { ExcludedTargetError, assembleContext } from './context/context-assembler'
import type { AssembledContext } from './context/context-assembler'
import { isExcluded } from './context/exclusions'
import type { VaultReader } from './context/vault-reader.intf'
import type { RunController, RunEditorSpec, RunHandle } from './orchestration/run-controller'

/**
 * Review-run entry point: turns settings + a document snapshot into one
 * orchestrated run against the configured API backends.
 *
 * Obsidian-free by design: the vault is injected as `VaultReader`, the
 * network as `fetchImpl`, so every decision in here (exclusion refusal, size
 * guard, editor/backend resolution, skip reporting) is unit-testable.
 *
 * Guarantees enforced here:
 * - Privacy exclusions are checked BEFORE anything else — an excluded target
 *   never reaches context assembly or a backend (Business Rules #7).
 * - Nothing runs without an explicit user action: this function is only ever
 *   invoked from the Review command / rail button (Business Rules #1), and
 *   oversized notes additionally require a user-confirmed flag.
 * - Error messages that could echo credentials are routed through the
 *   redaction seam (Business Rules #12).
 */

// ---------------------------------------------------------------------------
// Skip reporting
// ---------------------------------------------------------------------------

export type SkipReason =
    | 'no-review-capability'
    | 'no-backend-configured'
    | 'backend-not-found'
    | 'backend-disabled'
    | 'cli-backend-unsupported'
    | 'no-model-configured'

/** One editor that could not participate in the run, and why. */
export interface EditorSkip {
    readonly editorId: string
    readonly editorName: string
    readonly reason: SkipReason
}

/** Human-readable label for a skip reason (used in Notices and the panel). */
export function skipReasonLabel(reason: SkipReason): string {
    switch (reason) {
        case 'no-review-capability':
            return 'review capability disabled'
        case 'no-backend-configured':
            return 'no backend configured (set a default backend or assign one)'
        case 'backend-not-found':
            return 'its backend no longer exists'
        case 'backend-disabled':
            return 'its backend is disabled'
        case 'cli-backend-unsupported':
            return 'CLI backends are not supported yet'
        case 'no-model-configured':
            return 'no model configured'
    }
}

// ---------------------------------------------------------------------------
// Per-run instruction (freeform "Ask an editor", design §6 decision 1)
// ---------------------------------------------------------------------------

/**
 * One-run-only instruction for a single editor: the run is narrowed to
 * exactly `editorId` and that editor's composed system prompt is augmented
 * with `text` via `augmentSystemPrompt`. Nothing is persisted — settings are
 * never mutated, the next run assembles its prompt from scratch.
 */
export interface RunInstruction {
    readonly editorId: string
    readonly text: string
}

// ---------------------------------------------------------------------------
// Start result (discriminated: callers must handle every refusal)
// ---------------------------------------------------------------------------

export type ReviewStart =
    | {
          readonly status: 'started'
          readonly run: RunHandle
          readonly skips: readonly EditorSkip[]
          /**
           * True when `requestedSelection` was provided but no longer valid at
           * run start (bounds outside the fresh snapshot, degenerate range, or
           * the text changed since capture) and the run fell back to whole-note
           * scope. Callers should surface this ("Selection changed — reviewing
           * the whole note"). Always false when no selection was requested.
           */
          readonly selectionFallback: boolean
      }
    /** Typed refusal: the target note is excluded (Business Rules #7). */
    | { readonly status: 'excluded'; readonly notePath: string }
    /** No editor could run; `skips` explains each candidate. */
    | { readonly status: 'no-editors'; readonly skips: readonly EditorSkip[] }
    /**
     * The note exceeds `behavior.sizeWarningWords`; the caller must show a
     * confirmation dialog and retry with `confirmedLargeNote: true`.
     */
    | {
          readonly status: 'needs-confirmation'
          readonly wordCount: number
          readonly limit: number
      }

export interface StartReviewInput {
    readonly settings: PluginSettingsV1
    readonly snapshot: DocumentSnapshot
    readonly vault: VaultReader
    readonly runController: RunController
    /** Injected network seam; defaults to the runtime's `fetch`. */
    readonly fetchImpl?: typeof fetch
    /** Set after the user explicitly confirmed the size warning. */
    readonly confirmedLargeNote?: boolean
    /**
     * Re-snapshots the live document. Called synchronously right before the
     * run starts: context assembly awaits vault reads, and edits typed during
     * those awaits would otherwise be invisible to the run's remap history
     * (findings anchor against the run snapshot; edit forwarding only starts
     * once the run exists — a stale snapshot would leave every anchor off by
     * the edit delta, Business Rules #3/#4). Return `null` when the live
     * document no longer belongs to `snapshot.filePath` (e.g. the view
     * switched notes mid-await) — the original snapshot is then used.
     */
    readonly refreshSnapshot?: () => DocumentSnapshot | null
    /**
     * Selection range the caller captured synchronously when the review was
     * requested (context-menu item or command callback — the selection-capture
     * contract of the interaction surfaces design §1). `capturedHash` is the
     * hash of the text the offsets were captured against — NOT necessarily
     * `snapshot.hash`: on the size-confirmation round trip the caller
     * re-snapshots after the modal, so validating against the input snapshot
     * would compare a hash with itself and let stale offsets through.
     * Re-validated against the fresh snapshot right before the run starts:
     * the range must be non-empty, ordered, inside the text, and the text
     * hash must still equal `capturedHash`. Valid → the run is
     * selection-scoped on exactly this range (taking precedence over any
     * selection the snapshots carry themselves); invalid → whole-note scope
     * with `selectionFallback: true` in the result.
     */
    readonly requestedSelection?: {
        readonly from: number
        readonly to: number
        readonly capturedHash: string
    }
    /**
     * Freeform "Ask an editor" scope (design §6 decision 1): when set, ONLY
     * the named editor participates (the other editors were not asked — they
     * are neither run nor reported as skips), and its fully composed system
     * prompt is augmented with the instruction text for this run only (see
     * `augmentSystemPrompt`; settings stay untouched). The instruction is
     * user content riding in the prompt — it cannot change the operation
     * contract: findings still stream through the same tool schema and
     * validate through the same Zod parsing as any review.
     */
    readonly instruction?: RunInstruction
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** Whitespace-delimited word count (size-guard input). */
export function countWords(text: string): number {
    const matches = text.match(/\S+/g)
    return matches ? matches.length : 0
}

/**
 * Whether a caller-captured selection can still scope a run against the fresh
 * snapshot taken at run start: the range must be non-empty, ordered, and
 * inside the text, and the text must be unchanged since capture (hash
 * equality with the capture-time snapshot). Offsets into changed text are
 * meaningless even when they still fit — a hash mismatch always invalidates.
 */
export function isRequestedSelectionValid(
    requested: { readonly from: number; readonly to: number },
    capturedHash: string,
    fresh: Pick<DocumentSnapshot, 'hash' | 'text'>
): boolean {
    if (requested.from >= requested.to) {
        return false // degenerate (from === to) or inverted range
    }
    if (requested.from < 0 || requested.to > fresh.text.length) {
        return false // out of bounds against the fresh text
    }
    return fresh.hash === capturedHash
}

export type BackendResolution =
    | { readonly ok: true; readonly backend: ApiBackend; readonly model: string }
    | { readonly ok: false; readonly reason: SkipReason }

/**
 * Resolves the API backend an editor runs on: the editor's own binding, or
 * the global default when set to inherit. Only enabled API-family backends
 * with a resolvable model are usable — anything else is a reported skip,
 * never a silent drop.
 */
export function resolveApiBackend(
    settings: PluginSettingsV1,
    editor: EditorConfig
): BackendResolution {
    const ref = editor.backend ?? settings.defaultBackend
    if (!ref) {
        return { ok: false, reason: 'no-backend-configured' }
    }
    const instance = settings.backends.find((backend) => backend.id === ref.backendId)
    if (!instance) {
        return { ok: false, reason: 'backend-not-found' }
    }
    if (!instance.enabled) {
        return { ok: false, reason: 'backend-disabled' }
    }
    if (instance.family !== 'api') {
        // SEAM (M7): CLI agent backends (Claude Code / Codex) plug in behind
        // the security boundary of Business Rules #9 once their executor
        // exists. Until then they are reported, never silently dropped.
        return { ok: false, reason: 'cli-backend-unsupported' }
    }
    const model = ref.model.length > 0 ? ref.model : instance.defaultModel
    if (model.length === 0) {
        return { ok: false, reason: 'no-model-configured' }
    }
    return { ok: true, backend: instance, model }
}

/**
 * Serializes an assembled context into the final system prompt: the direct
 * text fields followed by every attached vault note as a delimited block
 * (XML-style tags, consistent with the operation prompt serialization —
 * fences would break on markdown content).
 */
export function composeSystemPrompt(context: AssembledContext): string {
    if (context.attachments.length === 0) {
        return context.systemPrompt
    }
    const blocks = context.attachments.map((attachment) => {
        const path = attachment.path.replace(/"/g, "'")
        return `<context-note path="${path}">\n${attachment.content}\n</context-note>`
    })
    return [
        context.systemPrompt,
        "Reference material from the user's vault (context only — do not review these notes):",
        ...blocks
    ]
        .filter((segment) => segment.length > 0)
        .join('\n\n')
}

/**
 * Appends a one-run user instruction to a fully composed system prompt (the
 * "Ask an editor" seam). Applied AFTER `composeSystemPrompt` so the
 * instruction lands last — after persona text and context attachments —
 * where it is most salient to the model. The text is user content: it is
 * framed as review focus inside a delimited block (XML-style tag, consistent
 * with the attachment serialization) and explicitly subordinated to the
 * output contract — and even a hostile instruction cannot break that
 * contract structurally, because findings are emitted through the tool
 * schema and validated with Zod regardless of what the prompt says.
 * Blank instructions leave the prompt untouched.
 */
export function augmentSystemPrompt(basePrompt: string, instruction: string): string {
    const trimmed = instruction.trim()
    if (trimmed.length === 0) {
        return basePrompt
    }
    const block = [
        'The user asked you to focus this review on the following instruction.',
        'It only directs WHAT to look at — the required output format is unchanged:',
        `<user-instruction>\n${trimmed}\n</user-instruction>`
    ].join('\n')
    return [basePrompt, block].filter((segment) => segment.length > 0).join('\n\n')
}

// ---------------------------------------------------------------------------
// API editor specs
// ---------------------------------------------------------------------------

/**
 * Converts the behavior-level request timeout (seconds, user-facing) to the
 * milliseconds the transport consumes. One editor's whole API operation
 * (connect + full stream) is bounded by this — the setting exists precisely
 * because slow local models (Ollama on a laptop) stream for many minutes.
 */
export function reviewTimeoutMs(behavior: BehaviorSettings): number {
    return behavior.requestTimeoutSeconds * 1_000
}

/**
 * Builds the `RunEditorSpec` bridging one editor persona to its API backend.
 * The transport/protocol glue lives in `backends/api-editor-backend.ts`
 * (provider adapter + fetch, streaming for verified SSE providers, buffered
 * otherwise, exactly-one-terminal-event protocol). `redactError` is bound to
 * the backend's API key so any error message echoing the key never reaches
 * user-visible state (Business Rules #12) — defense in depth on top of the
 * executor's status-only error messages.
 */
export function createEditorSpec(input: {
    readonly editor: EditorConfig
    readonly backend: ApiBackend
    readonly model: string
    readonly systemPrompt: string
    readonly timeoutMs: number
    readonly fetchImpl: typeof fetch
}): RunEditorSpec {
    return {
        editorId: input.editor.id,
        editorName: input.editor.name,
        redactError: (message: string): string => redactSecret(message, input.backend.apiKey),
        execute: createApiEditorExecutor({
            backendConfig: input.backend,
            model: input.model,
            systemPrompt: input.systemPrompt,
            timeoutMs: input.timeoutMs,
            fetchImpl: input.fetchImpl
        })
    }
}

// ---------------------------------------------------------------------------
// Review orchestration
// ---------------------------------------------------------------------------

/**
 * Starts one review run for a snapshot: enforces the exclusion refusal and
 * the size guard, resolves the participating editors and their backends,
 * assembles per-editor context (exclusions applied to every attachment), and
 * hands the executors to the `RunController` (one active run per file).
 *
 * Returns the run handle plus a per-editor skip report; refusals are typed
 * results, never thrown.
 */
export async function startReview(input: StartReviewInput): Promise<ReviewStart> {
    const { settings, snapshot, vault, runController } = input
    const behavior = settings.behavior
    // Renderer `fetch` is the deliberate transport for API providers
    // (streaming for verified SSE providers, buffered otherwise —
    // `requestUrl` cannot stream; see Architecture — Backends). Callers
    // inside Obsidian pass `window.fetch`; this default covers tests and
    // headless use.
    const fetchImpl = input.fetchImpl ?? globalThis.fetch

    // -- Exclusions come first: fail closed before anything is read ----------
    if (isExcluded(snapshot.filePath, vault.getNoteMetadata(snapshot.filePath), behavior)) {
        return { status: 'excluded', notePath: snapshot.filePath }
    }

    // -- Size guard: oversized notes need an explicit user confirmation ------
    const wordCount = countWords(snapshot.text)
    if (wordCount > behavior.sizeWarningWords && input.confirmedLargeNote !== true) {
        return { status: 'needs-confirmation', wordCount, limit: behavior.sizeWarningWords }
    }

    // -- Resolve participants -------------------------------------------------
    // SEAM (M6): binding rules (folder/tag/frontmatter → default editors or
    // disabled) will narrow this selection per note. Until then every enabled
    // review-capable editor participates — unless a per-run instruction
    // narrows the run to the one editor the user asked (the others are not
    // candidates at all, so they never appear in the skip report). An
    // instruction whose editor no longer exists, is disabled, or cannot
    // dispatch yields `no-editors` like any other empty selection.
    const instruction = input.instruction
    const editorPool = instruction
        ? settings.editors.filter((editor) => editor.id === instruction.editorId)
        : settings.editors
    const skips: EditorSkip[] = []
    const participants: { editor: EditorConfig; backend: ApiBackend; model: string }[] = []
    for (const editor of editorPool) {
        if (!editor.enabled) {
            continue
        }
        if (!editor.capabilities.review) {
            skips.push({
                editorId: editor.id,
                editorName: editor.name,
                reason: 'no-review-capability'
            })
            continue
        }
        const resolution = resolveApiBackend(settings, editor)
        if (!resolution.ok) {
            skips.push({ editorId: editor.id, editorName: editor.name, reason: resolution.reason })
            continue
        }
        participants.push({ editor, backend: resolution.backend, model: resolution.model })
    }
    if (participants.length === 0) {
        return { status: 'no-editors', skips }
    }

    // -- Assemble context and build executors --------------------------------
    const editorSpecs: RunEditorSpec[] = []
    try {
        for (const participant of participants) {
            const context = await assembleContext({
                editor: participant.editor,
                voiceProfile: settings.voiceProfile,
                behavior,
                vault,
                notePath: snapshot.filePath,
                noteText: snapshot.text
            })
            const composedPrompt = composeSystemPrompt(context)
            editorSpecs.push(
                createEditorSpec({
                    editor: participant.editor,
                    backend: participant.backend,
                    model: participant.model,
                    systemPrompt:
                        instruction && participant.editor.id === instruction.editorId
                            ? augmentSystemPrompt(composedPrompt, instruction.text)
                            : composedPrompt,
                    timeoutMs: reviewTimeoutMs(behavior),
                    fetchImpl
                })
            )
        }
    } catch (cause) {
        // Defense in depth: the upfront check already covered the target.
        if (cause instanceof ExcludedTargetError) {
            return { status: 'excluded', notePath: cause.notePath }
        }
        throw cause
    }

    // -- Close the snapshot gap ----------------------------------------------
    // The awaits above (vault reads for voice profile / persona / wikilinks)
    // let the user keep typing; findings anchor against the run snapshot and
    // only edits made AFTER the run starts enter the remap history. Taking a
    // fresh snapshot here — synchronously, in the same block as `startRun` —
    // guarantees the run opens on the text the backends actually receive.
    // The original snapshot was only used for the size guard and context
    // budgeting, where slightly stale text is harmless. A refreshed snapshot
    // for a DIFFERENT file (view switched notes mid-await) is discarded.
    const refreshed = input.refreshSnapshot?.() ?? null
    let runSnapshot =
        refreshed !== null && refreshed.filePath === snapshot.filePath ? refreshed : snapshot

    // -- Apply the requested selection scope ---------------------------------
    // The caller captured `requestedSelection` synchronously against the text
    // hashed as `capturedHash`; the awaits above (and, on the size-guard
    // round trip, the confirmation modal) may have let the document change.
    // Re-validate against the snapshot the run will actually open on: still
    // valid → the run is selection-scoped on exactly the captured range
    // (overriding any live selection the refreshed snapshot picked up);
    // invalid → whole-note scope, reported via `selectionFallback` so the UI
    // can tell the user. Without a requested selection this block is inert —
    // the legacy snapshot-carried selection behavior is untouched.
    let selectionFallback = false
    const requested = input.requestedSelection
    if (requested) {
        if (isRequestedSelectionValid(requested, requested.capturedHash, runSnapshot)) {
            runSnapshot = {
                ...runSnapshot,
                selection: { from: requested.from, to: requested.to }
            }
        } else {
            selectionFallback = true
            runSnapshot = {
                id: runSnapshot.id,
                filePath: runSnapshot.filePath,
                text: runSnapshot.text,
                hash: runSnapshot.hash
            }
        }
    }

    const run = runController.startRun({ snapshot: runSnapshot, editors: editorSpecs })
    return { status: 'started', run, skips, selectionFallback }
}
