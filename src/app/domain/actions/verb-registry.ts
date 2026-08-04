import type { BuiltInActionId, VerbClass } from '../settings/settings-schema'

export type { VerbClass }

/**
 * Built-in action verb registry: the pure id → { label, class, instruction }
 * mapping behind every built-in action (plan §6 M4/M5 transform operations).
 *
 * Verb classes decide the execution pipeline:
 * - 'transform' verbs produce a REPLACEMENT for the selection and run as a
 *   `transform-selection` operation (single editor, single result).
 * - 'generate' verbs produce text INSERTED after the selection/cursor and
 *   run as an `insert-at` operation.
 * - 'review' verbs run the ordinary review pipeline with the verb's
 *   instruction augmented onto the editor's system prompt (the same seam as
 *   "Ask an editor") — their findings flow through anchoring, the rail, and
 *   the diff UI exactly like any review.
 *
 * Instruction quality matters: for transform/generate verbs the instruction
 * is the `<instruction>` payload of the operation (the kind-level output
 * rules — drop-in replacement, natural flow — are appended separately by the
 * prompt serializer, so instructions here say WHAT to do, not how to format
 * output). Conventions follow the starter-pack personas: direct second
 * person, concrete mandates, explicit restraint rules.
 */

/**
 * A dispatchable verb — the ONE shape every dispatch path works against, so
 * a custom action travels the same code as a built-in one. Built-ins come
 * from {@link BUILT_IN_VERBS}; a custom action supplies its own label, class
 * and already-resolved instruction (its prompt source is read fresh from the
 * vault at dispatch time — Business Rules #8).
 */
export interface ActionVerb {
    /** Sentence-case UI label (menus, commands, notices). */
    readonly label: string
    readonly verbClass: VerbClass
    /** The verb's prompt: operation instruction or review-prompt augment. */
    readonly instruction: string
}

export interface BuiltInVerb extends ActionVerb {
    readonly id: BuiltInActionId
}

const REPHRASE_INSTRUCTION = `Rephrase the selected text: say the same thing, better. Preserve the meaning, the facts, and the author's voice; improve clarity, rhythm, and word choice. Keep roughly the same length and level of detail — this is a reformulation, not a summary and not an expansion. Never introduce information that is not in the original, and never drop a nuance that is. Keep the original language of the text and its markdown conventions (links, emphasis, lists) intact unless a formatting change is itself the improvement.`

const SUMMARIZE_INSTRUCTION = `Summarize the selected text into a compact replacement that preserves its essential claims, conclusions, and any load-bearing numbers or caveats. Cut examples, repetition, and scaffolding; never introduce information that is not in the original. Aim for a small fraction of the original length while staying accurate — a reader of the summary alone must not be misled about what the full text says. Keep the original language; use plain prose, or a short list only when the original's structure demands it.`

const SIMPLIFY_INSTRUCTION = `Simplify the selected text so a motivated newcomer can follow it: shorter sentences, everyday words, one idea per sentence. Unpack jargon and acronyms — define them in place or replace them with plain language. Preserve every fact and nuance that matters; simplification must never change what the text claims. Keep the original language and the author's voice — the goal is simpler, not dumber.`

const HUMANIZE_INSTRUCTION = `Rewrite the selected text to remove the fingerprints of machine-generated prose while preserving its meaning and the author's voice. Vary sentence length and shape — uniform rhythm is the strongest machine tell; mix short sentences with long ones. Replace hedged, generic, or inflated phrasing ("delve", "crucial", "seamless", "it's important to note") with concrete, committed statements. Remove chatbot artifacts, empty transition bridges ("Here's the thing"), and formula patterns ("It's not just X — it's Y"). Do not over-polish: natural irregularities and idiosyncratic word choices are what keep text human, so change what smells generated and leave the rest alone. Keep the original language and markdown conventions.`

const CONTINUE_INSTRUCTION = `Continue writing from the insertion point as the author would. Pick up the thread mid-flow: match the language, tone, voice, and markdown conventions of what precedes, and advance the piece — the next argument, step, example, or scene — rather than summarizing or restating what is already written. Write a natural next passage (typically one to three paragraphs) and stop at a point where the author can take over cleanly. If text follows the insertion point, the passage must also lead into it without repeating it.`

const SAY_MORE_INSTRUCTION = `Expand on what immediately precedes the insertion point: add the depth the author left implicit. Concrete examples, evidence, implications, edge cases, or the reasoning behind a claim — whichever genuinely adds substance here. Do not restate what is already written and do not pad: every added sentence must carry new information. Match the language, tone, voice, and markdown conventions of the surrounding text, and keep the expansion proportionate — depth, not sprawl.`

const EXPAND_SECTION_INSTRUCTION = `The insertion point sits at the end of one SECTION of the note — everything under the heading that governs it. Expand that section: develop what it already says with the depth the author left implicit — concrete examples, evidence, implications, steps, or the reasoning behind its claims. Stay inside the section's topic; the rest of the note is context for consistency, not territory to write into. Do not restate what the section already says, do not summarize it, and do not open a new heading unless the section's own logic demands a sub-heading. Match the language, tone, voice, and markdown conventions of the section, and keep the expansion proportionate to it.`

const CONTINUE_NOTE_INSTRUCTION = `The insertion point is the END of the note. Continue the piece as the author would: advance it — the next argument, section, step, example, or scene — rather than summarizing or restating what is already written. Read the whole note for where it is heading and pick up from its final thought. Match the language, tone, voice, structure, and markdown conventions of the note; if the note's structure calls for the next heading, write it. Write a natural next passage (typically one to three paragraphs) and stop where the author can take over cleanly.`

const CRITIQUE_INSTRUCTION = `Critique this text: identify the most significant weaknesses in its argument, evidence, clarity, and structure, and report each as a finding anchored to the exact passage where the problem lives. Be direct and specific — name what is weak and why it fails, never that it "could be improved". Prioritize load-bearing problems over cosmetic ones, and propose a concrete fix as the suggestion when one exists. If the text is genuinely strong, say so in the summary instead of manufacturing objections.`

const FIND_EVIDENCE_INSTRUCTION = `Find the claims in this text that need supporting evidence. For each, report a finding quoting the claim, and state in the critique what kind of support it needs — a source, a number, an example, or a qualification. Attach evidence entries: sources you actually consulted during this review marked "verified", suggested places to check marked "requires-verification"; never mark evidence "verified" unless you truly consulted it. Leave opinions and first-person experience alone — flag only claims a skeptical reader would challenge with "says who?".`

const IDENTIFY_ASSUMPTIONS_INSTRUCTION = `Surface the hidden assumptions this text depends on. For each, report a finding anchored to the passage that relies on it, name the assumption explicitly in the critique, and assess whether it holds — safe, contestable, or likely false. Prioritize load-bearing assumptions: the ones that, if wrong, would break the piece's central claim. Include assumptions about the reader (what they know, what they value, what they have access to) as well as assumptions of fact. Do not pad the list with trivial background truths every text shares.`

/**
 * The eleven built-in verbs, in gallery order: transform verbs first, then
 * generate, then review-class — the order menus present them in. The two
 * placement verbs (issue #31) are generate-class with a COMPUTED insertion
 * point: `expand-section` inserts at the end of the cursor's section,
 * `continue-note` at the end of the note — the dispatch surface computes the
 * caret (`sectionInsertionPoint` / text end), the pipeline is untouched.
 */
export const BUILT_IN_VERBS: readonly BuiltInVerb[] = [
    {
        id: 'rephrase',
        label: 'Rephrase',
        verbClass: 'transform',
        instruction: REPHRASE_INSTRUCTION
    },
    {
        id: 'summarize',
        label: 'Summarize',
        verbClass: 'transform',
        instruction: SUMMARIZE_INSTRUCTION
    },
    {
        id: 'simplify',
        label: 'Simplify',
        verbClass: 'transform',
        instruction: SIMPLIFY_INSTRUCTION
    },
    {
        id: 'humanize',
        label: 'Humanize',
        verbClass: 'transform',
        instruction: HUMANIZE_INSTRUCTION
    },
    {
        id: 'continue',
        label: 'Continue writing',
        verbClass: 'generate',
        instruction: CONTINUE_INSTRUCTION
    },
    {
        id: 'say-more',
        label: 'Say more',
        verbClass: 'generate',
        instruction: SAY_MORE_INSTRUCTION
    },
    {
        id: 'expand-section',
        label: 'Expand section',
        verbClass: 'generate',
        instruction: EXPAND_SECTION_INSTRUCTION
    },
    {
        id: 'continue-note',
        label: 'Continue the note',
        verbClass: 'generate',
        instruction: CONTINUE_NOTE_INSTRUCTION
    },
    {
        id: 'critique',
        label: 'Critique',
        verbClass: 'review',
        instruction: CRITIQUE_INSTRUCTION
    },
    {
        id: 'find-evidence',
        label: 'Find evidence',
        verbClass: 'review',
        instruction: FIND_EVIDENCE_INSTRUCTION
    },
    {
        id: 'identify-assumptions',
        label: 'Identify assumptions',
        verbClass: 'review',
        instruction: IDENTIFY_ASSUMPTIONS_INSTRUCTION
    }
]

const VERBS_BY_ID: ReadonlyMap<string, BuiltInVerb> = new Map(
    BUILT_IN_VERBS.map((verb) => [verb.id, verb])
)

/**
 * The verbs whose insertion point is COMPUTED by the dispatch surface
 * (issue #31) rather than read from the cursor/selection. They are also the
 * only actions the editor context menu offers WITHOUT a selection: their
 * gesture is "act on where I am", not "act on what I marked".
 */
export const PLACEMENT_VERB_IDS: ReadonlySet<string> = new Set(['expand-section', 'continue-note'])

/**
 * Resolves a built-in verb by action id. Returns null for unknown ids —
 * including custom-action UUIDs, which carry their own instruction and are
 * not registry entries.
 */
export function getBuiltInVerb(actionId: string): BuiltInVerb | null {
    return VERBS_BY_ID.get(actionId) ?? null
}

/**
 * The single entry point every dispatch path uses to turn an action id into
 * the verb it runs: the registry entry for a built-in id, otherwise the
 * custom action's own verb. Returns null when neither applies — an unknown id
 * with no custom verb supplied, or a custom verb whose resolved instruction is
 * blank (a directive that says nothing cannot be dispatched).
 *
 * Built-ins win over a supplied custom verb: a persisted binding must never be
 * able to redefine what "Humanize" does behind the shared label.
 */
export function resolveActionVerb(actionId: string, custom?: ActionVerb): ActionVerb | null {
    const builtIn = getBuiltInVerb(actionId)
    if (builtIn) {
        return builtIn
    }
    if (custom && custom.instruction.trim().length > 0) {
        return custom
    }
    return null
}

const VERB_CLASS_LABELS: Record<VerbClass, string> = {
    transform: 'Rewrite the selection',
    generate: 'Write more at the cursor',
    review: 'Report findings'
}

/** Sentence-case label for a verb class (settings dropdown, notices). */
export function verbClassLabel(verbClass: VerbClass): string {
    return VERB_CLASS_LABELS[verbClass]
}
