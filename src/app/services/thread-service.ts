import { currentSpanText } from '../domain/operations/thread'
import type { PluginSettingsV1 } from '../domain/settings/settings-schema'
import { createApiEditorExecutor } from './backends/api-editor-backend'
import { redactSecret } from './backends/providers'
import { ExcludedTargetError, assembleContext } from './context/context-assembler'
import { isExcluded } from './context/exclusions'
import type { VaultReader } from './context/vault-reader.intf'
import type { FindingId } from '../domain/ids'
import type { RunController, ThreadTurnResolution } from './orchestration/run-controller'
import type { ThreadBeginFailure } from './orchestration/finding-store'
import type { EditorSkip } from './review-service'
import { composeSystemPrompt, resolveApiBackend, reviewTimeoutMs } from './review-service'

/**
 * Push-back entry point: turns a user message on one finding into a
 * `thread-turn` operation against the SAME editor persona and backend that
 * produced the finding (plan M4, design §6 decision 1).
 *
 * The run handle owns the turn's lifecycle (permit, protocol, store writes,
 * cancellation — see `RunHandle.startThreadTurn`); this module only resolves
 * WHO answers and with WHAT context, exactly like `startReview` and
 * `startAction` do:
 * - exclusions fail closed first (Business Rules #7),
 * - the persona system prompt is assembled fresh (the vault IS the config, so
 *   an edited persona note affects the next turn),
 * - refusals are typed results, never throws,
 * - error messages are redacted (Business Rules #12).
 *
 * Deliberately NOT applied here: the size guard. A thread-turn request carries
 * the quote, the critique, the prior turns and the user's message — never the
 * note text (the note only counts against the context budget) — and the review
 * that produced the finding already passed the guard. Asking for confirmation
 * again inside the card would be noise.
 *
 * Obsidian-free like the other services: vault, controllers and fetch are
 * injected.
 */

export type ThreadStart =
    /** Dispatched; observe `settled` (or the finding's thread state). */
    | { readonly status: 'started'; readonly settled: Promise<ThreadTurnResolution> }
    /** No run tracks this finding any more (retried editor, discarded file). */
    | { readonly status: 'no-run' }
    /** The finding's note is excluded (Business Rules #7). */
    | { readonly status: 'excluded'; readonly notePath: string }
    /**
     * The editor that produced the finding cannot answer. `skip` explains why;
     * it is `null` only when the editor id no longer resolves to a name.
     */
    | { readonly status: 'no-editor'; readonly skip: EditorSkip | null }
    /** The `FindingStore` refused the turn (cap, in flight, terminal, blank). */
    | { readonly status: 'refused'; readonly reason: ThreadBeginFailure }

export interface StartThreadTurnServiceInput {
    readonly settings: PluginSettingsV1
    readonly vault: VaultReader
    readonly runController: RunController
    readonly findingId: FindingId
    /** The user's push-back message. */
    readonly message: string
    /**
     * Live document text of the finding's note, captured SYNCHRONOUSLY by the
     * caller: the quote is resolved from it before any await, so the turn
     * discusses the span as the user sees it (`currentSpanText`).
     */
    readonly currentText: string
    /** Injected network seam; defaults to the runtime's `fetch`. */
    readonly fetchImpl?: typeof fetch
}

export async function startThreadTurn(input: StartThreadTurnServiceInput): Promise<ThreadStart> {
    const { settings, vault, runController, findingId } = input
    const behavior = settings.behavior
    const fetchImpl = input.fetchImpl ?? globalThis.fetch

    const run = runController.findRunWithFinding(findingId)
    const finding = run?.findings.get(findingId) ?? null
    if (!run || !finding) {
        return { status: 'no-run' }
    }

    // -- Exclusions come first: fail closed before anything is read ----------
    const notePath = run.snapshot.filePath
    if (isExcluded(notePath, vault.getNoteMetadata(notePath), behavior)) {
        return { status: 'excluded', notePath }
    }

    // -- The finding's own editor answers; nobody else may speak for it ------
    const editor = settings.editors.find((candidate) => candidate.id === finding.editorId)
    const editorName = run.getEditorState(finding.editorId)?.editorName ?? editor?.name ?? null
    const skipOf = (reason: EditorSkip['reason']): ThreadStart => ({
        status: 'no-editor',
        skip:
            editorName === null ? null : { editorId: finding.editorId, editorName, reason: reason }
    })
    if (!editor) {
        return skipOf('editor-missing')
    }
    if (!editor.enabled) {
        return skipOf('editor-disabled')
    }
    if (!editor.capabilities.review) {
        return skipOf('no-review-capability')
    }
    const resolution = resolveApiBackend(settings, editor)
    if (!resolution.ok) {
        return skipOf(resolution.reason)
    }

    // -- Resolve the span text BEFORE any await ------------------------------
    const quote = currentSpanText(
        {
            anchor: finding.anchor,
            anchoredText: finding.anchoredText,
            quote: finding.raw.quote
        },
        input.currentText
    )

    // -- Assemble the persona context (same machinery as reviews) ------------
    let systemPrompt: string
    try {
        const context = await assembleContext({
            editor,
            voiceProfile: settings.voiceProfile,
            behavior,
            vault,
            notePath,
            noteText: input.currentText
        })
        systemPrompt = composeSystemPrompt(context)
    } catch (cause) {
        // Defense in depth: the upfront check already covered the target.
        if (cause instanceof ExcludedTargetError) {
            return { status: 'excluded', notePath: cause.notePath }
        }
        throw cause
    }

    const started = run.startThreadTurn({
        findingId,
        message: input.message,
        quote,
        redactError: (message: string): string => redactSecret(message, resolution.backend.apiKey),
        execute: createApiEditorExecutor({
            backendConfig: resolution.backend,
            model: resolution.model,
            systemPrompt,
            timeoutMs: reviewTimeoutMs(behavior),
            fetchImpl
        })
    })
    if (!started.ok) {
        return { status: 'refused', reason: started.reason }
    }
    return { status: 'started', settled: started.settled }
}
