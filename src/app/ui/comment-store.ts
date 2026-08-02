import { Notice, normalizePath } from 'obsidian'
import type { Plugin } from 'obsidian'
import {
    commentStorePathIn,
    MarginCommentRepository
} from '../services/comments/comment-repository'
import type { CommentStorageAdapter } from '../services/comments/comment-repository'
import type { CommentJobRegistry } from '../services/comments/comment-job-registry'
import { log } from '../../utils/log'

/**
 * Obsidian glue for the durable margin-comment store (plan §5.5 / M8).
 *
 * Thin by construction: the adapter forwards five calls to `Vault.adapter`,
 * and the hooks forward two vault events. Every rule about WHERE the store
 * lives, WHEN it is written and WHAT happens to a corrupt one is in
 * `services/comments/comment-repository.ts`, where it is spec-covered without
 * a vault.
 */

/**
 * `CommentStorageAdapter` over the vault's own file adapter. Exported for the
 * history sidecar (issue #21), which persists with the same five calls.
 */
export class VaultCommentStorage implements CommentStorageAdapter {
    constructor(private readonly plugin: Plugin) {}

    async read(path: string): Promise<string | null> {
        const adapter = this.plugin.app.vault.adapter
        if (!(await adapter.exists(path))) {
            return null
        }
        return adapter.read(path)
    }

    async write(path: string, data: string): Promise<void> {
        await this.plugin.app.vault.adapter.write(path, data)
    }

    exists(path: string): Promise<boolean> {
        return this.plugin.app.vault.adapter.exists(path)
    }

    async rename(from: string, to: string): Promise<void> {
        await this.plugin.app.vault.adapter.rename(from, to)
    }

    async remove(path: string): Promise<void> {
        await this.plugin.app.vault.adapter.remove(path)
    }
}

/**
 * The plugin's own data folder. `manifest.dir` is what Obsidian itself uses;
 * the fallback composes the same path from `Vault.configDir` (never a
 * hardcoded `.obsidian` — the config folder is user-configurable).
 */
export function pluginDataDir(plugin: Plugin): string {
    const dir = plugin.manifest.dir
    if (typeof dir === 'string' && dir.length > 0) {
        return dir
    }
    return `${plugin.app.vault.configDir}/plugins/${plugin.manifest.id}`
}

/** Builds the repository bound to this plugin instance's data folder. */
export function createCommentRepository(plugin: Plugin): MarginCommentRepository {
    return new MarginCommentRepository({
        storage: new VaultCommentStorage(plugin),
        storePath: normalizePath(commentStorePathIn(pluginDataDir(plugin))),
        // Timers per AGENTS.md: `window.*`, declared as plain numbers.
        setTimer: (callback, ms) => window.setTimeout(callback, ms),
        clearTimer: (handle) => {
            window.clearTimeout(handle)
        },
        onWriteError: (message) => log(`Could not save margin comments: ${message}`, 'error'),
        // The log is not a user surface: a user whose parked questions have
        // stopped being saved has to be told before they quit.
        onWriteStalled: (failures, message) => {
            log(`Margin comments have failed to save ${failures} times: ${message}`, 'error')
            new Notice(
                `AI Editor: margin comments could not be saved (${failures} attempts). Check that the vault is writable — the comments are kept in memory meanwhile.`
            )
        },
        onExternalChange: (adopted, backupPath) => {
            const kept =
                backupPath === null ? '' : ` The file that was there was kept at ${backupPath}.`
            log(`Margin comment store changed elsewhere; adopted ${adopted} comments`, 'warn')
            if (adopted > 0 || backupPath !== null) {
                new Notice(
                    `AI Editor: the margin comment store was changed by another device (likely a sync) and the two were merged.${kept}`
                )
            }
        }
    })
}

/**
 * Keeps the store keyed correctly as the vault moves underneath it.
 *
 * Deliberately NOT guarded on `TFile`: a FOLDER rename or delete must move or
 * drop every comment under it, and Obsidian does not necessarily emit a
 * per-child event. The repository handles both the exact path and the folder
 * prefix, and doing both is idempotent — so this glue never has to know which
 * shape the vault chose to report.
 *
 * `getRegistry` is a GETTER, not a registry: the store loads before the job
 * registry is built (the registry is built over it), and a delete has to
 * cancel the note's in-flight runs before the record goes — otherwise the
 * request runs to completion holding a permit, and its answer lands on a
 * comment nothing tracks.
 */
export function registerCommentStoreHooks(
    plugin: Plugin,
    repository: MarginCommentRepository,
    getRegistry?: () => CommentJobRegistry | null
): void {
    plugin.registerEvent(
        plugin.app.vault.on('rename', (file, oldPath) => {
            const registry = getRegistry?.() ?? null
            const dropped =
                registry === null
                    ? repository.noteRenamed(oldPath, file.path)
                    : registry.noteRenamed(oldPath, file.path)
            if (dropped > 0) {
                // Business Rules #13: a comment is never dropped silently.
                new Notice(
                    `AI Editor: ${dropped} margin ${dropped === 1 ? 'comment' : 'comments'} could not be moved to ${file.path} — it is already at the comment limit.`
                )
            }
        })
    )
    plugin.registerEvent(
        plugin.app.vault.on('delete', (file) => {
            const registry = getRegistry?.() ?? null
            if (registry === null) {
                repository.noteDeleted(file.path)
                return
            }
            registry.noteDeleted(file.path)
        })
    )
}
