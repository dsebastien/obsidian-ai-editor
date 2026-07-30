import { accessSync, constants, statSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ExecutableProbe } from './executable'

/**
 * The filesystem half of the CLI boundary's Node glue: the executable probe
 * and the throwaway working directory. Everything here is a thin adapter over
 * `node:fs` — the decisions live in `executable.ts` and `spawn.ts`.
 *
 * Node access is legitimate in this folder and only in this folder. The plugin
 * is `isDesktopOnly: true` (Business Rules #5), so the renderer is an Electron
 * one with Node available; the build already marks `node:*` external. Keeping
 * the imports in two files (`node-fs.ts`, `node-process.ts`) means the rest of
 * the codebase stays runtime-agnostic and a reviewer can see the entire Node
 * surface the plugin uses by reading them.
 */

/** Reads the real filesystem, following symlinks (see `ExecutableProbe`). */
export const nodeExecutableProbe: ExecutableProbe = {
    statFile(path: string): { readonly isFile: boolean } | null {
        try {
            return { isFile: statSync(path).isFile() }
        } catch {
            return null
        }
    },
    isExecutable(path: string): boolean {
        try {
            accessSync(path, constants.X_OK)
            return true
        } catch {
            return false
        }
    }
}

/**
 * A working directory that exists for exactly one process and is removed
 * afterwards.
 */
export interface RunDirHandle {
    readonly path: string
    /** Removes the directory and everything the child left in it. */
    dispose(): Promise<void>
}

export type CreateRunDir = () => Promise<RunDirHandle>

/**
 * Creates the per-run directory in the OS temp location.
 *
 * Deliberately NOT the vault, and deliberately not the plugin's own data
 * folder either: `.obsidian/plugins/ai-editor/` lives inside the vault, so
 * anything an agent writes there is a file the user's sync engine replicates
 * and their vault search finds. A CLI agent that decides to scribble a
 * scratch file has to land it somewhere that is neither of those, and it has
 * to disappear when the run does.
 *
 * `mkdtemp` gives owner-only permissions (0700) and a name no other process
 * can predict, which also keeps two concurrent runs from seeing each other's
 * files.
 */
export const createTempRunDir: CreateRunDir = async () => {
    const path = await mkdtemp(join(tmpdir(), 'obsidian-ai-editor-'))
    return {
        path,
        dispose: async (): Promise<void> => {
            // `force` so a run whose directory was already cleaned up (or
            // never fully created) does not turn teardown into a failure.
            await rm(path, { recursive: true, force: true })
        }
    }
}
