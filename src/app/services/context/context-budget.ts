/**
 * The context budget: what gets sent, in which order, and what the character
 * budget does to the parts that do not fit.
 *
 * This module owns the ORDER and the ARITHMETIC; `context-assembler.ts` owns
 * the collection of candidates. Splitting them keeps the whole budget policy
 * pure and spec-pinnable without a vault, and gives the "what will be sent"
 * preview exactly one place to read the policy from — a preview that
 * re-derived truncation would eventually disagree with what is sent, which is
 * the one failure mode a trust surface may not have.
 *
 * ## Priority order (decided 2026-07-30, plan M5)
 *
 * Sent in this order; when the budget bites, the LAST sections lose first:
 *
 * 1. `system-prompt` — voice-profile text + persona text + memory text, as one
 *    string. **Never truncated**: it is the editor's identity, and half a
 *    persona silently produces a different editor.
 * 2. `reviewed-note` — the note under review. **Never truncated**: findings
 *    must quote the submitted snapshot verbatim and anchors resolve against
 *    it (Business Rules #3/#4), so a trimmed note would make anchoring lie.
 *    The assembler cannot trim it anyway — the note text travels in the
 *    operation payload (`operation.text`), not in the system prompt; the
 *    budget only ACCOUNTS for it.
 * 3. Attachments, in assembly order, which is also their budget priority:
 *    `prompt-ref` → `wikilink-ref` → `followed-link` → `linked-note`.
 *
 * Because the first two are never truncated, the ordered, truncatable region
 * is exactly the attachment list — so ONE list serves as both the send order
 * and the priority order. That coupling is deliberate: two orders would let
 * the preview show notes in an order that does not explain which of them got
 * dropped, and explaining that is the point of the preview.
 *
 * Within `prompt-ref`, voice-profile notes precede persona notes (mirroring
 * the text order of the system prompt, `assembleContext`'s documented
 * invariant). So the global voice profile outranks a persona's own reference
 * notes. Considered and rejected: hoisting persona refs above the voice
 * profile because "the persona IS the editor". The persona's TEXT is never
 * truncated at all, and the voice profile is one small, globally-configured
 * note set, while persona refs are per-editor and typically the larger, more
 * numerous group — dropping the persona's fifth reference note before the
 * single voice-profile note is the better failure. Anyone who disagrees can
 * express it: turn `injectVoiceProfile` off for that editor.
 *
 * When the never-truncated sections alone exceed the budget, every attachment
 * is dropped and the overflow is REPORTED (`overBudgetChars`) rather than
 * silently absorbed — the run still goes out, because refusing to review a
 * long note would be worse, but the preview says so plainly.
 */

/** Why a note is attached; drives labeling, ordering, and budget priority. */
export type AttachmentReason = 'prompt-ref' | 'wikilink-ref' | 'followed-link' | 'linked-note'

/**
 * Attachment reasons in priority order — the order `assembleContext` collects
 * them in, and therefore the order the budget spends on them. Exported so the
 * assembler's ordering can be spec-pinned against the policy instead of
 * against a hand-written list in a test.
 */
export const ATTACHMENT_PRIORITY: readonly AttachmentReason[] = [
    'prompt-ref',
    'wikilink-ref',
    'followed-link',
    'linked-note'
]

/** What a context section is. */
export type ContextSectionKind = 'system-prompt' | 'reviewed-note' | AttachmentReason

/** What the budget did to a section. */
export type ContextSectionStatus = 'sent' | 'truncated' | 'dropped'

/** One section of what will be sent, in send order. */
export interface ContextSection {
    readonly kind: ContextSectionKind
    /** Sentence-case label for the preview. */
    readonly label: string
    /** Vault path for attachment sections; `null` for the two fixed ones. */
    readonly path: string | null
    /** Characters the source actually holds. */
    readonly sourceChars: number
    /** Characters that will be sent (`0` when dropped). */
    readonly sentChars: number
    readonly status: ContextSectionStatus
}

/** Budget outcome for the whole assembly, as shown in the preview. */
export interface ContextBudgetReport {
    /** `behavior.contextBudgetChars` at assembly time. */
    readonly budgetChars: number
    /** Sum of every section's `sentChars`. */
    readonly totalChars: number
    /**
     * By how much the never-truncated sections (system prompt + reviewed note)
     * alone exceed the budget; `0` when they fit. Non-zero means every
     * attachment was dropped AND the request is still over budget.
     */
    readonly overBudgetChars: number
    /** Paths sent partially, in send order. */
    readonly truncatedPaths: readonly string[]
    /** Paths not sent at all because the budget was exhausted, in send order. */
    readonly droppedPaths: readonly string[]
}

/** Human label for a section kind (sentence case, UI-ready). */
export function sectionKindLabel(kind: ContextSectionKind): string {
    switch (kind) {
        case 'system-prompt':
            return 'System prompt'
        case 'reviewed-note':
            return 'Reviewed note'
        case 'prompt-ref':
            return 'Prompt note'
        case 'wikilink-ref':
            return 'Wikilinked note'
        case 'followed-link':
            return 'Linked from a prompt note'
        case 'linked-note':
            return 'Linked from the reviewed note'
    }
}

/** Human label for a budget status (sentence case, UI-ready). */
export function sectionStatusLabel(status: ContextSectionStatus): string {
    switch (status) {
        case 'sent':
            return 'Sent in full'
        case 'truncated':
            return 'Truncated to fit the budget'
        case 'dropped':
            return 'Dropped — budget exhausted'
    }
}

/** How the budget treats one attachment. */
export interface AttachmentAllocation {
    /** Characters to send: the full length, a prefix, or `0`. */
    readonly sentChars: number
    readonly status: ContextSectionStatus
}

export interface AllocateAttachmentsInput {
    /** `behavior.contextBudgetChars`. */
    readonly budgetChars: number
    /** Characters the never-truncated sections consume. */
    readonly fixedChars: number
    /** Source lengths of the attachments, in send order. */
    readonly attachmentChars: readonly number[]
}

export interface AllocateAttachmentsResult {
    /** One entry per input attachment, same order. */
    readonly allocations: readonly AttachmentAllocation[]
    /** See `ContextBudgetReport.overBudgetChars`. */
    readonly overBudgetChars: number
}

/**
 * Spends the budget left over by the never-truncated sections on the
 * attachments, in order: each one is sent in full while it fits, the first
 * one that does not fit is truncated to the exact remainder, and everything
 * after it is dropped.
 *
 * A zero remainder truncates nothing — an attachment allocated 0 characters
 * is `dropped`, not `truncated`: "truncated" promises that a prefix arrives,
 * and an empty prefix is no content at all. Callers use the distinction to
 * report honestly, so it must not blur here.
 */
export function allocateAttachments(input: AllocateAttachmentsInput): AllocateAttachmentsResult {
    const { budgetChars, fixedChars, attachmentChars } = input
    const overBudgetChars = Math.max(0, fixedChars - budgetChars)
    let remaining = Math.max(0, budgetChars - fixedChars)
    const allocations: AttachmentAllocation[] = []
    for (const chars of attachmentChars) {
        if (remaining <= 0) {
            allocations.push({ sentChars: 0, status: 'dropped' })
            continue
        }
        if (chars > remaining) {
            allocations.push({ sentChars: remaining, status: 'truncated' })
            remaining = 0
            continue
        }
        allocations.push({ sentChars: chars, status: 'sent' })
        remaining -= chars
    }
    return { allocations, overBudgetChars }
}

/**
 * Rolls a section list into the report the preview shows. Derived, never
 * stored twice: totals and the truncated/dropped path lists are always
 * consistent with the sections they summarize.
 */
export function summarizeBudget(
    sections: readonly ContextSection[],
    budgetChars: number,
    overBudgetChars: number
): ContextBudgetReport {
    let totalChars = 0
    const truncatedPaths: string[] = []
    const droppedPaths: string[] = []
    for (const section of sections) {
        totalChars += section.sentChars
        if (section.path === null) {
            continue
        }
        if (section.status === 'truncated') {
            truncatedPaths.push(section.path)
        } else if (section.status === 'dropped') {
            droppedPaths.push(section.path)
        }
    }
    return { budgetChars, totalChars, overBudgetChars, truncatedPaths, droppedPaths }
}
