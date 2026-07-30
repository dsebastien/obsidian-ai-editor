import { z } from 'zod'
import {
    insertAtResultSchema,
    panelResultSchema,
    refineProposalResultSchema,
    reviewResultSchema,
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
    'review': reviewResultSchema,
    'transform-selection': transformSelectionResultSchema,
    'insert-at': insertAtResultSchema,
    'refine-proposal': refineProposalResultSchema,
    'thread-turn': threadTurnResultSchema,
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
    return z.toJSONSchema(RESULT_SCHEMAS[kind], { io: 'input' }) as Record<string, unknown>
}

function tag(name: string, content: string): string {
    return `<${name}>\n${content}\n</${name}>`
}

/** Kind-specific behavioral rules, beyond what a JSON schema can express. */
function kindRules(operation: OperationRequest): string[] {
    switch (operation.kind) {
        case 'review':
            return [
                'Each finding\'s "quote" MUST be copied character-for-character verbatim from the document text (raw markdown, including any markup). Never paraphrase, trim punctuation, or normalize whitespace inside a quote.',
                'Keep quotes short and span-like (a phrase, sentence or line — not whole paragraphs).',
                'When the quoted text occurs more than once, provide "prefix" and/or "suffix" (the exact adjacent text, up to 200 characters) and the 0-based "occurrence" index to disambiguate.',
                'Provide "suggestion" only when proposing a concrete replacement for the quoted span; the suggestion replaces the quote exactly.',
                'Use "summary" for note-level remarks that do not anchor to a specific span. Do not invent findings to fill space — an empty findings array is a valid result.'
            ]
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
        case 'refine-proposal':
            return [
                '"suggestion" must be a complete revised replacement for the quoted text, refining the previous suggestion according to the instruction — not a diff or commentary.'
            ]
        case 'thread-turn':
            return [
                "Reply to the user's message in the context of the finding and prior turns.",
                'Set "concede" to true ONLY when the push-back convinced you the finding does not hold — you are withdrawing it, and "reply" says why in one or two sentences. A withdrawn finding is dismissed, so do not also send a revised critique or suggestion.',
                'Otherwise hold your position: keep "concede" false, and use "revisedCritique" and/or "revisedSuggestion" when the exchange sharpened what you are asking for. Omit both when nothing changed.',
                '"revisedSuggestion" must be a complete replacement for the quoted text, not a diff or commentary.'
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
                'Review the document below and report your findings.',
                tag('document', operation.text)
            ]
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
        case 'refine-proposal':
            return [
                'Refine your previous suggestion for the quoted text according to the instruction.',
                tag('quoted-text', operation.quote),
                tag('previous-suggestion', operation.previousSuggestion),
                tag('instruction', operation.instruction)
            ].join('\n\n')
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
