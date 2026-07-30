import { commentInstruction } from '../../domain/comments/comment-prompt'
import { canRetryCommentJob } from '../../domain/comments/comment-job'
import { marginCommentSchema } from '../../domain/comments/margin-comment'
import type { MarginComment } from '../../domain/comments/margin-comment'
import { reanchorComment } from '../../domain/comments/reanchor'
import { spanHints } from '../../domain/comments/span-hints'
import { generateId } from '../../domain/ids'
import { CONTRACT_VERSION } from '../../domain/operations/contract'
import type { ReviewRequest } from '../../domain/operations/contract'
import type { PluginSettingsV1 } from '../../domain/settings/settings-schema'
import { createSnapshot } from '../../domain/snapshot'
import { createBackendExecutor } from '../backends/backend-executor'
import { ExcludedTargetError } from '../context/context-assembler'
import { isExcluded } from '../context/exclusions'
import type { VaultReader } from '../context/vault-reader.intf'
import { noteRuleOutcome } from '../rules/note-rules'
import type { EditorSkip } from '../review-service'
import { buildEditorPrompt, countWords, resolveEditorBackend } from '../review-service'
import type { CommentJobRegistry } from './comment-job-registry'

/**
 * Dispatch for BACKGROUND margin comments (plan §5.5 / M8, slice 2).
 *
 * Shaped exactly like `startReview` / `startAction` / `startThreadTurn`, and
 * the ordering of the gates is the contract:
 *
 * 1. exclusions fail closed before anything is read (Business Rules #7),
 * 2. the binding-rule kill switch (plan §4b) — a switched-off note refuses
 *    before any dialog can appear,
 * 3. the size guard, because a comment sends the whole note as context (unlike
 *    a thread turn, which sends only a quote and a critique). The user IS
 *    present when they park a comment, so the confirmation round trip is the
 *    same one reviews use,
 * 4. editor resolution — one named editor, resolved fresh,
 * 5. context assembly (the vault IS the config: an edited persona note affects
 *    the next job),
 * 6. record the durable comment, THEN dispatch.
 *
 * Every refusal is a typed result, never a throw, and every error message is
 * redacted at the backend boundary (Business Rules #12).
 *
 * The operation is a `review` narrowed to the span's selection, with the
 * question carried as the per-run instruction (`commentInstruction`). No new
 * operation kind was added: a margin comment IS a scoped review, and inventing
 * a seventh request kind would have meant a second prompt serializer, a second
 * result shape and a second set of protocol tests for the same conversation.
 *
 * Obsidian-free like every other service: vault, registry and fetch injected.
 */

export type CommentJobStart =
    /** Recorded and dispatched. */
    | { readonly status: 'started'; readonly comment: MarginComment }
    /** The note is excluded (Business Rules #7). */
    | { readonly status: 'excluded'; readonly notePath: string }
    /** A binding rule switches the plugin off for this note (plan §4b). */
    | { readonly status: 'rule-disabled'; readonly notePath: string; readonly ruleLabel: string }
    /** The chosen editor cannot run; `skip` says why (`null` when it is gone). */
    | { readonly status: 'no-editor'; readonly skip: EditorSkip | null }
    /** Oversized note: re-call with `confirmedLargeNote: true` after asking. */
    | { readonly status: 'needs-confirmation'; readonly wordCount: number; readonly limit: number }
    /** The selection is empty or out of bounds — nothing to comment on. */
    | { readonly status: 'invalid-span' }
    /** The note is at `MAX_COMMENTS_PER_NOTE`. */
    | { readonly status: 'note-full' }
    /** A job is already in flight for this comment. */
    | { readonly status: 'already-running' }
    /** Retry only: no comment with that id on that note. */
    | { readonly status: 'unknown-comment' }
    /** Retry only: the comment's status does not offer Retry. */
    | { readonly status: 'not-retryable' }
    /**
     * Retry only: the span the question was about is no longer in the note.
     * Deliberately a refusal rather than a whole-note fallback — re-asking a
     * question about text that is gone would get an answer about something
     * else, presented as an answer about the original span.
     */
    | { readonly status: 'orphaned' }

/**
 * What PARKING a new comment can produce: every `CommentJobStart` case except
 * the three retry-only refusals, which `retryCommentJob` decides before the
 * shared dispatch chain is entered.
 *
 * Narrow on purpose: the surfaces that turn these into copy would otherwise
 * have to word statuses they can never receive, and a wording nobody can
 * reach is a wording nobody maintains.
 */
export type CommentJobStarted = Exclude<
    CommentJobStart,
    { status: 'unknown-comment' | 'not-retryable' | 'orphaned' }
>

interface CommonInput {
    readonly settings: PluginSettingsV1
    readonly vault: VaultReader
    readonly registry: CommentJobRegistry
    /** Vault-relative path of the note the comment lives on. */
    readonly notePath: string
    /** Its live text, captured synchronously by the caller. */
    readonly noteText: string
    /** Set after the user confirmed the size warning. */
    readonly confirmedLargeNote?: boolean
    /** Injected network seam; defaults to the runtime's `fetch`. */
    readonly fetchImpl?: typeof fetch
    /** Clock seam. */
    readonly now?: () => number
}

export interface StartCommentJobInput extends CommonInput {
    /** The span the user selected, in `noteText` coordinates. */
    readonly selection: { readonly from: number; readonly to: number }
    /** What they asked. */
    readonly instruction: string
    /** Which editor answers. */
    readonly editorId: string
    /** Id seam so specs get deterministic comment ids. */
    readonly makeId?: () => string
}

export interface RetryCommentJobInput extends CommonInput {
    readonly commentId: string
}

/** Parks a new question on a span and dispatches it in the background. */
export async function startCommentJob(input: StartCommentJobInput): Promise<CommentJobStarted> {
    const hints = spanHints(input.noteText, input.selection.from, input.selection.to)
    const instruction = input.instruction.trim()
    if (!hints || instruction.length === 0) {
        return { status: 'invalid-span' }
    }
    const now = input.now ?? ((): number => Date.now())
    const editor = input.settings.editors.find((candidate) => candidate.id === input.editorId)
    const comment = marginCommentSchema.parse({
        id: (input.makeId ?? generateId)(),
        quote: hints.quote,
        prefix: hints.prefix,
        suffix: hints.suffix,
        occurrence: hints.occurrence,
        instruction,
        editorId: input.editorId,
        // Denormalized at creation so the margin can say who was asked even
        // after the editor entity is deleted.
        editorName: editor?.name ?? '',
        status: 'submitted',
        createdAt: now(),
        updatedAt: now(),
        findings: []
    })
    return dispatch(input, comment, { from: input.selection.from, to: input.selection.to })
}

/**
 * Retries an interrupted or failed comment.
 *
 * The span is RE-ANCHORED against the note as it reads now (never restored
 * from a stored position — Business Rules #13), so a retry after an edit asks
 * about the text that is actually there.
 */
export async function retryCommentJob(input: RetryCommentJobInput): Promise<CommentJobStart> {
    const stored = input.registry.commentFor(input.notePath, input.commentId)
    if (!stored) {
        return { status: 'unknown-comment' }
    }
    if (!canRetryCommentJob(stored.status)) {
        return { status: 'not-retryable' }
    }
    const anchored = reanchorComment(input.noteText, stored)
    if (anchored.anchor === null) {
        return { status: 'orphaned' }
    }
    const restarted = input.registry.prepareRetry(input.notePath, input.commentId)
    if (!restarted) {
        return { status: 'not-retryable' }
    }
    // Re-anchored quote and hints: the comment now asks about the live span.
    const hints = spanHints(input.noteText, anchored.anchor.from, anchored.anchor.to)
    const refreshed: MarginComment = hints
        ? {
              ...restarted,
              quote: hints.quote,
              prefix: hints.prefix,
              suffix: hints.suffix,
              occurrence: hints.occurrence
          }
        : restarted
    return dispatch(input, refreshed, { from: anchored.anchor.from, to: anchored.anchor.to })
}

/** The gate chain both entry points share. */
async function dispatch(
    input: CommonInput,
    comment: MarginComment,
    selection: { from: number; to: number }
): Promise<CommentJobStarted> {
    const { settings, vault, notePath } = input
    const behavior = settings.behavior
    const fetchImpl = input.fetchImpl ?? globalThis.fetch

    // -- Exclusions come first: fail closed before anything is read ----------
    if (isExcluded(notePath, vault.getNoteMetadata(notePath), behavior)) {
        return { status: 'excluded', notePath }
    }

    // -- Binding-rule kill switch (plan §4b), before any dialog --------------
    const ruleOutcome = noteRuleOutcome(notePath, vault, settings)
    if (ruleOutcome.kind === 'disabled') {
        return { status: 'rule-disabled', notePath, ruleLabel: ruleOutcome.ruleLabel }
    }

    // -- Size guard: a comment sends the whole note as context ---------------
    const wordCount = countWords(input.noteText)
    if (wordCount > behavior.sizeWarningWords && input.confirmedLargeNote !== true) {
        return { status: 'needs-confirmation', wordCount, limit: behavior.sizeWarningWords }
    }

    // -- One named editor answers; a rule's assignment does not override it --
    // An `assign` rule picks who REVIEWS a note. A comment names its editor,
    // exactly like a push-back names the editor that produced the finding.
    const editor = settings.editors.find((candidate) => candidate.id === comment.editorId)
    const editorName = editor?.name ?? (comment.editorName || null)
    const skipOf = (reason: EditorSkip['reason']): CommentJobStarted => ({
        status: 'no-editor',
        skip:
            editorName === null ? null : { editorId: comment.editorId, editorName, reason: reason }
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
    const resolution = resolveEditorBackend(settings, editor)
    if (!resolution.ok) {
        return skipOf(resolution.reason)
    }

    // -- Assemble the persona context, with the question as the instruction --
    let systemPrompt: string
    try {
        systemPrompt = (
            await buildEditorPrompt({
                editor,
                settings,
                vault,
                notePath,
                noteText: input.noteText,
                instructionText: commentInstruction({
                    quote: comment.quote,
                    instruction: comment.instruction
                })
            })
        ).systemPrompt
    } catch (cause) {
        // Defense in depth: the upfront check already covered the target.
        if (cause instanceof ExcludedTargetError) {
            return { status: 'excluded', notePath: cause.notePath }
        }
        throw cause
    }

    const snapshot = createSnapshot({ filePath: notePath, text: input.noteText, selection })
    const request: ReviewRequest = {
        kind: 'review',
        contractVersion: CONTRACT_VERSION,
        runId: generateId(),
        snapshotHash: snapshot.hash,
        text: snapshot.text,
        selection
    }
    const executor = createBackendExecutor({
        backend: resolution.backend,
        model: resolution.model,
        systemPrompt,
        behavior,
        fetchImpl
    })
    const launched = input.registry.launch({
        notePath,
        comment,
        run: {
            request,
            editorId: editor.id,
            editorName: editor.name,
            redactError: executor.redactError,
            execute: executor.execute,
            ...(input.now ? { now: input.now } : {})
        }
    })
    if (!launched.ok) {
        return { status: launched.reason === 'note-full' ? 'note-full' : 'already-running' }
    }
    return { status: 'started', comment: launched.comment }
}
