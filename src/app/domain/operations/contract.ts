import { z } from 'zod'

/**
 * The operation contract between the plugin and every backend (API provider
 * or CLI agent). Versioned, discriminated by `kind`, validated with Zod at
 * the boundary — backend output is untrusted text until it passes these
 * schemas.
 *
 * Design constraints (see documentation/reviews/2026-07-29 review):
 * - One `review()` cannot represent the product: reviewing, transforming a
 *   selection, inserting a continuation, refining a proposal, a thread turn,
 *   and panel aggregation have different result shapes.
 * - Every request/result carries stable IDs so late events from cancelled
 *   runs can be discarded and results can be attributed.
 * - All strings are bounded: models produce unbounded output; storage and UI
 *   must not.
 */

export const CONTRACT_VERSION = 2

const QUOTE_MAX = 2_000
const SHORT_TEXT_MAX = 10_000
const LONG_TEXT_MAX = 100_000

// ---------------------------------------------------------------------------
// Shared pieces
// ---------------------------------------------------------------------------

export const severitySchema = z.enum(['info', 'suggestion', 'warning'])
export type Severity = z.infer<typeof severitySchema>

/**
 * A source the backend used to justify a claim. Backends with research
 * capability MUST attach evidence to fact-level critiques; a critique without
 * sources is just another unsupported claim. Also feeds the references
 * feature (external sources list).
 */
export const evidenceSchema = z.object({
    /** Human-readable title of the source. */
    title: z.string().max(500),
    /** URL when the source is external; omitted for vault-internal sources. */
    url: z.string().max(2_000).optional(),
    /** What this source supports, in one sentence. */
    claim: z.string().max(1_000).optional(),
    /** Whether the backend actually consulted the source or merely suggests it. */
    verification: z.enum(['verified', 'requires-verification'])
})
export type Evidence = z.infer<typeof evidenceSchema>

/** The operations an edit can express (contract v2, design doc §1). */
export const editOpSchema = z.enum(['replace', 'insert-before', 'insert-after', 'delete'])
export type EditOp = z.infer<typeof editOpSchema>

/** Max edits one finding may propose (design doc §1). */
export const FINDING_EDITS_MAX = 10

/**
 * One mechanical change proposed by a finding (contract v2). The `text` is
 * written into the note EXACTLY as given — the explanation lives in the
 * finding's `critique`/`rationale`, which no accept path ever writes. This
 * structural split is the fix for #17: prose can no longer masquerade as a
 * replacement, and an addition no longer has to be approximated by a
 * destructive replace.
 *
 * Targeting: `quote` (with the usual hints) anchors the edit independently;
 * ABSENT, the edit targets the finding's own anchored span. Kept a flat
 * object rather than a discriminated union so the wire schema stays compact
 * on weak local models (design doc §3); the per-op `text` requirement is
 * enforced by the refinement below, at the Zod boundary.
 */
export const rawEditSchema = z
    .object({
        op: editOpSchema,
        /** Verbatim target span; omitted → the finding's own quoted span. */
        quote: z.string().min(1).max(QUOTE_MAX).optional(),
        /** Short text immediately before the target, for disambiguation. */
        prefix: z.string().max(200).optional(),
        /** Short text immediately after the target, for disambiguation. */
        suffix: z.string().max(200).optional(),
        /** 0-based occurrence index when the target appears multiple times. */
        occurrence: z.number().int().min(0).max(1_000).optional(),
        /**
         * The content applied by the operation. Required and non-empty for
         * `replace`/`insert-*` (a covert delete via empty replace is
         * invalid); ignored for `delete`.
         */
        text: z.string().max(SHORT_TEXT_MAX).optional()
    })
    .superRefine((edit, ctx) => {
        if (edit.op !== 'delete' && (edit.text === undefined || edit.text.length === 0)) {
            ctx.addIssue({
                code: 'custom',
                path: ['text'],
                message: `"text" is required for op "${edit.op}"`
            })
        }
    })
export type RawEdit = z.infer<typeof rawEditSchema>

/**
 * One observation reported by an editor persona about a span of the
 * submitted snapshot.
 */
export const rawFindingSchema = z.object({
    /** Verbatim quote from the submitted text (used for anchoring). */
    quote: z.string().min(1).max(QUOTE_MAX),
    /** Short text immediately before the quote, for occurrence disambiguation. */
    prefix: z.string().max(200).optional(),
    /** Short text immediately after the quote, for occurrence disambiguation. */
    suffix: z.string().max(200).optional(),
    /** 0-based occurrence index when the quote appears multiple times. */
    occurrence: z.number().int().min(0).max(1_000).optional(),
    /** The observation: what is wrong / noteworthy. */
    critique: z.string().min(1).max(SHORT_TEXT_MAX),
    /**
     * The proposed change, as mechanical edits (contract v2). Empty is valid
     * and common — a critique-only finding is display-only. Accepting a
     * finding applies ALL its edits or none (design doc §4).
     */
    edits: z.array(rawEditSchema).max(FINDING_EDITS_MAX).default([]),
    /**
     * Set by the plugin's salvage pass (`validateOperationResult`), never
     * meaningfully by a model: the finding's proposed edits failed validation
     * and were removed, so the card shows the critique with a "proposal could
     * not be validated" marker instead of an Accept. A backend that sets it
     * anyway is read the fail-closed way — its edits are stripped too.
     */
    invalidProposal: z.boolean().default(false),
    /** One-line rationale shown next to the diff. */
    rationale: z.string().max(1_000).optional(),
    severity: severitySchema.default('suggestion'),
    /** Backend self-reported confidence in [0, 1]. */
    confidence: z.number().min(0).max(1).optional(),
    evidence: z.array(evidenceSchema).max(20).default([])
})
export type RawFinding = z.infer<typeof rawFindingSchema>

/** Panel / gate verdict vocabulary (mirrors the vault panels' scorecards). */
export const verdictSchema = z.enum(['publish', 'needs-work', 'kill'])
export type Verdict = z.infer<typeof verdictSchema>

// ---------------------------------------------------------------------------
// Operation requests
// ---------------------------------------------------------------------------

const baseRequest = z.object({
    contractVersion: z.literal(CONTRACT_VERSION),
    /** Unique id of this operation run; all events must echo it. */
    runId: z.string().min(1),
    /**
     * Hash of the snapshot this operation belongs to — the provenance of the
     * run, not a guarantee about every payload field.
     *
     * For `review` / `transform-selection` / `insert-at` / `refine-proposal`
     * the payload text WAS captured from that snapshot. For `thread-turn` it
     * identifies the review the finding came from, while `quote` carries the
     * span's LIVE text (the user may have edited it since — see
     * `currentSpanText`), so it may postdate the hash. Consumers must not
     * assume `quote` is a substring of the hashed snapshot.
     */
    snapshotHash: z.string().min(1)
})

/**
 * What one editor has ALREADY reported on this text, sent back to it when the
 * user asks for more ("Generate more" — plan M6). Deliberately only the quote
 * and the critique: enough for the editor to recognize the ground it covered,
 * without re-sending suggestions, evidence and anchoring aids it does not need
 * to avoid repeating itself. Both are clipped — an over-long echo of the
 * previous round would crowd out the document the second pass is supposed to
 * read more carefully.
 */
export const reportedFindingSchema = z.object({
    quote: z.string().min(1).max(QUOTE_MAX),
    critique: z.string().min(1).max(1_000)
})
export type ReportedFinding = z.infer<typeof reportedFindingSchema>

/** Whole-note (or selection-scoped) review by one editor persona. */
export const reviewRequestSchema = baseRequest.extend({
    kind: z.literal('review'),
    text: z.string().max(LONG_TEXT_MAX),
    /** Selection range within `text` when the review is selection-scoped. */
    selection: z.object({ from: z.number().int().min(0), to: z.number().int().min(0) }).optional(),
    /**
     * Present ONLY on a continuation pass: the findings this editor already
     * produced for this run. The prompt then asks for ADDITIONAL findings and
     * forbids repeating these — the previous round is kept, not replaced, so a
     * continuation must never re-report what the user is already triaging.
     * Absent (not empty) on a first pass, so a backend can tell "nothing yet"
     * from "found nothing".
     */
    alreadyReported: z.array(reportedFindingSchema).max(200).optional()
})

/** An action verb applied to a selection (rephrase, critique, simplify…). */
export const transformSelectionRequestSchema = baseRequest.extend({
    kind: z.literal('transform-selection'),
    text: z.string().max(LONG_TEXT_MAX),
    selection: z.object({ from: z.number().int().min(0), to: z.number().int().min(0) }),
    /** The action instruction (built-in verb prompt or custom action prompt). */
    instruction: z.string().min(1).max(SHORT_TEXT_MAX)
})

/** Continuation: generate content to insert at a position ("Generate more"). */
export const insertAtRequestSchema = baseRequest.extend({
    kind: z.literal('insert-at'),
    text: z.string().max(LONG_TEXT_MAX),
    position: z.number().int().min(0),
    instruction: z.string().max(SHORT_TEXT_MAX).optional()
})

/** One turn of a per-finding push-back conversation. */
export const threadTurnRequestSchema = baseRequest.extend({
    kind: z.literal('thread-turn'),
    findingId: z.string().min(1),
    /**
     * The span's text as it reads NOW — resolved against the live buffer, so
     * it may differ from the text `snapshotHash` identifies.
     */
    quote: z.string().min(1).max(QUOTE_MAX),
    critique: z.string().max(SHORT_TEXT_MAX),
    history: z
        .array(
            z.object({
                role: z.enum(['user', 'editor']),
                content: z.string().max(SHORT_TEXT_MAX)
            })
        )
        .max(50),
    message: z.string().min(1).max(SHORT_TEXT_MAX)
})

/** Ceiling on one editor's learned memory (mirrors `memoryText`'s schema max). */
export const MEMORY_TEXT_MAX = 50_000

/**
 * The user's decision on one finding, as distillation input (issue #4).
 * `held`: the user pushed back and the editor kept its position — not
 * terminal (a later accept/reject on the same finding is a second event),
 * but the exchange itself is signal.
 */
export const triageDecisionSchema = z.enum([
    'accepted',
    'rejected',
    'dismissed',
    'conceded',
    'held'
])
export type TriageDecision = z.infer<typeof triageDecisionSchema>

/**
 * One triaged finding fed to memory distillation (issue #4): the observation
 * (quote + critique + severity), what the user decided, and — for conceded
 * findings — the push-back thread that changed the editor's mind. Bounds
 * mirror the journal's clipping (`memory-journal.ts`), not the finding
 * contract: distillation reads a compressed record, never the full finding.
 */
export const distillTriageEventSchema = z.object({
    quote: z.string().min(1).max(QUOTE_MAX),
    critique: z.string().min(1).max(1_000),
    severity: severitySchema,
    decision: triageDecisionSchema,
    thread: z
        .array(
            z.object({
                role: z.enum(['user', 'editor']),
                content: z.string().max(1_000)
            })
        )
        .max(50)
        .default([])
})
export type DistillTriageEvent = z.infer<typeof distillTriageEventSchema>

/**
 * Memory distillation (issue #4): rewrite one editor's learning memory from
 * the session's triage decisions. `currentMemory` is the memory as it stands
 * (settings text or memory-note body, frontmatter stripped); the result's
 * `memory` REPLACES it wholesale — replacement is the rotation/cap mechanism,
 * there is no append path.
 */
export const distillMemoryRequestSchema = baseRequest.extend({
    kind: z.literal('distill-memory'),
    currentMemory: z.string().max(MEMORY_TEXT_MAX),
    events: z.array(distillTriageEventSchema).min(1).max(200)
})

/** Panel aggregation over completed member results. */
export const aggregatePanelRequestSchema = baseRequest.extend({
    kind: z.literal('aggregate-panel'),
    members: z
        .array(
            z.object({
                editorName: z.string().max(200),
                findings: z.array(rawFindingSchema).max(200),
                summary: z.string().max(SHORT_TEXT_MAX).optional(),
                verdict: verdictSchema.optional(),
                failed: z.boolean().default(false),
                /**
                 * How many of this member's findings the aggregation budget
                 * left out (see `domain/panels/panel-aggregation.ts`). Carried
                 * so the chairperson knows the member's list is a prefix and
                 * does not write "nothing else was reported" over a truncation.
                 */
                omittedFindings: z.number().int().min(0).max(1_000).default(0)
            })
        )
        .min(1)
        .max(20)
})

export const operationRequestSchema = z.discriminatedUnion('kind', [
    reviewRequestSchema,
    transformSelectionRequestSchema,
    insertAtRequestSchema,
    threadTurnRequestSchema,
    distillMemoryRequestSchema,
    aggregatePanelRequestSchema
])
export type OperationRequest = z.infer<typeof operationRequestSchema>
export type ReviewRequest = z.infer<typeof reviewRequestSchema>
export type TransformSelectionRequest = z.infer<typeof transformSelectionRequestSchema>
export type InsertAtRequest = z.infer<typeof insertAtRequestSchema>
export type ThreadTurnRequest = z.infer<typeof threadTurnRequestSchema>
export type DistillMemoryRequest = z.infer<typeof distillMemoryRequestSchema>
export type AggregatePanelRequest = z.infer<typeof aggregatePanelRequestSchema>

// ---------------------------------------------------------------------------
// Operation results (one shape per request kind)
// ---------------------------------------------------------------------------

export const reviewResultSchema = z.object({
    kind: z.literal('review'),
    findings: z.array(rawFindingSchema).max(200),
    /** Note-level remarks that anchor to nothing specific. */
    summary: z.string().max(SHORT_TEXT_MAX).optional(),
    /** Only gate-style reviews return a verdict. */
    verdict: verdictSchema.optional()
})

/**
 * Model-facing variant of the review result: identical, minus the salvage
 * marker — `invalidProposal` belongs to the plugin's validation pass, not to
 * the wire shape a model is asked to produce. Used by the prompt layer's
 * schema derivation only; parsing always goes through `reviewResultSchema`.
 */
export const reviewResultWireSchema = reviewResultSchema.extend({
    findings: z.array(rawFindingSchema.omit({ invalidProposal: true })).max(200)
})

export const transformSelectionResultSchema = z.object({
    kind: z.literal('transform-selection'),
    /** Replacement for the selected range. */
    replacement: z.string().max(LONG_TEXT_MAX),
    rationale: z.string().max(1_000).optional(),
    evidence: z.array(evidenceSchema).max(20).default([])
})

export const insertAtResultSchema = z.object({
    kind: z.literal('insert-at'),
    insertion: z.string().max(LONG_TEXT_MAX),
    rationale: z.string().max(1_000).optional(),
    evidence: z.array(evidenceSchema).max(20).default([])
})

export const threadTurnResultSchema = z.object({
    kind: z.literal('thread-turn'),
    /** What the editor says back; shown verbatim in the finding card's thread. */
    reply: z.string().min(1).max(SHORT_TEXT_MAX),
    /**
     * True when the editor WITHDRAWS the finding: the push-back convinced it,
     * so the finding is auto-dismissed and `reply` is the withdrawal note.
     * Conceding and revising are mutually exclusive — a withdrawn finding has
     * no proposal left to apply, so `revisedEdits`/`revisedCritique` are
     * ignored when this is true.
     */
    concede: z.boolean().default(false),
    /**
     * Sharpened critique when the editor HOLDS its position; replaces the
     * finding's critique in place (the thread carries the reasoning).
     */
    revisedCritique: z.string().max(SHORT_TEXT_MAX).optional(),
    /**
     * A thread turn may end with a revised proposal for the finding — the
     * same edit primitive findings use (contract v2), REPLACING the finding's
     * edits wholesale. Re-anchored on arrival against the live text; an edit
     * without its own quote targets the finding's span, as everywhere.
     */
    revisedEdits: z.array(rawEditSchema).max(FINDING_EDITS_MAX).optional()
})
export type ThreadTurnResult = z.infer<typeof threadTurnResultSchema>

/**
 * Distillation result (issue #4): the WHOLE rewritten memory. Replaces the
 * editor's memory when — and only when — the user confirms it in the review
 * modal (Business Rules #2). The 50k ceiling is a hard reject, matching the
 * `memoryText` schema max; the prompt asks for well under 10k.
 */
export const distillMemoryResultSchema = z.object({
    kind: z.literal('distill-memory'),
    memory: z.string().min(1).max(MEMORY_TEXT_MAX)
})
export type DistillMemoryResult = z.infer<typeof distillMemoryResultSchema>

/**
 * One ranked action from the scorecard. `action` is the instruction; the two
 * optional fields are a POINTER back to the member finding it came from, so
 * the UI can reveal that finding in the note instead of leaving the user to
 * search for the span a sentence describes. They are optional because a
 * legitimate top fix can be structural ("cut the second half") and anchor to
 * no single span — an invented pointer would be worse than none.
 */
export const panelTopFixSchema = z.object({
    /** The concrete action, imperative and self-contained. */
    action: z.string().min(1).max(1_000),
    /** Name of the member that reported the finding this fix comes from. */
    editorName: z.string().max(200).optional(),
    /** That finding's quote, copied verbatim so it resolves to the same span. */
    quote: z.string().max(QUOTE_MAX).optional()
})
export type PanelTopFix = z.infer<typeof panelTopFixSchema>

/**
 * One disagreement between members, kept as structure rather than prose.
 *
 * Dissent is the reason a panel is worth more than one editor: four readers
 * who agree tell you what one would have. A free-text field invites the model
 * to average the disagreement into a balanced sentence and lose which member
 * held which position — so the subject and the per-member positions are
 * separate fields, and the UI can name the sides.
 */
export const panelDissentSchema = z.object({
    /** What the members disagree about, in one line. */
    subject: z.string().min(1).max(500),
    positions: z
        .array(
            z.object({
                editorName: z.string().max(200),
                /** That member's position, in its own terms — never merged. */
                stance: z.string().min(1).max(1_000)
            })
        )
        .min(1)
        .max(20)
})
export type PanelDissent = z.infer<typeof panelDissentSchema>

export const panelResultSchema = z.object({
    kind: z.literal('aggregate-panel'),
    recommendation: verdictSchema,
    /** One line stating what the panel concluded, beyond the verdict token. */
    rationale: z.string().max(SHORT_TEXT_MAX).optional(),
    memberVerdicts: z
        .array(
            z.object({
                editorName: z.string().max(200),
                verdict: verdictSchema.optional(),
                /** That member's one-line rationale for its verdict. */
                keyPoint: z.string().max(1_000).optional()
            })
        )
        .max(20),
    /** Ranked, most important first. */
    topFixes: z.array(panelTopFixSchema).max(10),
    dissent: z.array(panelDissentSchema).max(10).default([]),
    /** Members that failed and are therefore missing from the synthesis. */
    missingMembers: z.array(z.string().max(200)).default([])
})
export type PanelResult = z.infer<typeof panelResultSchema>

export const operationResultSchema = z.discriminatedUnion('kind', [
    reviewResultSchema,
    transformSelectionResultSchema,
    insertAtResultSchema,
    threadTurnResultSchema,
    distillMemoryResultSchema,
    panelResultSchema
])
export type OperationResult = z.infer<typeof operationResultSchema>

// ---------------------------------------------------------------------------
// Backend events
// ---------------------------------------------------------------------------

/**
 * Events a backend adapter emits while executing an operation. Exactly one
 * terminal event (`result` or `error`) per run; anything received after the
 * terminal event, or carrying a foreign runId, is discarded by the
 * orchestrator.
 */
export type OperationEvent =
    | { readonly type: 'progress'; readonly runId: string; readonly message?: string }
    | { readonly type: 'finding'; readonly runId: string; readonly finding: RawFinding }
    | {
          readonly type: 'result'
          readonly runId: string
          readonly result: OperationResult
          /**
           * What the per-finding salvage pass removed from a review result
           * (contract v2 design doc §5): findings dropped for an invalid
           * observation core, and proposals stripped for invalid edits. The
           * run layer reports it — degradation is visible, never silent.
           */
          readonly salvage?: {
              readonly discardedFindings: number
              readonly invalidProposals: number
          }
      }
    | {
          readonly type: 'error'
          readonly runId: string
          readonly error: {
              readonly code:
                  | 'auth'
                  | 'rate-limit'
                  /** Credits/billing exhausted — clears only when the user pays (issue #23). */
                  | 'quota'
                  | 'network'
                  | 'invalid-output'
                  /** The model hit its output cap mid-payload (issue #18) — a shorter ask, not a retry. */
                  | 'truncated'
                  | 'cancelled'
                  | 'timeout'
                  | 'unknown'
              readonly message: string
              /**
               * Provider-requested wait before retrying (Retry-After), when
               * one was sent with a rate-limit failure. Consumed by the
               * automatic retry policy (issue #23).
               */
              readonly retryAfterMs?: number
              /**
               * What the failure boundary captured but must not show
               * unprompted (issue #39). `summary` is status-only and safe
               * anywhere; the content behind `reveal()` is a CLI tool's raw
               * output and can quote back the configuration it was given —
               * including credentials — so a UI may render it ONLY behind an
               * explicit user gesture, never in a Notice or an error report
               * (Business Rules #12). The shape matches the CLI boundary's
               * `StderrDiagnostics` on purpose.
               */
              readonly diagnostics?: OperationErrorDiagnostics
          }
      }

/**
 * Captured failure detail an error event may carry. See the field's own
 * comment for the reveal-only-on-gesture rule; this type exists so UI code
 * can name the shape without importing the CLI boundary.
 */
export interface OperationErrorDiagnostics {
    /** Status-only sentence, safe to show anywhere. */
    readonly summary: string
    /** The captured content. Explicit user gesture only. */
    reveal(): string
}
