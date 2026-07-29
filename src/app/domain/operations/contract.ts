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

export const CONTRACT_VERSION = 1

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
    /** Proposed replacement text for the quoted span, when applicable. */
    suggestion: z.string().max(SHORT_TEXT_MAX).optional(),
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
    /** Snapshot hash the payload text was captured from. */
    snapshotHash: z.string().min(1)
})

/** Whole-note (or selection-scoped) review by one editor persona. */
export const reviewRequestSchema = baseRequest.extend({
    kind: z.literal('review'),
    text: z.string().max(LONG_TEXT_MAX),
    /** Selection range within `text` when the review is selection-scoped. */
    selection: z.object({ from: z.number().int().min(0), to: z.number().int().min(0) }).optional()
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

/** Refine an existing proposal with a user instruction. */
export const refineProposalRequestSchema = baseRequest.extend({
    kind: z.literal('refine-proposal'),
    findingId: z.string().min(1),
    quote: z.string().min(1).max(QUOTE_MAX),
    previousSuggestion: z.string().max(SHORT_TEXT_MAX),
    instruction: z.string().min(1).max(SHORT_TEXT_MAX)
})

/** One turn of a per-finding push-back conversation. */
export const threadTurnRequestSchema = baseRequest.extend({
    kind: z.literal('thread-turn'),
    findingId: z.string().min(1),
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
                failed: z.boolean().default(false)
            })
        )
        .min(1)
        .max(20)
})

export const operationRequestSchema = z.discriminatedUnion('kind', [
    reviewRequestSchema,
    transformSelectionRequestSchema,
    insertAtRequestSchema,
    refineProposalRequestSchema,
    threadTurnRequestSchema,
    aggregatePanelRequestSchema
])
export type OperationRequest = z.infer<typeof operationRequestSchema>
export type ReviewRequest = z.infer<typeof reviewRequestSchema>
export type TransformSelectionRequest = z.infer<typeof transformSelectionRequestSchema>
export type InsertAtRequest = z.infer<typeof insertAtRequestSchema>
export type RefineProposalRequest = z.infer<typeof refineProposalRequestSchema>
export type ThreadTurnRequest = z.infer<typeof threadTurnRequestSchema>
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

export const refineProposalResultSchema = z.object({
    kind: z.literal('refine-proposal'),
    suggestion: z.string().max(SHORT_TEXT_MAX),
    rationale: z.string().max(1_000).optional()
})

export const threadTurnResultSchema = z.object({
    kind: z.literal('thread-turn'),
    reply: z.string().max(SHORT_TEXT_MAX),
    /** A thread turn may end with a revised suggestion for the finding. */
    revisedSuggestion: z.string().max(SHORT_TEXT_MAX).optional()
})

export const panelResultSchema = z.object({
    kind: z.literal('aggregate-panel'),
    recommendation: verdictSchema,
    memberVerdicts: z
        .array(
            z.object({
                editorName: z.string().max(200),
                verdict: verdictSchema.optional(),
                keyPoint: z.string().max(1_000).optional()
            })
        )
        .max(20),
    topFixes: z.array(z.string().max(1_000)).max(10),
    dissent: z.string().max(SHORT_TEXT_MAX).optional(),
    /** Members that failed and are therefore missing from the synthesis. */
    missingMembers: z.array(z.string().max(200)).default([])
})
export type PanelResult = z.infer<typeof panelResultSchema>

export const operationResultSchema = z.discriminatedUnion('kind', [
    reviewResultSchema,
    transformSelectionResultSchema,
    insertAtResultSchema,
    refineProposalResultSchema,
    threadTurnResultSchema,
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
    | { readonly type: 'result'; readonly runId: string; readonly result: OperationResult }
    | {
          readonly type: 'error'
          readonly runId: string
          readonly error: {
              readonly code:
                  | 'auth'
                  | 'rate-limit'
                  | 'network'
                  | 'invalid-output'
                  | 'cancelled'
                  | 'timeout'
                  | 'unknown'
              readonly message: string
          }
      }
