import type { CliPlatform } from './platform'

/**
 * The gate every CLI backend passes before a process is created: WHICH binary
 * are we about to run, and are we sure?
 *
 * The rule is that the answer must come from the user's explicit
 * configuration and from nowhere else. `CliBackend.executablePath` is
 * validated here as an absolute path to an existing, executable regular file,
 * and the spawn call passes that path verbatim. Nothing in this folder ever
 * hands a bare command name to the OS.
 *
 * Why the absolute-path rule is a security rule and not a nicety:
 *
 * - A bare name (`claude`) would be resolved through `PATH`. The child's PATH
 *   is inherited from the Obsidian process, which on a desktop is assembled
 *   from shell profiles, package managers, and anything an installer appended
 *   to it. A writable directory anywhere ahead of the real one turns "review
 *   this note" into "run whatever is called `claude` today" — classic PATH
 *   hijacking, and the user would see no difference.
 * - A relative path (`./claude`, `bin/claude`) would be resolved against the
 *   working directory. The boundary deliberately runs each process in a fresh
 *   throwaway directory, so a relative path either resolves to nothing or,
 *   worse, to something a previous run dropped there.
 *
 * The child still gets a `PATH` for its own sub-tool resolution (see
 * `env.ts`); that is a separate, documented decision. It is never used to
 * decide what WE launch.
 *
 * Pure core + a narrow filesystem probe: the decision logic is spec-covered
 * without touching the disk, and the Node glue is three lines.
 */

export type ExecutableProblem =
    | 'empty'
    | 'not-absolute'
    | 'invalid-characters'
    | 'not-found'
    | 'not-a-file'
    | 'not-executable'
    | 'needs-interpreter'

export type ExecutableValidation =
    | { readonly ok: true; readonly path: string }
    | { readonly ok: false; readonly code: ExecutableProblem; readonly message: string }

/**
 * The filesystem questions the check asks. Injected so the decision table is
 * testable without laying out fixture binaries on disk, and so a spec can
 * describe a file that exists but is not executable — a state that is awkward
 * to create portably.
 */
export interface ExecutableProbe {
    /**
     * Stats the path with symlinks FOLLOWED (a symlink to a real binary is a
     * normal installation shape). Returns null when nothing is there.
     */
    statFile(path: string): { readonly isFile: boolean } | null
    /** Whether the current user may execute the path. */
    isExecutable(path: string): boolean
}

/**
 * Windows executables the boundary refuses. `.bat`/`.cmd` are not programs:
 * running one means running `cmd.exe /c`, which re-introduces the command-line
 * quoting rules this boundary exists to avoid — and Node itself refuses to
 * spawn them without `shell: true` for exactly that reason (CVE-2024-27980).
 * `.ps1` needs PowerShell for the same reason. Refusing them by name gives the
 * user a sentence they can act on instead of an opaque EINVAL.
 */
const WINDOWS_INTERPRETED_EXTENSIONS = ['.bat', '.cmd', '.ps1', '.vbs', '.js', '.wsf'] as const

/** Absolute-path test, per platform, without depending on the host's `path`. */
export function isAbsoluteExecutablePath(platform: CliPlatform, value: string): boolean {
    if (platform === 'win32') {
        // Drive-qualified (C:\tool.exe, C:/tool.exe) or UNC (\\host\share\...).
        return /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\\\')
    }
    return value.startsWith('/')
}

function lowercaseExtension(value: string): string {
    const lastDot = value.lastIndexOf('.')
    const lastSeparator = Math.max(value.lastIndexOf('/'), value.lastIndexOf('\\'))
    if (lastDot <= lastSeparator) {
        return ''
    }
    return value.slice(lastDot).toLowerCase()
}

export interface ValidateExecutableInput {
    readonly platform: CliPlatform
    readonly path: string
    readonly probe: ExecutableProbe
}

/**
 * Decides whether a configured executable path may be spawned.
 *
 * Order matters: cheap syntactic refusals come first so a misconfigured path
 * never reaches the filesystem, and the interpreter check comes before the
 * existence check so a user who pointed the setting at `claude.cmd` is told
 * what is actually wrong rather than being sent looking for a missing file.
 *
 * The messages name the problem and the fix; none of them echoes anything but
 * the configured path itself, which the user typed.
 */
export function validateExecutablePath(input: ValidateExecutableInput): ExecutableValidation {
    const raw = input.path.trim()
    if (raw.length === 0) {
        return {
            ok: false,
            code: 'empty',
            message: 'No executable path is configured for this CLI backend.'
        }
    }
    // A NUL byte truncates the path inside the OS call: everything after it is
    // silently dropped, so the path that gets executed is not the path that
    // was checked. Refuse instead of checking one thing and running another.
    if (raw.includes('\0')) {
        return {
            ok: false,
            code: 'invalid-characters',
            message: 'The executable path contains an invalid character.'
        }
    }
    if (raw.startsWith('~')) {
        return {
            ok: false,
            code: 'not-absolute',
            message:
                'The executable path must be absolute — "~" is expanded by a shell, and this ' +
                'backend never runs one. Use the full path to the binary.'
        }
    }
    if (!isAbsoluteExecutablePath(input.platform, raw)) {
        return {
            ok: false,
            code: 'not-absolute',
            message:
                'The executable path must be absolute. A name or a relative path would be ' +
                'resolved through PATH or the working directory, which is not safe to trust.'
        }
    }
    if (
        input.platform === 'win32' &&
        (WINDOWS_INTERPRETED_EXTENSIONS as readonly string[]).includes(lowercaseExtension(raw))
    ) {
        return {
            ok: false,
            code: 'needs-interpreter',
            message:
                'This file is a script, not a program: running it would require a command ' +
                'interpreter, which this backend never starts. Point the setting at the .exe.'
        }
    }
    const stat = input.probe.statFile(raw)
    if (stat === null) {
        return {
            ok: false,
            code: 'not-found',
            message: `No file exists at ${raw}.`
        }
    }
    if (!stat.isFile) {
        return {
            ok: false,
            code: 'not-a-file',
            message: `${raw} is not a file.`
        }
    }
    if (!input.probe.isExecutable(raw)) {
        return {
            ok: false,
            code: 'not-executable',
            message: `${raw} is not executable by this user.`
        }
    }
    return { ok: true, path: raw }
}
