import { getBuiltInVerb } from '../domain/actions/verb-registry'
import { asRunId, generateId } from '../domain/ids'
import { CONTRACT_VERSION } from '../domain/operations/contract'
import type { PluginSettingsV1 } from '../domain/settings/settings-schema'
import type { DocumentSnapshot } from '../domain/snapshot'
import { hashText } from '../domain/snapshot'
import { createApiEditorExecutor } from './backends/api-editor-backend'
import { redactSecret } from './backends/providers'
import { ExcludedTargetError } from './context/context-assembler'
import { isExcluded } from './context/exclusions'
import type { VaultReader } from './context/vault-reader.intf'
import type { RunController } from './orchestration/run-controller'
import { noteRuleOutcome } from './rules/note-rules'
import type {
    StartTransformInput,
    TransformController,
    TransformOperationRequest,
    TransformRunHandle,
    TransformTarget
} from './orchestration/transform-run'
import {
    buildEditorPrompt,
    countWords,
    isRequestedSelectionValid,
    resolveApiBackend,
    reviewTimeoutMs,
    startReview
} from './review-service'
import type { EditorSkip, ReviewStart } from './review-service'

/**
 * Action-run entry point: turns a built-in action verb + a document snapshot
 * into one executable run against the target editor's API backend.
 *
 * Verb classes route to different pipelines (see the verb registry):
 * - review-class verbs delegate to `startReview` with the verb instruction
 *   riding the "Ask an editor" augmentation seam — findings, anchoring, and
 *   every review surface work unchanged.
 * - transform verbs run a `transform-selection` operation; generate verbs
 *   run `insert-at`. Both go through the SAME backend executor machinery as
 *   reviews (provider adapters build the request, the operation contract +
 *   Zod validate the result, streaming buffered-equivalent) and land in a
 *   `TransformRunHandle` the UI observes. No UI application happens here —
 *   applying the outcome is the diff UI's job, gated by the handle's
 *   precondition (Business Rules #2/#3).
 *
 * Obsidian-free like `startReview`: vault, controllers, and fetch are
 * injected; every refusal is a typed result, never a throw.
 */

// ---------------------------------------------------------------------------
// Start result (discriminated: callers must handle every refusal)
// ---------------------------------------------------------------------------

export type ActionStart =
    /** Review-class verb: the run is an ordinary review (observe `review`). */
    | { readonly status: 'review'; readonly review: ReviewStart }
    /** Transform/generate verb dispatched; observe the handle. */
    | { readonly status: 'started'; readonly run: TransformRunHandle }
    /** `actionId` is not a built-in verb and no `custom` verb was supplied. */
    | { readonly status: 'unknown-action'; readonly actionId: string }
    /** Target note is excluded (Business Rules #7). */
    | { readonly status: 'excluded'; readonly notePath: string }
    /** A binding rule switches the plugin off for this note (plan §4b). */
    | { readonly status: 'rule-disabled'; readonly notePath: string; readonly ruleLabel: string }
    /**
     * The note exceeds `behavior.sizeWarningWords`; the caller must confirm
     * and retry with `confirmedLargeNote: true` (transform operations send
     * the whole note as context, so the size guard applies to them too).
     */
    | {
          readonly status: 'needs-confirmation'
          readonly wordCount: number
          readonly limit: number
      }
    /**
     * The target editor cannot run. `skips` explains why when the editor
     * exists (capability off, backend unusable); it is empty when the editor
     * is unknown or disabled — mirroring `startReview`'s instruction path.
     */
    | { readonly status: 'no-editor'; readonly skips: readonly EditorSkip[] }
    /** A transform verb was dispatched without a selection. */
    | { readonly status: 'selection-required' }
    /**
     * The captured selection no longer matches the text at run start (edits
     * during the awaits, or stale offsets). The caller should surface "text
     * changed" and let the user re-run — a transform is never silently
     * re-scoped (Business Rules #4 spirit).
     */
    | { readonly status: 'selection-changed' }

export interface StartActionInput {
    readonly settings: PluginSettingsV1
    readonly snapshot: DocumentSnapshot
    readonly vault: VaultReader
    /** Review-class verbs delegate to `startReview` on this controller. */
    readonly runController: RunController
    readonly transformController: TransformController
    /** Built-in verb id (see `builtInActionIdSchema`), or a custom UUID. */
    readonly actionId: string
    /**
     * Custom action verb, required when `actionId` is not a built-in verb.
     * Custom actions are transform-class (they rewrite the selection); the
     * instruction must already be resolved (`resolveCustomInstruction` —
     * direct text + referenced notes) and non-blank.
     */
    readonly custom?: { readonly label: string; readonly instruction: string }
    /** Target editor (resolved from the action binding by the caller). */
    readonly editorId: string
    /** Injected network seam; defaults to the runtime's `fetch`. */
    readonly fetchImpl?: typeof fetch
    /** Set after the user explicitly confirmed the size warning. */
    readonly confirmedLargeNote?: boolean
    /**
     * Selection captured synchronously when the action was requested, with
     * the hash of the text it was captured against (same contract as
     * `startReview.requestedSelection`). Required for transform verbs
     * (`from < to`). For generate verbs a caret (`from === to`) is valid —
     * the insertion lands at `to` — and omitting it entirely appends at the
     * end of the note. Review-class verbs treat a non-degenerate selection
     * as the review scope.
     */
    readonly selection?: {
        readonly from: number
        readonly to: number
        readonly capturedHash: string
    }
    /**
     * Re-snapshots the live document right before the run starts (same
     * contract as `startReview.refreshSnapshot`): context assembly awaits
     * vault reads, and the request must carry the text the user actually
     * sees. Return null when the live document no longer belongs to
     * `snapshot.filePath`.
     */
    readonly refreshSnapshot?: () => DocumentSnapshot | null
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * Whether a captured caret/selection can still anchor an INSERTION against
 * the fresh snapshot: ordered (caret allowed), inside the text, and the text
 * unchanged since capture. The transform (replacement) case uses the
 * stricter `isRequestedSelectionValid`, which additionally rejects carets.
 */
export function isInsertionAnchorValid(
    anchor: { readonly from: number; readonly to: number },
    capturedHash: string,
    fresh: Pick<DocumentSnapshot, 'hash' | 'text'>
): boolean {
    if (anchor.from < 0 || anchor.from > anchor.to || anchor.to > fresh.text.length) {
        return false
    }
    return fresh.hash === capturedHash
}

// ---------------------------------------------------------------------------
// Action orchestration
// ---------------------------------------------------------------------------

/**
 * Starts one action run for a snapshot. See the module doc for routing;
 * refusal semantics mirror `startReview` (exclusions fail closed first, the
 * size guard needs explicit confirmation, unusable editors are explained).
 */
export async function startAction(input: StartActionInput): Promise<ActionStart> {
    const builtIn = getBuiltInVerb(input.actionId)
    // Custom actions are transform-class with a caller-resolved instruction;
    // a blank instruction has nothing to dispatch (the resolution layer
    // refuses such bindings — this is the fail-closed backstop).
    const verb =
        builtIn ??
        (input.custom && input.custom.instruction.trim().length > 0
            ? {
                  label: input.custom.label,
                  verbClass: 'transform' as const,
                  instruction: input.custom.instruction
              }
            : null)
    if (verb === null) {
        return { status: 'unknown-action', actionId: input.actionId }
    }

    // -- Review-class verbs: the review pipeline already does everything ----
    if (verb.verbClass === 'review') {
        const selection = input.selection
        const review = await startReview({
            settings: input.settings,
            snapshot: input.snapshot,
            vault: input.vault,
            runController: input.runController,
            ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
            ...(input.confirmedLargeNote !== undefined
                ? { confirmedLargeNote: input.confirmedLargeNote }
                : {}),
            ...(input.refreshSnapshot ? { refreshSnapshot: input.refreshSnapshot } : {}),
            // A caret is not a reviewable scope — review the whole note then.
            ...(selection && selection.from < selection.to
                ? { requestedSelection: selection }
                : {}),
            instruction: { editorIds: [input.editorId], text: verb.instruction }
        })
        return { status: 'review', review }
    }

    const { settings, snapshot, vault } = input
    const behavior = settings.behavior
    const fetchImpl = input.fetchImpl ?? globalThis.fetch

    // -- Exclusions come first: fail closed before anything is read ----------
    if (isExcluded(snapshot.filePath, vault.getNoteMetadata(snapshot.filePath), behavior)) {
        return { status: 'excluded', notePath: snapshot.filePath }
    }

    // -- Binding-rule kill switch (plan §4b), before the size dialog ---------
    // Only the kill switch applies to actions: an `assign` rule picks who
    // REVIEWS a note by default, while a bound action already names its own
    // target editor (`action-resolution.ts`).
    const ruleOutcome = noteRuleOutcome(snapshot.filePath, vault, settings)
    if (ruleOutcome.kind === 'disabled') {
        return {
            status: 'rule-disabled',
            notePath: snapshot.filePath,
            ruleLabel: ruleOutcome.ruleLabel
        }
    }

    // -- Size guard: the whole note travels as operation context -------------
    const wordCount = countWords(snapshot.text)
    if (wordCount > behavior.sizeWarningWords && input.confirmedLargeNote !== true) {
        return { status: 'needs-confirmation', wordCount, limit: behavior.sizeWarningWords }
    }

    // -- Early selection sanity (cheap refusals before any vault read) -------
    if (verb.verbClass === 'transform' && input.selection === undefined) {
        return { status: 'selection-required' }
    }

    // -- Resolve the target editor and its backend ----------------------------
    const editor = settings.editors.find((candidate) => candidate.id === input.editorId)
    if (!editor || !editor.enabled) {
        return { status: 'no-editor', skips: [] }
    }
    if (!editor.capabilities.rewrite) {
        return {
            status: 'no-editor',
            skips: [
                { editorId: editor.id, editorName: editor.name, reason: 'no-rewrite-capability' }
            ]
        }
    }
    const resolution = resolveApiBackend(settings, editor)
    if (!resolution.ok) {
        return {
            status: 'no-editor',
            skips: [{ editorId: editor.id, editorName: editor.name, reason: resolution.reason }]
        }
    }

    // -- Assemble the persona context (same machinery as reviews) ------------
    let systemPrompt: string
    try {
        // Same entry point as reviews and threads: whatever the "what will be
        // sent" preview shows for this editor is what an action sends too.
        systemPrompt = (
            await buildEditorPrompt({
                editor,
                settings,
                vault,
                notePath: snapshot.filePath,
                noteText: snapshot.text
            })
        ).systemPrompt
    } catch (cause) {
        // Defense in depth: the upfront check already covered the target.
        if (cause instanceof ExcludedTargetError) {
            return { status: 'excluded', notePath: cause.notePath }
        }
        throw cause
    }

    // -- Close the snapshot gap (same rationale as startReview) --------------
    const refreshed = input.refreshSnapshot?.() ?? null
    const runSnapshot =
        refreshed !== null && refreshed.filePath === snapshot.filePath ? refreshed : snapshot

    // -- Validate the captured selection against the run snapshot ------------
    // The request text IS `runSnapshot.text`; stale offsets against it would
    // transform the wrong span. A transform without a valid selection has no
    // target — refuse rather than guess (Business Rules #4 spirit).
    const runId = asRunId(generateId())
    let request: TransformOperationRequest
    let target: TransformTarget
    if (verb.verbClass === 'transform') {
        const selection = input.selection
        if (selection === undefined) {
            return { status: 'selection-required' }
        }
        if (!isRequestedSelectionValid(selection, selection.capturedHash, runSnapshot)) {
            return { status: 'selection-changed' }
        }
        const spanText = runSnapshot.text.slice(selection.from, selection.to)
        request = {
            kind: 'transform-selection',
            contractVersion: CONTRACT_VERSION,
            runId,
            snapshotHash: runSnapshot.hash,
            text: runSnapshot.text,
            selection: { from: selection.from, to: selection.to },
            instruction: verb.instruction
        }
        target = {
            kind: 'replace-span',
            from: selection.from,
            to: selection.to,
            spanText,
            spanHash: hashText(spanText)
        }
    } else {
        const selection = input.selection
        let position: number
        if (selection !== undefined) {
            if (!isInsertionAnchorValid(selection, selection.capturedHash, runSnapshot)) {
                return { status: 'selection-changed' }
            }
            position = selection.to // insert AFTER the selection / at the caret
        } else {
            position = runSnapshot.text.length // no anchor: append at the end
        }
        request = {
            kind: 'insert-at',
            contractVersion: CONTRACT_VERSION,
            runId,
            snapshotHash: runSnapshot.hash,
            text: runSnapshot.text,
            position,
            instruction: verb.instruction
        }
        target = { kind: 'insert-at', position, docHash: runSnapshot.hash }
    }

    // -- Dispatch through the shared backend executor machinery ---------------
    const startInput: StartTransformInput = {
        snapshot: runSnapshot,
        request,
        target,
        editorId: editor.id,
        editorName: editor.name,
        actionLabel: verb.label,
        redactError: (message: string): string => redactSecret(message, resolution.backend.apiKey),
        execute: createApiEditorExecutor({
            backendConfig: resolution.backend,
            model: resolution.model,
            systemPrompt,
            timeoutMs: reviewTimeoutMs(behavior),
            fetchImpl
        })
    }
    const run = input.transformController.startTransform(startInput)
    return { status: 'started', run }
}
