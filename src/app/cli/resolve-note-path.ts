import { normalizePath } from 'obsidian'
import type { App } from 'obsidian'

/**
 * Shared `--file` resolution for every `editor-ai-daemons:*` CLI subcommand: accepts
 * a vault-relative path (with or without `.md`) or plain link text, markdown
 * notes only — same tolerance as wikilink resolution, so `--file "My Note"`
 * works like `[[My Note]]`. One implementation on purpose: review, cancel,
 * and status must agree on which note a given `--file` value denotes.
 */
export function createNoteResolver(app: App): (file: string) => string | null {
    return (file: string): string | null => {
        const normalized = normalizePath(file)
        const vault = app.vault
        const byPath = vault.getFileByPath(normalized) ?? vault.getFileByPath(`${normalized}.md`)
        const resolved = byPath ?? app.metadataCache.getFirstLinkpathDest(normalized, '')
        return resolved !== null && resolved.extension === 'md' ? resolved.path : null
    }
}
