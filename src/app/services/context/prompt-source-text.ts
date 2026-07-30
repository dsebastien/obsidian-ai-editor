import type { BehaviorSettings, PromptSource } from '../../domain/settings/settings-schema'
import { FOLLOWED_LINKS_CAP } from './context-assembler'
import { isExcluded } from './exclusions'
import type { VaultReader } from './vault-reader.intf'

/**
 * Resolution of a `PromptSource` into ONE string, for the prompt fields that
 * are not the editor persona: a custom action's instruction and a panel's
 * charter.
 *
 * Why it is shared rather than duplicated per field: `PromptSource` carries
 * the vault-as-configuration guarantee (Business Rules #8) plus the privacy
 * guarantee (#7), and both are easy to get subtly wrong — resolve fresh at
 * dispatch time, never read an excluded note, never FOLLOW into an excluded
 * note, inline each note at most once, cap the followed links, cap the total.
 * Two implementations of that is one implementation too many.
 *
 * The persona/voice-profile path is deliberately NOT routed here: it produces
 * budgeted `ContextAttachment`s (`assembleContext`), which is a different
 * output shape with a different failure mode (dropped sections get reported).
 * These fields are small, mandatory directives — they are truncated, not
 * budgeted.
 */

export interface ResolvePromptSourceOptions {
    /**
     * XML-style tag wrapping each inlined note (`instruction-note`,
     * `charter-note`). Consistent with the attachment serialization in
     * `composeSystemPrompt` — fences would break on markdown content.
     */
    readonly blockTag: string
    /**
     * Hard cap on the resolved string. The direct text is emitted FIRST
     * precisely so this can only ever cut reference material, never the
     * directive itself.
     */
    readonly maxChars: number
}

/**
 * Resolves a prompt source to its final text: the direct text first, then
 * each referenced note inlined as a delimited block, read fresh from the
 * vault at call time (Business Rules #8).
 *
 * With `followLinks` on, the notes each referenced note links to follow it —
 * depth 1, embeds included, in link order, capped at `FOLLOWED_LINKS_CAP` per
 * referenced note, exactly like context assembly (`assembleContext`), so one
 * toggle means one thing plugin-wide.
 *
 * Excluded notes are never read and never followed (Business Rules #7);
 * missing notes are skipped silently; every note is inlined at most once.
 * The result is truncated to `options.maxChars`.
 */
export async function resolvePromptSourceText(
    source: PromptSource,
    vault: VaultReader,
    behavior: BehaviorSettings,
    options: ResolvePromptSourceOptions
): Promise<string> {
    const seen = new Set<string>()
    const eligible = (path: string): boolean => {
        if (seen.has(path)) {
            return false
        }
        seen.add(path)
        return !isExcluded(path, vault.getNoteMetadata(path), behavior)
    }

    // Candidate paths first (exclusions decided before any content is read),
    // each referenced note immediately followed by its own links.
    const paths: string[] = []
    for (const path of source.notePaths) {
        if (!eligible(path)) {
            continue
        }
        paths.push(path)
        if (!source.followLinks) {
            continue
        }
        let followed = 0
        for (const linked of vault.getOutgoingLinks(path)) {
            if (followed >= FOLLOWED_LINKS_CAP) {
                break
            }
            if (!eligible(linked)) {
                continue
            }
            paths.push(linked)
            followed++
        }
    }

    const segments: string[] = []
    const text = source.text.trim()
    if (text.length > 0) {
        segments.push(text)
    }
    for (const path of paths) {
        const content = await vault.readNote(path)
        if (content === null) {
            continue
        }
        const safePath = path.replace(/"/g, "'")
        segments.push(
            `<${options.blockTag} path="${safePath}">\n${content}\n</${options.blockTag}>`
        )
    }
    const joined = segments.join('\n\n')
    return joined.length > options.maxChars ? joined.slice(0, options.maxChars) : joined
}
