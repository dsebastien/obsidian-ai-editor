/**
 * What a background comment job asks the editor, as one instruction block.
 *
 * A margin comment is a `review` operation narrowed to a span, so the request
 * carries the whole note (context) plus a selection (scope) — but the SPAN and
 * the QUESTION are not part of the review contract, and the only place they
 * can be stated is the per-run instruction. This is the composer for that
 * block, kept pure and separate so the wording is spec-pinned rather than
 * buried in a service.
 *
 * The wording does three jobs, and each is load-bearing:
 *
 * 1. **Quotes the span verbatim.** The editor must answer about the text the
 *    user pointed at, not about the note. The quote is the LIVE text at
 *    dispatch (re-anchored, see `reanchorComment`), so an edit made between
 *    parking the question and the job starting is reflected rather than
 *    ignored.
 * 2. **Repeats the anchoring contract.** Findings must quote verbatim from the
 *    submitted text (Business Rules #4); a background answer is persisted and
 *    re-anchored days later, so a paraphrased quote does not degrade — it
 *    orphans permanently.
 * 3. **Allows a note-level answer.** Plenty of parked questions ("is this
 *    claim supported?") are answered in a sentence, not as a finding. Saying
 *    so prevents the editor from manufacturing a finding to have something to
 *    return.
 */

/** Cap on the quoted span inside the instruction, matching the contract's. */
const QUOTE_MAX = 2_000

export interface CommentInstructionInput {
    /** The span the comment sits on, as it reads at dispatch. */
    readonly quote: string
    /** What the user asked. */
    readonly instruction: string
}

export function commentInstruction(input: CommentInstructionInput): string {
    const quote = clip(input.quote.trim(), QUOTE_MAX)
    const question = input.instruction.trim()
    return [
        'The user left a comment on one span of this note and walked away. Answer that comment.',
        '',
        `The span, verbatim:\n"""\n${quote}\n"""`,
        '',
        `Their question: ${question}`,
        '',
        'Answer only about that span. Report a finding for each concrete, actionable point, quoting verbatim from the submitted text so it can be located later. If the answer is not about a specific piece of text, put it in the summary instead of inventing a finding.'
    ].join('\n')
}

function clip(text: string, max: number): string {
    return text.length > max ? `${text.slice(0, max)}…` : text
}
