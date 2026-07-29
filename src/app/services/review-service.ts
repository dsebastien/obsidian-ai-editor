import type { ApiBackend, EditorConfig, PluginSettingsV1 } from '../domain/settings/settings-schema'
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
// Start result (discriminated: callers must handle every refusal)
// ---------------------------------------------------------------------------

export type ReviewStart =
    | {
          readonly status: 'started'
          readonly run: RunHandle
          readonly skips: readonly EditorSkip[]
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
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** Whitespace-delimited word count (size-guard input). */
export function countWords(text: string): number {
    const matches = text.match(/\S+/g)
    return matches ? matches.length : 0
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

// ---------------------------------------------------------------------------
// API editor specs
// ---------------------------------------------------------------------------

/**
 * Upper bound for one API review operation (connect + full stream), in ms.
 * API backends have no per-backend timeout setting yet (only CLI backends
 * expose `timeoutSeconds`); this constant is deliberately generous — long
 * notes against slow models stream for minutes. SEAM: promote to a behavior
 * setting if field reports need tuning.
 */
export const API_REVIEW_TIMEOUT_MS = 300_000

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
            timeoutMs: API_REVIEW_TIMEOUT_MS,
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
    // review-capable editor participates.
    const skips: EditorSkip[] = []
    const participants: { editor: EditorConfig; backend: ApiBackend; model: string }[] = []
    for (const editor of settings.editors) {
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
            editorSpecs.push(
                createEditorSpec({
                    editor: participant.editor,
                    backend: participant.backend,
                    model: participant.model,
                    systemPrompt: composeSystemPrompt(context),
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
    const runSnapshot =
        refreshed !== null && refreshed.filePath === snapshot.filePath ? refreshed : snapshot

    const run = runController.startRun({ snapshot: runSnapshot, editors: editorSpecs })
    return { status: 'started', run, skips }
}
