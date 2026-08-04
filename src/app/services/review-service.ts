import { resolveRuleEditorPool } from '../domain/rules/rule-engine'
import type { RuleOutcome } from '../domain/rules/rule-engine'
import { hasLaunchConsent } from '../domain/settings/cli-consent'
import type {
    BackendInstance,
    BackendRef,
    BehaviorSettings,
    EditorConfig,
    PanelConfig,
    PluginSettingsV1
} from '../domain/settings/settings-schema'
import type { DocumentSnapshot } from '../domain/snapshot'
import { createBackendExecutor } from './backends/backend-executor'
import { resolveCliModel } from './backends/cli'
import { ExcludedTargetError, assembleContext } from './context/context-assembler'
import type { AssembledContext } from './context/context-assembler'
import { isExcluded } from './context/exclusions'
import { createCachingVaultReader } from './context/caching-vault-reader'
import type { VaultReader } from './context/vault-reader.intf'
import type {
    RunController,
    RunEditorSpec,
    RunHandle,
    RunPanelSpec
} from './orchestration/run-controller'
import { resolvePanelCharter } from './panels/panel-charter'
import { noteRuleOutcome } from './rules/note-rules'

/**
 * Review-run entry point: turns settings + a document snapshot into one
 * orchestrated run against the configured backends (API or CLI).
 *
 * Obsidian-free by design: the vault is injected as `VaultReader`, the
 * network as `fetchImpl`, so every decision in here (exclusion refusal, size
 * guard, editor/backend resolution, skip reporting) is unit-testable.
 *
 * Guarantees enforced here:
 * - Privacy exclusions are checked BEFORE anything else — an excluded target
 *   never reaches context assembly or a backend (Business Rules #7).
 * - Binding rules are checked next (plan §4b): a note a rule switches the
 *   plugin off for is refused with its own status, and a rule that assigns a
 *   reviewer supplies the default participant pool — an enabled panel target
 *   making the run a first-class panel run (plan M6).
 * - Nothing runs without an explicit user action (Business Rules #1): the
 *   invokers are the Review command / rail button / menus / CLI — plus daemon
 *   refreshes, authorized by the rule's documented carve-out (the explicit
 *   `behavior.daemonMode` opt-in). Oversized notes additionally require a
 *   user-confirmed flag (the daemon skips them instead of asking).
 * - Error messages that could echo credentials are routed through the
 *   redaction seam (Business Rules #12).
 */

// ---------------------------------------------------------------------------
// Skip reporting
// ---------------------------------------------------------------------------

export type SkipReason =
    | 'no-review-capability'
    /** Transform/generate actions only (transform-service): `capabilities.rewrite` is off. */
    | 'no-rewrite-capability'
    | 'no-backend-configured'
    | 'backend-not-found'
    | 'backend-disabled'
    /** A CLI backend the user has not consented to launching (BR #9). */
    | 'cli-consent-required'
    | 'no-model-configured'
    /** Named-pool runs only: a named editor is disabled. */
    | 'editor-disabled'
    /** Named-pool runs only: a named editor id no longer exists. */
    | 'editor-missing'
    /** A binding rule assigned a panel that no longer exists (plan §4b). */
    | 'rule-target-missing'

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
        case 'no-rewrite-capability':
            return 'rewrite capability disabled'
        case 'no-backend-configured':
            return 'no backend configured (set a default backend or assign one)'
        case 'backend-not-found':
            return 'its backend no longer exists'
        case 'backend-disabled':
            return 'its backend is disabled'
        case 'cli-consent-required':
            return 'its CLI backend has not been allowed to run — confirm it in settings'
        case 'no-model-configured':
            return 'no model configured'
        case 'editor-disabled':
            return 'the editor is disabled'
        case 'editor-missing':
            return 'the editor no longer exists'
        case 'rule-target-missing':
            return "the matching rule's panel no longer exists"
    }
}

// ---------------------------------------------------------------------------
// Per-run instruction (freeform "Ask an editor", design §6 decision 1)
// ---------------------------------------------------------------------------

/**
 * One-run-only instruction for a set of editors: the run is narrowed to
 * exactly `editorIds` and each of those editors' composed system prompts is
 * augmented with `text` via `augmentSystemPrompt`. Nothing is persisted —
 * settings are never mutated, the next run assembles its prompt from
 * scratch. "Ask an editor" passes one id; a review-class action bound to a
 * panel passes every member editor id AND `panel`, so the instruction rides
 * on top of the charter inside one panel run (plan M6).
 */
export interface RunInstruction {
    readonly editorIds: readonly string[]
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
    /**
     * Typed refusal distinct from `excluded`: a binding rule switches the
     * plugin OFF for this note (plan §4b kill switch). Different cause,
     * different fix, so it gets its own status — `excluded` means "this
     * content never leaves the vault", `rule-disabled` means "AI Editor does
     * not operate here". `ruleLabel` names the rule so the user can find it.
     */
    | { readonly status: 'rule-disabled'; readonly notePath: string; readonly ruleLabel: string }
    /** No editor could run; `skips` explains each candidate. */
    | { readonly status: 'no-editors'; readonly skips: readonly EditorSkip[] }
    /**
     * A panel run was requested for a panel that is gone or switched off (plan
     * M6). Distinct from `no-editors`: the members may all be perfectly
     * healthy — the panel itself is not there to convene them, and the fix is
     * in the Panels tab, not the Editors tab.
     */
    | {
          readonly status: 'panel-unavailable'
          readonly panelId: string
          readonly reason: 'panel-missing' | 'panel-disabled'
      }
    /**
     * What will be reviewed exceeds `behavior.sizeWarningWords`; the caller
     * must show a confirmation dialog and retry with `confirmedLargeNote:
     * true`. `scope` says what `wordCount` measured — a selection review is
     * priced by the SELECTION, not the note around it (live-round feedback,
     * 2026-08-04), so the dialog can say which it is warning about.
     */
    | {
          readonly status: 'needs-confirmation'
          readonly wordCount: number
          readonly limit: number
          readonly scope: 'note' | 'selection'
      }
    /**
     * `abortWhen` returned true right before the run would have started: no
     * run exists, nothing was cancelled. Only reachable when the caller
     * supplied `abortWhen` (the daemon's superseded-by-a-user-run guard).
     */
    | { readonly status: 'aborted' }

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
     * Per-run instruction scope ("Ask an editor", design §6 decision 1, and
     * review-class action verbs): when set, ONLY the named editors
     * participate (the other editors were not asked — they are neither run
     * nor reported as skips), and each named editor's fully composed system
     * prompt is augmented with the instruction text for this run only (see
     * `augmentSystemPrompt`; settings stay untouched). The instruction is
     * user content riding in the prompt — it cannot change the operation
     * contract: findings still stream through the same tool schema and
     * validate through the same Zod parsing as any review.
     */
    readonly instruction?: RunInstruction
    /**
     * Runs this review AS a panel (plan M6): the panel's members are the
     * participant pool, its charter augments every member's system prompt, and
     * the run owns the aggregation step that follows them. Set by the surfaces
     * that dispatch a panel explicitly (an action bound to a panel, a daemon
     * refresh of a previous panel run). A binding rule that assigns an enabled
     * panel produces a panel run WITHOUT this — the rule outcome is resolved
     * here, so every surface gets panel behavior for free.
     */
    readonly panel?: { readonly panelId: string }
    /**
     * Restricts the participant pool to these editor ids (daemon refreshes
     * re-dispatch the note's PREVIOUS run's editor set): editors outside the
     * set were not asked — neither run nor reported as skips — while editors
     * inside it that cannot dispatch still surface as skips. An empty
     * effective pool yields the usual `no-editors` refusal. Ignored when
     * `instruction` is set (the instruction already names its editors).
     */
    readonly editorIds?: readonly string[]
    /**
     * Checked synchronously immediately before the run would start (after
     * context assembly's awaits, in the same synchronous block as
     * `startRun`). Returning true aborts with status `'aborted'` and NO run
     * is started. The daemon passes "a run for this file is now unsettled":
     * `startRun` cancels the file's previous run, so without this guard a
     * daemon dispatch racing a user summon during the awaits would cancel
     * the user's explicit run (Architecture.md § Run lifecycle — summon always wins).
     */
    readonly abortWhen?: () => boolean
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
    | { readonly ok: true; readonly backend: BackendInstance; readonly model: string }
    | { readonly ok: false; readonly reason: SkipReason }

/**
 * Resolves a backend reference (an editor's binding, a panel's aggregation
 * backend) to a usable backend of EITHER family, falling back to the global
 * default when the reference is null (inherit). Every refusal is a typed
 * reason, never a silent drop.
 *
 * The two families differ in exactly two checks, both of which fail closed:
 *
 * - **Model.** An API request body has to name a model, so a missing one is a
 *   broken request. A CLI tool already ships a default that tracks its
 *   vendor's current recommendation, so an empty model is legal there and
 *   means "defer to the tool" (`resolveCliModel`).
 * - **Consent.** A CLI backend may only run when the user consented to
 *   launching THIS executable (Business Rules #9). `enabled` is not consent:
 *   a `data.json` that syncs, an edited path, or a hand-written file can all
 *   produce an enabled backend nobody agreed to start, and this is the check
 *   that catches every one of them.
 */
export function resolveBackendRef(
    settings: PluginSettingsV1,
    ref: BackendRef | null
): BackendResolution {
    const resolved = ref ?? settings.defaultBackend
    if (!resolved) {
        return { ok: false, reason: 'no-backend-configured' }
    }
    const instance = settings.backends.find((backend) => backend.id === resolved.backendId)
    if (!instance) {
        return { ok: false, reason: 'backend-not-found' }
    }
    if (!instance.enabled) {
        return { ok: false, reason: 'backend-disabled' }
    }
    if (instance.family === 'cli') {
        if (!hasLaunchConsent(instance)) {
            return { ok: false, reason: 'cli-consent-required' }
        }
        return { ok: true, backend: instance, model: resolveCliModel(resolved, instance) }
    }
    const model = resolved.model.length > 0 ? resolved.model : instance.defaultModel
    if (model.length === 0) {
        return { ok: false, reason: 'no-model-configured' }
    }
    return { ok: true, backend: instance, model }
}

/**
 * Resolves the backend an editor runs on: its own binding, or the global
 * default when set to inherit.
 */
export function resolveEditorBackend(
    settings: PluginSettingsV1,
    editor: EditorConfig
): BackendResolution {
    return resolveBackendRef(settings, editor.backend)
}

/**
 * Serializes an assembled context into the final system prompt: the direct
 * text fields followed by every attached vault note as a delimited block
 * (XML-style tags, consistent with the operation prompt serialization —
 * fences would break on markdown content).
 *
 * Each block is labelled with WHY the note is there (`role`), not just its
 * path: a note the persona references is instruction material, while a note
 * linked from the document under review is subject matter, and a model that
 * cannot tell them apart will happily critique the reference material. The
 * role vocabulary is the attachment reason (`context-budget.ts`), so the
 * prompt, the preview and the budget all name the same thing.
 */
export function composeSystemPrompt(context: AssembledContext): string {
    if (context.attachments.length === 0) {
        return context.systemPrompt
    }
    const blocks = context.attachments.map((attachment) => {
        const path = attachment.path.replace(/"/g, "'")
        return `<context-note role="${attachment.reason}" path="${path}">\n${attachment.content}\n</context-note>`
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

/**
 * Appends a panel's charter to a member editor's composed system prompt (plan
 * M6). Same seam as `augmentSystemPrompt`, different framing and a different
 * author: the charter is the PANEL's shared brief — "you are reviewing as part
 * of the Pre-publish review panel; weigh the reader's first pass double" —
 * while an instruction is the user's ask for one run.
 *
 * It lands BEFORE the instruction so the per-run ask stays last (most salient),
 * and it explicitly does not release the member from its own persona: a panel
 * that homogenized its members would be four copies of one editor, which is the
 * opposite of why panels exist. Like every other prompt augmentation it can
 * only direct WHAT is weighed — findings still come back through the tool
 * schema and validate through the same Zod parsing.
 *
 * Blank charters leave the prompt untouched.
 */
export function augmentPanelCharter(
    basePrompt: string,
    panelName: string,
    charter: string
): string {
    const trimmed = charter.trim()
    if (trimmed.length === 0) {
        return basePrompt
    }
    const block = [
        `You are reviewing as one member of the "${panelName}" panel: other editors are reviewing this same document independently, and a chairperson will synthesize all of your results into one scorecard.`,
        'The panel charter below is the shared brief for that review. It directs what the panel weighs; it does not replace your own mandate, and it does not change the required output format:',
        `<panel-charter>\n${trimmed}\n</panel-charter>`
    ].join('\n')
    return [basePrompt, block].filter((segment) => segment.length > 0).join('\n\n')
}

/**
 * Appends the `behavior.responseLanguageOverride` directive to a composed
 * system prompt. Empty (the default) leaves the prompt untouched, which is the
 * documented behavior: "answer in each note's own language" is what a model
 * does when nobody tells it otherwise.
 *
 * Applied to BOTH prompt authors — `buildEditorPrompt` for every editor run and
 * `createPanelSpec` for the panel chairperson — because a setting that reworded
 * the reviews but not the scorecard would be worse than none. It lands LAST,
 * after the charter and the per-run instruction: it is about the answer's form,
 * and the last line of a prompt is the one a model is least likely to lose.
 *
 * The value is user text, so it is delimited rather than interpolated into a
 * sentence, for the same reason `augmentSystemPrompt` delimits an instruction:
 * it can only direct the prose, never the output contract, which is enforced by
 * the tool schema and Zod regardless of what the prompt says.
 */
export function augmentResponseLanguage(basePrompt: string, language: string): string {
    const trimmed = language.trim()
    if (trimmed.length === 0) {
        return basePrompt
    }
    const block = [
        'Write every piece of prose you produce — critiques, suggestions, summaries, rationales — in the following language, whatever language the document is written in:',
        `<response-language>\n${trimmed}\n</response-language>`,
        'Quotes taken from the document stay in the document’s own language, verbatim.'
    ].join('\n')
    return [basePrompt, block].filter((segment) => segment.length > 0).join('\n\n')
}

// ---------------------------------------------------------------------------
// The one prompt-build entry point
// ---------------------------------------------------------------------------

export interface BuildEditorPromptInput {
    readonly editor: EditorConfig
    readonly settings: PluginSettingsV1
    readonly vault: VaultReader
    /** Vault-relative path of the note the operation targets. */
    readonly notePath: string
    /** Its text — the live editor buffer where one exists, else vault state. */
    readonly noteText: string
    /**
     * Per-run instruction text (ask-an-editor, a bound review verb). Appended
     * last via `augmentSystemPrompt`; blank or absent leaves the prompt as
     * assembled.
     */
    readonly instructionText?: string
    /**
     * The panel this editor is running as a member of (plan M6). Its resolved
     * charter is appended via `augmentPanelCharter`, before the instruction.
     * Absent for solo runs.
     */
    readonly panelCharter?: {
        readonly panelName: string
        /** Already resolved from the panel's `PromptSource` (charter text). */
        readonly text: string
    }
}

export interface EditorPrompt {
    /** Assembly detail: attachments, sections, budget report. */
    readonly context: AssembledContext
    /**
     * The exact string handed to the provider adapter as the system prompt —
     * attachments serialized, instruction appended. What the preview shows and
     * what the backend receives are this one value.
     */
    readonly systemPrompt: string
}

/**
 * Assembles one editor's context and composes its final system prompt.
 *
 * THE single entry point for "what will this editor be sent": every dispatch
 * path (review, transform/generate, push-back thread) and the "what will be
 * sent" preview call this and nothing else. That is the whole reason it
 * exists — a preview that re-derived the prompt would drift from the request,
 * and a trust surface that drifts is worse than none. Callers that need the
 * budget report read `context`; callers that only send read `systemPrompt`.
 *
 * Throws `ExcludedTargetError` when the target note is excluded (Business
 * Rules #7) — every caller already turns that into its own typed refusal.
 */
export async function buildEditorPrompt(input: BuildEditorPromptInput): Promise<EditorPrompt> {
    const context = await assembleContext({
        editor: input.editor,
        voiceProfile: input.settings.voiceProfile,
        behavior: input.settings.behavior,
        vault: input.vault,
        notePath: input.notePath,
        noteText: input.noteText
    })
    const composed = composeSystemPrompt(context)
    // Charter first, instruction last: the panel brief is standing context for
    // every run of that panel, the instruction is what the user asked for THIS
    // time, and the last block is the most salient one.
    const charter = input.panelCharter
    const withCharter = charter
        ? augmentPanelCharter(composed, charter.panelName, charter.text)
        : composed
    const instructionText = input.instructionText ?? ''
    const withInstruction =
        instructionText.length > 0 ? augmentSystemPrompt(withCharter, instructionText) : withCharter
    return {
        context,
        // Language last: standing output-form configuration, after everything
        // that directs WHAT to look at.
        systemPrompt: augmentResponseLanguage(
            withInstruction,
            input.settings.behavior.responseLanguageOverride
        )
    }
}

// ---------------------------------------------------------------------------
// API editor specs
// ---------------------------------------------------------------------------

/**
 * Builds the `RunEditorSpec` bridging one editor persona to its backend — of
 * either family. Everything family-specific (which executor, which timeout,
 * what redaction means) is decided once in `createBackendExecutor`, so this
 * function has no idea whether the run will go over HTTPS or over a pipe.
 */
export function createEditorSpec(input: {
    readonly editor: EditorConfig
    readonly backend: BackendInstance
    readonly model: string
    readonly systemPrompt: string
    readonly behavior: BehaviorSettings
    readonly fetchImpl: typeof fetch
}): RunEditorSpec {
    const executor = createBackendExecutor({
        backend: input.backend,
        model: input.model,
        systemPrompt: input.systemPrompt,
        behavior: input.behavior,
        fetchImpl: input.fetchImpl
    })
    return {
        editorId: input.editor.id,
        editorName: input.editor.name,
        redactError: executor.redactError,
        execute: executor.execute
    }
}

// ---------------------------------------------------------------------------
// Review orchestration
// ---------------------------------------------------------------------------

/** One editor that will actually run, with the backend it resolved to. */
export interface ReviewParticipant {
    readonly editor: EditorConfig
    readonly backend: BackendInstance
    readonly model: string
}

/** Who would review a note right now, and who could not — with the reason. */
export interface ReviewParticipantPool {
    readonly participants: readonly ReviewParticipant[]
    readonly skips: readonly EditorSkip[]
    /**
     * The panel the pool came from — a caller-requested panel run, or an
     * enabled panel a binding rule assigned. `null` for an ordinary run: the
     * participants are then editors in their own right, not members.
     */
    readonly panelId: string | null
}

/** Editors a caller explicitly named, if any (see the precedence below). */
export interface ReviewPoolRequest {
    /** A panel run: its members are the pool (plan M6). */
    readonly panelId?: string | undefined
    /** A per-run instruction's editors (ask-an-editor, a bound review verb). */
    readonly instructionEditorIds?: readonly string[] | undefined
    /** A KNOWN set being re-dispatched (a daemon refresh of a previous run). */
    readonly editorIds?: readonly string[] | undefined
}

/**
 * The participants of a review run, and the typed skip report for everyone who
 * could not join. Pure over the settings and the note's rule outcome.
 *
 * THE single answer to "who would review this note": `startReview` dispatches
 * exactly this list, and `reviewGate` decides whether a surface may offer a
 * review by asking whether it is empty. Before this existed, the gate asked a
 * GLOBAL question (`hasReviewCapableEditor`) while the dispatch asked a
 * note-scoped one, so a note whose `assign` rule named an editor that could not
 * run passed every gate — enabled command, enabled panel button, tooltip
 * promising a review — and then refused on click, every time.
 *
 * Precedence, highest first:
 * 1. A requested panel run: its members ARE the pool (plan M6). It outranks a
 *    per-run instruction because the panel is the authoritative membership —
 *    the instruction then only augments the members it names.
 * 2. A per-run instruction narrows the run to the editor(s) the user asked
 *    for. The others were not asked at all, so they are not candidates and
 *    never appear as skips.
 * 3. `editorIds` re-dispatches a known set.
 * 4. A matching `assign` binding rule (plan §4b): its editor, or every member
 *    of its panel. Rules supply the DEFAULT pool only — a user or daemon
 *    choice wins.
 * 5. Otherwise every editor in the settings.
 *
 * Pools that NAME editors (1, 2 and 4) report every named editor that cannot
 * run — deleted ids and disabled editors included — instead of silently
 * shrinking the ask / panel / rule (the resolution contract in
 * `action-resolution.ts`). Pools 3 and 5 stay silent about disabled editors:
 * the user turned them off on purpose, and a daemon refresh must not nag.
 */
export function resolveReviewParticipants(
    settings: PluginSettingsV1,
    ruleOutcome: RuleOutcome,
    requested: ReviewPoolRequest = {}
): ReviewParticipantPool {
    const skips: EditorSkip[] = []
    let pool: readonly string[] | null = null
    let namedPool = false
    let panelId: string | null = null
    if (requested.panelId !== undefined) {
        // Callers validate the panel's existence first (`startReview` refuses
        // with its own status); an unknown id here degrades to an empty named
        // pool, which surfaces as the usual `no-editors` refusal.
        const panel = settings.panels.find((candidate) => candidate.id === requested.panelId)
        pool = panel ? panel.memberEditorIds : []
        namedPool = true
        panelId = requested.panelId
    } else if (requested.instructionEditorIds) {
        pool = requested.instructionEditorIds
        namedPool = true
    } else if (requested.editorIds) {
        pool = requested.editorIds
    } else {
        const rulePool = resolveRuleEditorPool(settings, ruleOutcome)
        if (rulePool.kind === 'target-missing') {
            // The rule names nobody: a deleted editor, a deleted panel, or a
            // panel whose members are all gone (referential integrity reports
            // it in the settings too). Refusing with the RULE named beats both
            // an anonymous "unknown editor" skip and silently reviewing with
            // every editor the rule was meant to replace.
            return {
                participants: [],
                panelId: null,
                skips: [
                    {
                        editorId: rulePool.targetId,
                        editorName:
                            ruleOutcome.kind === 'assigned' ? ruleOutcome.ruleLabel : 'Rule',
                        reason: 'rule-target-missing'
                    }
                ]
            }
        }
        if (rulePool.kind === 'editors') {
            pool = rulePool.editorIds
            namedPool = true
            panelId = rulePool.panelId
        }
    }
    const editorPool =
        pool === null
            ? settings.editors
            : settings.editors.filter((editor) => pool.includes(editor.id))
    if (namedPool && pool !== null) {
        const known = new Set(settings.editors.map((editor) => editor.id))
        for (const id of pool) {
            if (!known.has(id)) {
                skips.push({ editorId: id, editorName: 'Unknown editor', reason: 'editor-missing' })
            }
        }
    }
    const participants: ReviewParticipant[] = []
    for (const editor of editorPool) {
        if (!editor.enabled) {
            if (namedPool) {
                skips.push({
                    editorId: editor.id,
                    editorName: editor.name,
                    reason: 'editor-disabled'
                })
            }
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
        const resolution = resolveEditorBackend(settings, editor)
        if (!resolution.ok) {
            skips.push({ editorId: editor.id, editorName: editor.name, reason: resolution.reason })
            continue
        }
        participants.push({ editor, backend: resolution.backend, model: resolution.model })
    }
    return { participants, skips, panelId }
}

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
    const { settings, snapshot, runController } = input
    const behavior = settings.behavior
    // ONE view of the vault for the whole run. Every editor assembles its own
    // context, and every assembly walks the same link graph, checks the same
    // notes against the same exclusions and reads the same attachments — so
    // without this a panel of eight members reads twenty notes eight times
    // (measured in `perf/perf.bench.spec.ts`). It also makes the run coherent:
    // every member is briefed on the same vault, even if the user saves a file
    // while the contexts are being assembled. Scoped to this call and thrown
    // away with it — see `createCachingVaultReader`.
    const vault = createCachingVaultReader(input.vault)
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

    // -- Binding rules: kill switch, then the default participant pool -------
    // Before the size guard: a note the plugin is switched off for must not
    // pop a confirmation dialog on its way to being refused.
    const ruleOutcome = noteRuleOutcome(snapshot.filePath, vault, settings)
    if (ruleOutcome.kind === 'disabled') {
        return {
            status: 'rule-disabled',
            notePath: snapshot.filePath,
            ruleLabel: ruleOutcome.ruleLabel
        }
    }

    // -- Panel identity ------------------------------------------------------
    // An explicitly requested panel must exist and be enabled before anything
    // else happens: refusing here names the panel, while letting it fall
    // through would report an anonymous "no editors" against members that are
    // perfectly healthy. Before the size guard, for the same reason as the
    // rule kill switch above: a run that is going to be refused outright must
    // not pop a confirmation dialog on its way there. It needs nothing from
    // the size computation.
    const requestedPanelId = input.panel?.panelId
    if (requestedPanelId !== undefined) {
        const requestedPanel = settings.panels.find((panel) => panel.id === requestedPanelId)
        if (!requestedPanel) {
            return {
                status: 'panel-unavailable',
                panelId: requestedPanelId,
                reason: 'panel-missing'
            }
        }
        if (!requestedPanel.enabled) {
            return {
                status: 'panel-unavailable',
                panelId: requestedPanelId,
                reason: 'panel-disabled'
            }
        }
    }

    // -- Size guard: oversized requests need an explicit user confirmation ---
    // Measures what will actually be reviewed (live-round feedback,
    // 2026-08-04): a selection review of a long note is priced by the
    // selection, not the note around it. Priority mirrors the scope
    // resolution further down — a requested selection still valid against
    // THIS snapshot, then the snapshot's own embedded selection, then the
    // whole note. A requested selection that has already gone stale falls
    // back to whole-note pricing, which is exactly the scope the run would
    // fall back to.
    const guardSelection =
        input.requestedSelection &&
        isRequestedSelectionValid(
            input.requestedSelection,
            input.requestedSelection.capturedHash,
            snapshot
        )
            ? input.requestedSelection
            : (snapshot.selection ?? null)
    const wordCount = countWords(
        guardSelection ? snapshot.text.slice(guardSelection.from, guardSelection.to) : snapshot.text
    )
    if (wordCount > behavior.sizeWarningWords && input.confirmedLargeNote !== true) {
        return {
            status: 'needs-confirmation',
            wordCount,
            limit: behavior.sizeWarningWords,
            scope: guardSelection ? 'selection' : 'note'
        }
    }

    // -- Resolve participants -------------------------------------------------
    const instruction = input.instruction
    const { participants, skips, panelId } = resolveReviewParticipants(settings, ruleOutcome, {
        panelId: requestedPanelId,
        instructionEditorIds: instruction?.editorIds,
        editorIds: input.editorIds
    })
    if (participants.length === 0) {
        return { status: 'no-editors', skips }
    }
    const panel = panelId === null ? null : (settings.panels.find((p) => p.id === panelId) ?? null)

    // -- Assemble context and build executors --------------------------------
    // The charter is resolved ONCE and briefs every member identically: it is
    // the panel's shared brief, so a per-member re-read could only introduce
    // divergence between members of the same run.
    const charterText = panel ? await resolvePanelCharter(panel, vault, behavior) : ''
    const editorSpecs: RunEditorSpec[] = []
    try {
        for (const participant of participants) {
            const built = await buildEditorPrompt({
                editor: participant.editor,
                settings,
                vault,
                notePath: snapshot.filePath,
                noteText: snapshot.text,
                instructionText:
                    instruction && instruction.editorIds.includes(participant.editor.id)
                        ? instruction.text
                        : undefined,
                ...(panel ? { panelCharter: { panelName: panel.name, text: charterText } } : {})
            })
            editorSpecs.push(
                createEditorSpec({
                    editor: participant.editor,
                    backend: participant.backend,
                    model: participant.model,
                    systemPrompt: built.systemPrompt,
                    behavior,
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
    // -- Last-moment abort guard (daemon vs explicit user runs) --------------
    // Checked in the same synchronous block as `startRun`: nothing can
    // interleave between this check and the run start, so a true result
    // means no run is started and no existing run is cancelled.
    if (input.abortWhen?.() === true) {
        return { status: 'aborted' }
    }

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

    const run = runController.startRun({
        snapshot: runSnapshot,
        editors: editorSpecs,
        ...(panel
            ? {
                  panel: createPanelSpec({
                      panel,
                      settings,
                      charterText,
                      // The chairperson aggregates with the user's question
                      // in view (issue #27): a panel asked "is this argument
                      // convincing?" must score answers to THAT, not to the
                      // charter alone.
                      ...(instruction ? { instructionText: instruction.text } : {}),
                      fetchImpl
                  })
              }
            : {})
    })
    return { status: 'started', run, skips, selectionFallback }
}

/**
 * Builds the run's panel spec: identity always, aggregation only when the
 * panel's backend resolves.
 *
 * A panel whose aggregation backend is missing, disabled or model-less still
 * runs as a panel — its members review with the charter and the scorecard
 * reports `unavailable`. Refusing the whole run instead would be a strictly
 * worse trade: the members' findings are the bulk of the value, and a
 * misconfigured aggregation backend is a settings problem the user can fix
 * after reading the reviews.
 *
 * The charter is the aggregation call's SYSTEM PROMPT. Everything the
 * chairperson must produce (verdict per member, top fixes, dissent, never
 * speak for a missing member) comes from the `aggregate-panel` operation
 * prompt, which the contract already dictates — so the panel's one
 * user-authored field says what the panel is for, in both of its roles.
 */
function createPanelSpec(input: {
    readonly panel: PanelConfig
    readonly settings: PluginSettingsV1
    readonly charterText: string
    /** The run's freeform instruction, when one exists (issue #27). */
    readonly instructionText?: string
    readonly fetchImpl: typeof fetch
}): RunPanelSpec {
    const { panel, settings } = input
    const resolution = resolveBackendRef(settings, panel.aggregationBackend)
    if (!resolution.ok) {
        return { panelId: panel.id, panelName: panel.name }
    }
    // The chairperson answers in the configured language too — and the budget
    // is charged for the directive, so the aggregation's fixed cost is the
    // prompt that is actually sent. An instruction layers ON TOP of the
    // charter for the chair exactly as it does for the members (issue #27):
    // the charter is who the panel is, the instruction is what was asked.
    const briefed =
        input.instructionText === undefined
            ? input.charterText
            : augmentSystemPrompt(input.charterText, input.instructionText)
    const chairPrompt = augmentResponseLanguage(briefed, settings.behavior.responseLanguageOverride)
    const executor = createBackendExecutor({
        backend: resolution.backend,
        model: resolution.model,
        systemPrompt: chairPrompt,
        behavior: settings.behavior,
        fetchImpl: input.fetchImpl
    })
    return {
        panelId: panel.id,
        panelName: panel.name,
        // The scorecard obeys the same context budget the reviews do — the
        // aggregation is a request like any other, and a panel over a long
        // note is exactly where an unbounded payload would hurt.
        budget: {
            contextBudgetChars: settings.behavior.contextBudgetChars,
            charterChars: chairPrompt.length
        },
        redactError: executor.redactError,
        aggregate: executor.execute
    }
}

// ---------------------------------------------------------------------------
// Joining a run (live-round feedback, 2026-08-04)
// ---------------------------------------------------------------------------

/** Outcome of `addEditorToRun`. */
export type AddEditorToRun =
    | { readonly status: 'added' }
    | { readonly status: 'excluded' }
    | { readonly status: 'rule-disabled'; readonly ruleLabel: string }
    /** The editor cannot run: disabled, review off, or no usable backend. */
    | { readonly status: 'editor-unavailable'; readonly skips: readonly EditorSkip[] }
    | { readonly status: 'already-in-run' }

/**
 * Adds ONE more editor to an existing run and dispatches it through the
 * run's own machinery (`RunHandle.addEditor`): summoning an editor that is
 * not part of the note's run queues onto that run — it must never cancel or
 * replace it. The same fail-closed gates as `startReview` apply (privacy
 * exclusion, rule kill switch, editor/backend resolution); the size guard
 * deliberately does not — the note was priced when its run started, and a
 * joiner is one more request on it, exactly like retry and Generate more.
 *
 * `refreshText` is read right before the add so the joiner anchors against
 * the buffer as it reads THEN (the awaits here are vault reads for the
 * persona prompt); it falls back to `noteText` when absent.
 */
export async function addEditorToRun(input: {
    readonly settings: PluginSettingsV1
    readonly vault: VaultReader
    readonly run: RunHandle
    readonly editorId: string
    readonly notePath: string
    readonly noteText: string
    readonly refreshText?: () => string | null
    readonly fetchImpl?: typeof fetch
}): Promise<AddEditorToRun> {
    const { settings } = input
    const behavior = settings.behavior
    const vault = createCachingVaultReader(input.vault)
    const fetchImpl = input.fetchImpl ?? globalThis.fetch
    if (isExcluded(input.notePath, vault.getNoteMetadata(input.notePath), behavior)) {
        return { status: 'excluded' }
    }
    const ruleOutcome = noteRuleOutcome(input.notePath, vault, settings)
    if (ruleOutcome.kind === 'disabled') {
        return { status: 'rule-disabled', ruleLabel: ruleOutcome.ruleLabel }
    }
    // The explicit editor id outranks any assign rule, exactly like a named
    // pool in `startReview` — the user pointed at this editor.
    const { participants, skips } = resolveReviewParticipants(settings, ruleOutcome, {
        editorIds: [input.editorId]
    })
    const participant = participants.find((entry) => entry.editor.id === input.editorId)
    if (!participant) {
        return { status: 'editor-unavailable', skips }
    }
    let systemPrompt: string
    try {
        const built = await buildEditorPrompt({
            editor: participant.editor,
            settings,
            vault,
            notePath: input.notePath,
            noteText: input.noteText
        })
        systemPrompt = built.systemPrompt
    } catch (cause) {
        if (cause instanceof ExcludedTargetError) {
            return { status: 'excluded' }
        }
        throw cause
    }
    const spec = createEditorSpec({
        editor: participant.editor,
        backend: participant.backend,
        model: participant.model,
        systemPrompt,
        behavior,
        fetchImpl
    })
    const fresh = input.refreshText?.() ?? null
    const result = input.run.addEditor(spec, fresh ?? input.noteText)
    return result.ok ? { status: 'added' } : { status: 'already-in-run' }
}
