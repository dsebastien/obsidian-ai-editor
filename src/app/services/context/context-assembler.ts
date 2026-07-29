import type {
    BehaviorSettings,
    EditorConfig,
    PromptSource
} from '../../domain/settings/settings-schema'
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
 * and every attachment accounted for in a send-preview (review major #8/#14).
 */

/** Why a note was attached; drives preview labeling and ordering. */
export type AttachmentReason = 'prompt-ref' | 'wikilink-ref' | 'followed-link' | 'linked-note'

/**
 * Upper bound on followed links attached PER referenced note when a prompt
 * source has `followLinks` on (plan §0 "Live-testing feedback #2"): depth 1,
 * deterministic link order, stop at the cap.
 */
export const FOLLOWED_LINKS_CAP = 20

export interface ContextAttachment {
    readonly path: string
    /** Note content, possibly truncated to fit the budget (see `truncated`). */
    readonly content: string
    readonly reason: AttachmentReason
}

/** One row of the "what will be sent" preview. */
export interface AttachmentPreview {
    readonly path: string
    /** Characters actually sent (post-truncation). */
    readonly chars: number
    readonly reason: string
}

export interface AssembledContext {
    /**
     * Direct text fields concatenated in order: voice profile text (when
     * injected) → persona prompt text → memory text. Note contents never
     * land here — they travel as attachments so budgeting, truncation, and
     * the preview stay per-note.
     */
    readonly systemPrompt: string
    /** Notes to send, in assembly order, deduplicated, budget-enforced. */
    readonly attachments: ContextAttachment[]
    /** Every attachment that will be sent, for user review before the run. */
    readonly preview: AttachmentPreview[]
    /**
     * Paths that hit the budget: truncated mid-content or dropped entirely
     * (dropped notes appear here but not in `attachments`/`preview`).
     */
    readonly truncated: string[]
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
 * Budget: `behavior.contextBudgetChars` covers system prompt + note text +
 * attachments. Attachments consume the remainder in order; the first one
 * that does not fit is truncated (recorded in `truncated`), later ones are
 * dropped (also recorded). The system prompt and the reviewed note are user
 * intent and are never truncated themselves.
 */
export async function assembleContext(input: AssembleContextInput): Promise<AssembledContext> {
    const { editor, voiceProfile, behavior, vault, notePath, noteText } = input

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
    const followSources: readonly { readonly notePaths: readonly string[]; readonly text: string }[] =
        [
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

    // -- Read content, enforce the budget in order ----------------------------
    const attachments: ContextAttachment[] = []
    const truncated: string[] = []
    let remaining = Math.max(0, behavior.contextBudgetChars - systemPrompt.length - noteText.length)

    for (const candidate of candidates) {
        const content = await vault.readNote(candidate.path)
        if (content === null) {
            continue
        }
        if (remaining <= 0) {
            truncated.push(candidate.path)
            continue
        }
        if (content.length > remaining) {
            attachments.push({
                path: candidate.path,
                content: content.slice(0, remaining),
                reason: candidate.reason
            })
            truncated.push(candidate.path)
            remaining = 0
            continue
        }
        attachments.push({ path: candidate.path, content, reason: candidate.reason })
        remaining -= content.length
    }

    const preview: AttachmentPreview[] = attachments.map((attachment) => ({
        path: attachment.path,
        chars: attachment.content.length,
        reason: attachment.reason
    }))

    return { systemPrompt, attachments, preview, truncated }
}
