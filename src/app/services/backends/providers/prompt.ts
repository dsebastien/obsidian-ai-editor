import { z } from 'zod'
import {
    distillMemoryResultSchema,
    insertAtResultSchema,
    panelResultSchema,
    reviewResultWireSchema,
    threadTurnResultSchema,
    transformSelectionResultSchema,
    type OperationRequest
} from '../../../domain/operations/contract'

/**
 * Operation → prompt serialization shared by every API provider adapter.
 *
 * The system prompt is the persona (assembled upstream); the user message
 * built here carries the operation payload plus STRICT output-format
 * instructions matching the operation kind's result schema. Zod validation
 * at parse time is the enforcement boundary — these instructions (and the
 * per-provider server-side schemas) exist to make the model comply on the
 * first try.
 *
 * Document text is delimited with XML-style tags rather than markdown fences
 * because the payload IS markdown (fences inside the document would break a
 * fenced framing).
 */

/**
 * Output-style variants: providers forcing a tool call (Anthropic) must not
 * tell the model to "reply with JSON only" — the tool input carries the
 * result; everyone else gets the schema inline plus a JSON-only directive.
 */
export type OutputStyle = 'json-object' | 'tool-input'

const RESULT_SCHEMAS = {
    // The wire variant omits the plugin-internal salvage marker; validation
    // still runs against the full `reviewResultSchema`.
    'review': reviewResultWireSchema,
    'transform-selection': transformSelectionResultSchema,
    'insert-at': insertAtResultSchema,
    'thread-turn': threadTurnResultSchema,
    'distill-memory': distillMemoryResultSchema,
    'aggregate-panel': panelResultSchema
} as const

/**
 * JSON Schema for the result shape of one operation kind, derived from the
 * authoritative Zod schemas ('input' mode: defaulted fields stay optional
 * for the model). Fed to provider-side enforcement (Anthropic tool
 * `input_schema`, OpenAI `response_format.json_schema`) and embedded in
 * prompt instructions.
 */
export function resultJsonSchema(kind: OperationRequest['kind']): Record<string, unknown> {
    return z.toJSONSchema(RESULT_SCHEMAS[kind], { io: 'input' })
}

function tag(name: string, content: string): string {
    return `<${name}>\n${content}\n</${name}>`
}

/** Kind-specific behavioral rules, beyond what a JSON schema can express. */
function kindRules(operation: OperationRequest): string[] {
    switch (operation.kind) {
        case 'review': {
            const rules = [
                'Each finding\'s "quote" MUST be copied character-for-character verbatim from the document text (raw markdown, including any markup). Never paraphrase, trim punctuation, or normalize whitespace inside a quote.',
                'Keep quotes short and span-like (a phrase, sentence or line — not whole paragraphs).',
                'When the quoted text occurs more than once, provide "prefix" and/or "suffix" (the exact adjacent text, up to 200 characters) and the 0-based "occurrence" index to disambiguate.',
                '"critique" explains the problem TO THE USER. It is never written into the document.',
                'Propose concrete changes in "edits". Each edit is applied mechanically, exactly as given — so "text" must contain ONLY document content, never advice, never commentary, never phrases like "you should" or "consider adding".',
                'Edit operations: "replace" replaces the edit\'s target with "text"; "insert-before" inserts "text" immediately before the target, leaving the target untouched; "insert-after" inserts "text" immediately after the target; "delete" removes the target ("text" not needed). Never use "replace" to add content around text that should stay — use an insert operation.',
                'An edit\'s target is its own verbatim "quote" (with the same disambiguation hints as findings); omit the edit\'s "quote" to target the finding\'s quoted span.',
                'Example — add a missing caveat above a quoted line WITHOUT touching the line: {"op": "insert-before", "text": "Note: requires v2 or later.\\n\\n"}.',
                'Accepting a finding applies ALL of its edits at once. Changes the user should be able to take independently belong in separate findings.',
                'A finding may have no edits at all when you have no concrete change to propose — the critique alone is valuable.',
                'Use "summary" for note-level remarks that do not anchor to a specific span. Do not invent findings to fill space — an empty findings array is a valid result.'
            ]
            if (operation.alreadyReported !== undefined) {
                // Continuation pass: the earlier findings are KEPT, so a repeat
                // is a duplicate the user has to dismiss twice. Returning
                // nothing is explicitly allowed — the alternative is padding.
                rules.push(
                    'This is an ADDITIONAL pass: report only findings you have NOT already made. Do not repeat, rephrase or split any finding listed as already reported, and do not restate them in "summary".',
                    'Look for what a first read misses — subtler problems, passages you skimmed, cumulative issues across the document. Reporting nothing further is a valid and honest result; never pad the list to look productive.'
                )
            }
            return rules
        }
        case 'transform-selection':
            return [
                '"replacement" must be a drop-in replacement for the selected text only — never restate the surrounding document.',
                'Preserve the markdown conventions of the original selection unless the instruction says otherwise.'
            ]
        case 'insert-at':
            return [
                '"insertion" is inserted verbatim between the before and after parts — write it to flow naturally with both sides.',
                "Match the document's language, tone and markdown conventions."
            ]
        case 'thread-turn':
            return [
                "Reply to the user's message in the context of the finding and prior turns.",
                'Set "concede" to true ONLY when the push-back convinced you the finding does not hold — you are withdrawing it, and "reply" says why in one or two sentences. A withdrawn finding is dismissed, so do not also send a revised critique or edits.',
                'Otherwise hold your position: keep "concede" false, and use "revisedCritique" and/or "revisedEdits" when the exchange sharpened what you are asking for. Omit both when nothing changed.',
                '"revisedEdits" REPLACES your earlier proposal wholesale. Each edit is applied mechanically: "text" contains ONLY document content, never commentary. Operations: "replace" replaces the edit\'s target with "text"; "insert-before"/"insert-after" insert "text" around the target, leaving it untouched; "delete" removes it. An edit\'s target is its own verbatim "quote" from the document; omit it to target the quoted text of this finding.'
            ]
        case 'distill-memory':
            return [
                '"memory" REPLACES the current memory wholesale — this rewrite IS the size control. Merge what still holds from the current memory with what the new decisions teach, drop rules that repeated evidence contradicts, and generalize patterns instead of listing episodes.',
                'Write imperative rules addressed to yourself, the editor persona ("Stop flagging…", "The author accepts…", "Keep insisting on…"). Rules, not a diary.',
                'Read the decisions as signal: "accepted" means the author took your suggestion; "rejected" and "dismissed" are negative signal about that kind of finding; "conceded" means you withdrew after push-back — the strongest evidence you were wrong, and the thread says why; "held" means the author pushed back but you kept your position — the thread carries the argument, and repeated push-back on the same kind of finding means the author disputes it even if you still believe it.',
                "Never copy the quoted document text into the memory beyond short illustrative fragments — the memory is about the author's preferences, not their content.",
                'Keep the memory well under 10,000 characters. Short and dense beats exhaustive; drop the weakest rule before adding a marginal one.'
            ]
        case 'aggregate-panel':
            return [
                'Synthesize the member reviews into one recommendation; never invent findings the members did not report.',
                'Give every member listed in the input a "memberVerdicts" entry, with its verdict and a one-line "keyPoint" saying why. Members marked "failed": true produced nothing — list them in "missingMembers", give them no verdict, and do not speak for them.',
                '"topFixes" are the highest-impact concrete actions, most important first. When a fix comes from a specific member finding, set "editorName" to that member and copy that finding\'s "quote" character-for-character into "quote" so the fix can be linked back to the text; omit both fields for structural fixes that anchor to no single span.',
                'Record every real disagreement in "dissent": one entry per subject, with each disagreeing member\'s position under "positions". Do not average opposing readings into one balanced sentence, and do not report a disagreement that is only a difference of emphasis. An empty "dissent" array is a valid result when the members genuinely agreed.',
                'A member with "omittedFindings" greater than 0 reported more findings than fit here — its list is a prefix, so do not conclude it found nothing else.'
            ]
    }
}

function payload(operation: OperationRequest): string {
    switch (operation.kind) {
        case 'review': {
            const parts = [
                operation.alreadyReported === undefined
                    ? 'Review the document below and report your findings.'
                    : 'You already reviewed the document below and reported the findings listed after it. Read it again and report what you did NOT report the first time.',
                tag('document', operation.text)
            ]
            if (operation.alreadyReported !== undefined) {
                parts.push(
                    'You have already reported these findings on this document. They still stand — do not repeat them:',
                    tag(
                        'already-reported',
                        operation.alreadyReported.length === 0
                            ? '(none)'
                            : operation.alreadyReported
                                  .map((finding) =>
                                      [
                                          tag('quote', finding.quote),
                                          tag('critique', finding.critique)
                                      ].join('\n')
                                  )
                                  .join('\n')
                    )
                )
            }
            if (operation.selection) {
                parts.push(
                    'Restrict your review to this selected excerpt of the document (findings must quote from it):',
                    tag(
                        'selection',
                        operation.text.slice(operation.selection.from, operation.selection.to)
                    )
                )
            }
            return parts.join('\n\n')
        }
        case 'transform-selection':
            return [
                'Apply the instruction to the selected text. The document is provided for context only.',
                tag('document', operation.text),
                tag(
                    'selection',
                    operation.text.slice(operation.selection.from, operation.selection.to)
                ),
                tag('instruction', operation.instruction)
            ].join('\n\n')
        case 'insert-at': {
            const parts = [
                'Write content to insert at the marked position, between the text before and the text after.',
                tag('text-before-insertion-point', operation.text.slice(0, operation.position)),
                tag('text-after-insertion-point', operation.text.slice(operation.position))
            ]
            if (operation.instruction !== undefined && operation.instruction.length > 0) {
                parts.push(tag('instruction', operation.instruction))
            }
            return parts.join('\n\n')
        }
        case 'thread-turn': {
            const history = operation.history
                .map((turn) =>
                    tag(turn.role === 'user' ? 'user-turn' : 'editor-turn', turn.content)
                )
                .join('\n')
            const parts = [
                'Continue the discussion thread about this finding.',
                tag('quoted-text', operation.quote),
                tag('finding-critique', operation.critique)
            ]
            if (operation.history.length > 0) {
                parts.push(tag('thread-history', history))
            }
            parts.push(tag('user-message', operation.message))
            return parts.join('\n\n')
        }
        case 'distill-memory': {
            const events = operation.events
                .map((event) => {
                    const parts = [
                        tag('decision', event.decision),
                        tag('severity', event.severity),
                        tag('quote', event.quote),
                        tag('critique', event.critique)
                    ]
                    if (event.thread.length > 0) {
                        parts.push(
                            tag(
                                'thread',
                                event.thread
                                    .map((turn) =>
                                        tag(
                                            turn.role === 'user' ? 'user-turn' : 'editor-turn',
                                            turn.content
                                        )
                                    )
                                    .join('\n')
                            )
                        )
                    }
                    return tag('triage-event', parts.join('\n'))
                })
                .join('\n')
            return [
                'Rewrite your learning memory from the triage decisions below — what the author accepted, rejected, dismissed, argued you out of, or argued against while you held your position.',
                tag(
                    'current-memory',
                    operation.currentMemory.length > 0 ? operation.currentMemory : '(empty)'
                ),
                tag('triage-events', events)
            ].join('\n\n')
        }
        case 'aggregate-panel':
            return [
                'Aggregate the panel member reviews below into a scorecard.',
                tag('member-reviews', JSON.stringify(operation.members, null, 2))
            ].join('\n\n')
    }
}

function outputInstructions(operation: OperationRequest, style: OutputStyle): string {
    const rules = kindRules(operation)
        .map((rule) => `- ${rule}`)
        .join('\n')
    if (style === 'tool-input') {
        return [
            'OUTPUT FORMAT — follow exactly:',
            `Report your result by calling the provided tool. The tool input must have "kind" set to "${operation.kind}".`,
            rules
        ].join('\n')
    }
    return [
        'OUTPUT FORMAT — follow exactly:',
        'Respond with a single JSON object and nothing else — no markdown fences, no prose before or after.',
        `The object must have "kind" set to "${operation.kind}" and conform to this JSON Schema:`,
        JSON.stringify(resultJsonSchema(operation.kind)),
        rules
    ].join('\n')
}

/**
 * Serializes an operation into the user message sent to the model: the
 * operation payload followed by the strict output-format contract.
 */
export function buildUserMessage(operation: OperationRequest, style: OutputStyle): string {
    return `${payload(operation)}\n\n${outputInstructions(operation, style)}`
}
