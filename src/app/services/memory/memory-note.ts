import { stripFrontmatterBlock } from '../../domain/frontmatter'
import { MEMORY_TEXT_MAX } from '../../domain/operations/contract'

/**
 * Body replacement for a memory NOTE (issue #4): a distilled memory replaces
 * the note's body wholesale — replacement is the rotation/cap mechanism —
 * while a leading frontmatter block is preserved verbatim (the note may carry
 * user metadata, an `ai_editor` flag, tags…). Pure; the Obsidian write seam
 * (`Vault.process` / `Vault.create`) lives at the call site.
 */
export function replaceMemoryBody(existing: string, newMemory: string): string {
    const body = newMemory.length === 0 || newMemory.endsWith('\n') ? newMemory : `${newMemory}\n`
    const { removedChars } = stripFrontmatterBlock(existing)
    if (removedChars === 0) {
        return body
    }
    // A frontmatter-only note without a final newline strips up to the last
    // `-` of the closing fence (end-of-input counts as its terminator).
    // Joining the body directly would glue it onto the fence line —
    // `---Body` — breaking the frontmatter for Obsidian AND for the next
    // strip, which would then erase the user's metadata wholesale.
    const head = existing.slice(0, removedChars)
    return head.endsWith('\n') ? `${head}${body}` : `${head}\n${body}`
}

/**
 * Canonical normalization of a user-typed memory note path: trims stray
 * whitespace (the settings field stores free text verbatim), folds
 * backslashes to `/` (vault paths are slash-separated on every OS), and
 * appends `.md` when the extension is missing — the vault reader is
 * markdown-only, so an extension-less path would WRITE a file the read half
 * never reads (memory silently absent from every run). Every consumer of
 * `editor.memoryNotePath` — the distiller's gate/read, the note write, and
 * context assembly — goes through this one function, so the write and read
 * sides can never disagree about which note holds the memory.
 *
 * Traversal is REFUSED rather than normalized away (the
 * `normalizeExportPath` precedent, AGENTS.md "do not access files outside
 * the vault"): `Vault.create`/`Vault.createFolder` join the path onto the
 * vault's base path and the adapter resolves `..`, so `../outside` would
 * read from and write to a file OUTSIDE the vault. Absolute paths (leading
 * slash, Windows drive letter) and `.`/`..`/empty segments all return `''`
 * — the same "no usable path" value callers already refuse on.
 */
export function normalizeMemoryNotePath(raw: string): string {
    const path = raw.trim().replace(/\\/g, '/')
    if (path.length === 0) {
        return ''
    }
    if (path.startsWith('/') || /^[A-Za-z]:/.test(path)) {
        return ''
    }
    const segments = path.split('/')
    if (
        segments.some(
            (segment) => segment.trim().length === 0 || segment === '.' || segment === '..'
        )
    ) {
        return ''
    }
    return path.toLowerCase().endsWith('.md') ? path : `${path}.md`
}

/**
 * Clips a memory to the contract ceiling (`MEMORY_TEXT_MAX`). Shared by the
 * distiller's read and the save path's conflict re-read so both derive the
 * same value from the same source.
 */
export function clipMemory(text: string): string {
    return text.length > MEMORY_TEXT_MAX ? text.slice(0, MEMORY_TEXT_MAX) : text
}

/**
 * Derives the CURRENT memory from a memory note's raw content: `null`
 * (missing note) reads as empty — the first distillation starts from
 * nothing — otherwise the body with the frontmatter stripped, clipped to
 * the contract ceiling. One function, used by the distiller (what the
 * request sends as `currentMemory`) AND the save path's conflict re-read
 * (what a save would overwrite) — the two must never derive differently, or
 * the conflict gate would misfire.
 */
export function deriveNoteMemory(content: string | null): string {
    return content === null ? '' : clipMemory(stripFrontmatterBlock(content).text)
}
