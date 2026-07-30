import type { OperationRequest } from '../../../../domain/operations/contract'
import { buildUserMessage } from '../../providers/prompt'

/**
 * Operation → stdin serialization shared by every CLI tool adapter.
 *
 * The API path splits its request in two: the persona goes in the provider's
 * system-prompt field, the operation payload goes in the user message. A
 * headless CLI agent has no comparable split we can use — both tools DO have
 * a system-prompt flag, but a flag means argv, and argv is world-readable in
 * `ps` and capped by the boundary at 4096 characters precisely so a note
 * cannot end up there. So the two halves are concatenated into ONE stdin
 * payload, with the persona delimited so the model can still tell standing
 * instructions from this request.
 *
 * The operation half is `buildUserMessage` — the same function every API
 * adapter calls, in its `'json-object'` style: neither tool exposes a
 * forced-tool-call mechanism through its headless interface, so the model is
 * told to answer with a bare JSON object and the operation's JSON Schema is
 * embedded inline. Sharing that function is the point: a CLI backend that
 * built its own prompt would drift from the API backends' output contract,
 * and the same Zod validators would then start failing for one family only.
 *
 * The delimiters are XML-style rather than markdown fences for the same
 * reason as everywhere else in this codebase — the payload IS markdown, and
 * a fence inside the document would close the framing.
 */

/**
 * The closing directive, appended after the operation's own output rules so
 * it is the last thing the model reads.
 *
 * It exists because an agentic CLI is chattier than a chat completion: its
 * final message is a report to a human by default, and a report wrapped
 * around the JSON is the single most likely way a CLI run fails where the
 * equivalent API run succeeds. The plugin still tolerates only what the API
 * parsers tolerate (a whole-string markdown fence, via `extractJsonPayload`)
 * — instructing strictly and parsing leniently is the API path's contract
 * too, and widening the parser to hunt for the first `{` would mean picking
 * a payload out of text the plugin does not control.
 */
const CLI_OUTPUT_DIRECTIVE = [
    'You are running non-interactively: nobody will read a report, and there is no follow-up turn.',
    'Your entire final message must be the single JSON object described above and nothing else —',
    'no preamble, no explanation, no progress notes, no closing remarks.'
].join('\n')

export interface BuildCliStdinInput {
    /** Assembled persona system prompt; may be empty. */
    readonly systemPrompt: string
    readonly operation: OperationRequest
}

/**
 * Serializes one operation into the complete stdin payload for a CLI tool.
 *
 * Everything the tool is told travels through this one string, which is also
 * what makes the boundary's "content on stdin only" guarantee meaningful:
 * there is no second channel an adapter could be tempted to use.
 */
export function buildCliStdin(input: BuildCliStdinInput): string {
    const persona = input.systemPrompt.trim()
    const parts: string[] = []
    if (persona.length > 0) {
        parts.push(
            'Follow the instructions in <persona-instructions> for this task.',
            `<persona-instructions>\n${persona}\n</persona-instructions>`
        )
    }
    parts.push(buildUserMessage(input.operation, 'json-object'), CLI_OUTPUT_DIRECTIVE)
    return parts.join('\n\n')
}
