import type {
    BehaviorSettings,
    EditorConfig,
    PromptSource
} from '../../domain/settings/settings-schema'
import { stripFrontmatterBlock } from '../../domain/frontmatter'
import {
    allocateAttachments,
    sectionKindLabel,
    summarizeBudget,
    type AttachmentReason,
    type ContextBudgetReport,
    type ContextSection
} from './context-budget'
import { isExcluded } from './exclusions'
import type { VaultReader } from './vault-reader.intf'
import { extractWikilinks } from './wikilinks'

/**
 * Per-run context assembly for one editor persona.
 *
 * Builds the effective system prompt from direct text fields and collects
 * every vault note that rides along as a context attachment, in a fixed,
 * deterministic order, under the global character budget, with privacy
 * exclusions enforced BEFORE any note content is read (Business Rules #7)
 * and every section accounted for in a send-preview (review major #8/#14).
 *
 * The budget POLICY — send order, priority, truncation arithmetic, labels —
 * lives in `context-budget.ts`; this module collects candidates and applies
 * it. `sections` + `budget` are what the "what will be sent" preview renders,
 * and they describe exactly the request this assembly produces.
 */

export type { AttachmentReason } from './context-budget'

/**
 * Upper bound on followed links attached PER referenced note when a prompt
 * source has `followLinks` on (plan §0 "Live-testing feedback #2"): depth 1,
 * deterministic link order, stop at the cap.
 */
export const FOLLOWED_LINKS_CAP = 20

export interface ContextAttachment {
    readonly path: string
    /** Note content, possibly truncated to fit the budget (see `sections`). */
    readonly content: string
    readonly reason: AttachmentReason
}

export interface AssembledContext {
    /**
     * Direct text fields concatenated in order: voice profile text (when
     * injected) → persona prompt text → memory text. Note contents never
     * land here — they travel as attachments so budgeting, truncation, and
     * the preview stay per-note.
     */
    readonly systemPrompt: string
    /**
     * Notes to send, in assembly order, deduplicated, budget-enforced.
     * Dropped notes are absent here and reported in `sections`.
     */
    readonly attachments: ContextAttachment[]
    /**
     * Everything this assembly accounts for, in send order: the system
     * prompt, the reviewed note, then every attachment CANDIDATE — including
     * the ones the budget dropped, which is the whole point of reporting
     * sections instead of just listing what survived.
     */
    readonly sections: readonly ContextSection[]
    /** Totals and what the budget cost, derived from `sections`. */
    readonly budget: ContextBudgetReport
}

export interface AssembleContextInput {
    readonly editor: EditorConfig
    /** Global voice profile; injected unless the editor opts out. */
    readonly voiceProfile: PromptSource
    readonly behavior: BehaviorSettings
    readonly vault: VaultReader
    /** Vault-relative path of the note under review (never attached itself). */
    readonly notePath: string
    /** Text of the note under review; counts against the context budget. */
    readonly noteText: string
}

interface Candidate {
    readonly path: string
    readonly reason: AttachmentReason
}

/**
 * Thrown by `assembleContext` when the review target itself is excluded.
 * Business Rules #7 covers the target explicitly ("not as the review
 * target"); making the choke point every run passes through enforce it keeps
 * the guarantee structural instead of depending on each call site
 * remembering a pre-check. Callers surface this as "note is excluded", never
 * as a generic failure.
 */
export class ExcludedTargetError extends Error {
    readonly notePath: string

    constructor(notePath: string) {
        super(`Note is excluded from AI processing: ${notePath}`)
        this.name = 'ExcludedTargetError'
        this.notePath = notePath
    }
}

/**
 * Assembles the system prompt and context attachments for one editor run.
 *
 * Attachment order (deterministic, mirrors the prompt order): voice-profile
 * note refs → persona note refs → memory note (`prompt-ref`), then wikilinks
 * found in the prompt text fields (`wikilink-ref`), then — for each prompt
 * source with `followLinks` on — the notes linked FROM that source's
 * referenced notes, depth 1, in link order, capped at `FOLLOWED_LINKS_CAP`
 * per referenced note (`followed-link`), then outgoing links of the reviewed
 * note when the editor opts in, capped at `maxLinkedNotes` (`linked-note`).
 * Each note is attached at most once, under its first reason; the reviewed
 * note itself is never attached.
 *
 * Excluded notes are dropped from EVERY source before their content is read,
 * and an excluded review TARGET aborts assembly with `ExcludedTargetError`
 * before anything else happens (Business Rules #7 — the target is covered by
 * the rule too). Missing notes and unresolvable wikilinks are skipped
 * silently.
 *
 * Frontmatter: with `behavior.stripFrontmatter` on, the leading frontmatter
 * block is removed from the reviewed note AND from every attachment before
 * either is measured or serialized, so the budget report and the preview
 * describe the reduced request rather than the file on disk.
 *
 * Budget: `behavior.contextBudgetChars` covers system prompt + note text +
 * attachments, spent in the priority order documented in
 * `context-budget.ts` — the system prompt and the reviewed note are never
 * truncated, attachments consume the remainder in order, the first one that
 * does not fit is truncated and later ones are dropped. Every candidate is
 * reported in `sections` with what happened to it, so nothing disappears
 * silently.
 */
export async function assembleContext(input: AssembleContextInput): Promise<AssembledContext> {
    const { editor, voiceProfile, behavior, vault, notePath } = input
    // Privacy control (`behavior.stripFrontmatter`): the reviewed note and
    // every attached note lose their leading frontmatter block before anything
    // measures or sends them. Applied HERE — not at each call site — so the
    // budget `sections` and the "what will be sent" preview report the reduced
    // sizes; a preview that still showed the frontmatter would contradict the
    // setting. The request payload's own copy of the document text is stripped
    // at the executor seam (`backend-executor.ts`), which is the other half of
    // the same guarantee.
    const stripFrontmatter = (text: string): string =>
        behavior.stripFrontmatter ? stripFrontmatterBlock(text).text : text
    const noteText = stripFrontmatter(input.noteText)

    // -- The target itself must not be excluded (Business Rules #7) -----------
    if (isExcluded(notePath, vault.getNoteMetadata(notePath), behavior)) {
        throw new ExcludedTargetError(notePath)
    }

    // -- System prompt: direct text fields, in order --------------------------
    const voiceText = editor.injectVoiceProfile ? voiceProfile.text.trim() : ''
    const personaText = editor.prompt.text.trim()
    const memoryText = editor.memory === 'settings' ? editor.memoryText.trim() : ''
    const systemPrompt = [voiceText, personaText, memoryText]
        .filter((segment) => segment.length > 0)
        .join('\n\n')

    // -- Candidate collection (paths only; content read after eligibility) ----
    const seen = new Set<string>([notePath])
    const candidates: Candidate[] = []

    const eligible = (path: string): boolean => {
        if (seen.has(path)) {
            return false
        }
        seen.add(path)
        return !isExcluded(path, vault.getNoteMetadata(path), behavior)
    }

    const promptRefPaths = [
        ...(editor.injectVoiceProfile ? voiceProfile.notePaths : []),
        ...editor.prompt.notePaths,
        ...(editor.memory === 'note' && editor.memoryNotePath.length > 0
            ? [editor.memoryNotePath]
            : [])
    ]
    for (const path of promptRefPaths) {
        if (eligible(path)) {
            candidates.push({ path, reason: 'prompt-ref' })
        }
    }

    const linkableText = [voiceText, personaText, memoryText].join('\n')
    for (const target of extractWikilinks(linkableText)) {
        const resolved = vault.resolveLink(target, notePath)
        if (resolved !== null && eligible(resolved)) {
            candidates.push({ path: resolved, reason: 'wikilink-ref' })
        }
    }

    // -- Follow links of referenced notes (per-source opt-in, depth 1) --------
    // Roots are the notes each followLinks-enabled source references —
    // notePaths first, then wikilinks in its text — in reference order,
    // deduplicated. Excluded roots are never followed (their links are part
    // of a note the user opted out of AI processing). The memory note is not
    // a prompt source and is never followed.
    const followSources: readonly {
        readonly notePaths: readonly string[]
        readonly text: string
    }[] = [
        ...(editor.injectVoiceProfile && voiceProfile.followLinks
            ? [{ notePaths: voiceProfile.notePaths, text: voiceText }]
            : []),
        ...(editor.prompt.followLinks
            ? [{ notePaths: editor.prompt.notePaths, text: personaText }]
            : [])
    ]
    const rootSeen = new Set<string>()
    const followRoots: string[] = []
    const addRoot = (path: string): void => {
        if (rootSeen.has(path)) {
            return
        }
        rootSeen.add(path)
        if (!isExcluded(path, vault.getNoteMetadata(path), behavior)) {
            followRoots.push(path)
        }
    }
    for (const source of followSources) {
        for (const path of source.notePaths) {
            addRoot(path)
        }
        for (const target of extractWikilinks(source.text)) {
            const resolved = vault.resolveLink(target, notePath)
            if (resolved !== null) {
                addRoot(resolved)
            }
        }
    }
    for (const root of followRoots) {
        let followed = 0
        for (const path of vault.getOutgoingLinks(root)) {
            if (followed >= FOLLOWED_LINKS_CAP) {
                break
            }
            if (eligible(path)) {
                candidates.push({ path, reason: 'followed-link' })
                followed++
            }
        }
    }

    if (editor.includeLinkedNotes) {
        let linked = 0
        for (const path of vault.getOutgoingLinks(notePath)) {
            if (linked >= editor.maxLinkedNotes) {
                break
            }
            if (eligible(path)) {
                candidates.push({ path, reason: 'linked-note' })
                linked++
            }
        }
    }

    // -- Read content, then apply the budget policy ---------------------------
    // Reading happens for every candidate, including ones the budget will
    // drop: the preview reports how big a dropped note WAS, which is the
    // number that tells the user whether to raise the budget or cut a
    // reference. A note that cannot be read at all never becomes a section.
    const readable: {
        readonly path: string
        readonly reason: AttachmentReason
        content: string
    }[] = []
    for (const candidate of candidates) {
        const content = await vault.readNote(candidate.path)
        if (content === null) {
            continue
        }
        // An attached note is treated exactly like the reviewed one: the
        // setting is about what leaves the vault, not about which note it
        // came from.
        readable.push({
            path: candidate.path,
            reason: candidate.reason,
            content: stripFrontmatter(content)
        })
    }

    const budgetChars = behavior.contextBudgetChars
    const fixedChars = systemPrompt.length + noteText.length
    const { allocations, overBudgetChars } = allocateAttachments({
        budgetChars,
        fixedChars,
        attachmentChars: readable.map((entry) => entry.content.length)
    })

    const attachments: ContextAttachment[] = []
    const sections: ContextSection[] = [
        {
            kind: 'system-prompt',
            label: sectionKindLabel('system-prompt'),
            path: null,
            sourceChars: systemPrompt.length,
            sentChars: systemPrompt.length,
            status: 'sent'
        },
        {
            kind: 'reviewed-note',
            label: sectionKindLabel('reviewed-note'),
            path: notePath,
            sourceChars: noteText.length,
            sentChars: noteText.length,
            status: 'sent'
        }
    ]
    readable.forEach((entry, index) => {
        // `allocateAttachments` returns one allocation per input, same order.
        const allocation = allocations[index] ?? { sentChars: 0, status: 'dropped' as const }
        if (allocation.status !== 'dropped') {
            attachments.push({
                path: entry.path,
                content:
                    allocation.sentChars === entry.content.length
                        ? entry.content
                        : entry.content.slice(0, allocation.sentChars),
                reason: entry.reason
            })
        }
        sections.push({
            kind: entry.reason,
            label: sectionKindLabel(entry.reason),
            path: entry.path,
            sourceChars: entry.content.length,
            sentChars: allocation.sentChars,
            status: allocation.status
        })
    })

    return {
        systemPrompt,
        attachments,
        sections,
        budget: summarizeBudget(sections, budgetChars, overBudgetChars)
    }
}
