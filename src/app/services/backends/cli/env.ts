import type { CliPlatform } from './platform'

/**
 * The child's environment, built from nothing.
 *
 * `process.env` in an Obsidian renderer is whatever the user's login shell,
 * package managers, and other tooling accumulated: tokens for unrelated
 * services, session keys, proxy credentials, `NODE_OPTIONS`, and on a
 * developer's machine a good deal more. Handing that to an agent that can
 * make network calls is a data-exfiltration path with no upside, so this
 * module starts from an EMPTY object and adds back only variables with a
 * stated reason.
 *
 * Every entry below is one of three kinds:
 *
 * 1. **The tool cannot start without it.** Windows refuses to create a
 *    process without `SystemRoot`; a POSIX tool with no `HOME` cannot find
 *    its own configuration or credential store, which for `claude` and
 *    `codex` is where the user's login actually lives.
 * 2. **The tool resolves its own sub-tools with it.** `PATH` — this is the
 *    one entry that is a real trade-off. Agents shell out to `git`, `rg`,
 *    `node`; without a `PATH` they degrade in ways that look like bugs. It is
 *    forwarded, and it is NEVER used to decide which binary WE launch (see
 *    `executable.ts`), so a hijacked `PATH` can mislead the agent's own
 *    helpers but cannot change what the plugin runs.
 * 3. **The user explicitly configured it.** API-key variables named in
 *    settings. Explicit configuration is consent; a wildcard is not.
 *
 * Two variables are SET by the boundary rather than forwarded: the temp
 * directory is redirected into the run's throwaway folder so scratch files
 * follow the same lifetime as the run, and colour output is turned off
 * because ANSI escape sequences on stdout would corrupt the JSON protocol.
 *
 * The result is a plain object with no prototype pollution surface and no
 * `undefined` values — Node treats an `undefined` env value as "inherit" on
 * some platforms, which would quietly re-open the hole.
 */

export type EnvProblem = 'invalid-name' | 'denied-name'

export type CliEnvResult =
    | { readonly ok: true; readonly env: Record<string, string> }
    | { readonly ok: false; readonly code: EnvProblem; readonly message: string }

/**
 * Forwarded because the tool cannot function without them. Order is
 * irrelevant; a name absent from the source environment is simply not added.
 */
const POSIX_ALLOWLIST = [
    /** Where the tool's own config and credentials live. */
    'HOME',
    /** The child's resolution of its own sub-tools (git, rg, node…). */
    'PATH',
    /** Text encoding of the child's output; a wrong locale mangles UTF-8. */
    'LANG',
    'LC_ALL',
    'LC_CTYPE'
] as const

const WINDOWS_ALLOWLIST = [
    /** The Windows spelling of HOME, in the three parts tools actually read. */
    'USERPROFILE',
    'HOMEDRIVE',
    'HOMEPATH',
    /** Where Windows programs keep per-user configuration and credentials. */
    'APPDATA',
    'LOCALAPPDATA',
    'PATH',
    /** Without PATHEXT, Windows cannot resolve the child's own sub-tools. */
    'PATHEXT',
    /** Process creation itself fails without these. */
    'SystemRoot',
    'SystemDrive',
    'windir',
    'ComSpec'
] as const

/**
 * Variables the boundary refuses to forward even when a user names them,
 * because each one turns "run this program" into "run this program plus code
 * of my choosing" or redirects it at a different target. A user pasting one
 * of these into the API-key-variables setting is either confused or being
 * socially engineered; both cases end the same way.
 *
 * Compared case-insensitively: Windows environment names are, and a
 * case-sensitive check would be trivially bypassed with `ld_preload`.
 */
const DENIED_NAMES = [
    // Loader injection (Linux / glibc, musl, macOS).
    'LD_PRELOAD',
    'LD_LIBRARY_PATH',
    'LD_AUDIT',
    'DYLD_INSERT_LIBRARIES',
    'DYLD_LIBRARY_PATH',
    'DYLD_FRAMEWORK_PATH',
    // Runtime injection.
    'NODE_OPTIONS',
    'ELECTRON_RUN_AS_NODE',
    'PYTHONSTARTUP',
    'PYTHONPATH',
    'PERL5OPT',
    'RUBYOPT',
    // Shell startup hooks — a tool that shells out would execute these.
    'BASH_ENV',
    'ENV',
    'IFS',
    'SHELLOPTS',
    'PS4',
    // Redirection of the child's own sub-tool resolution or transport.
    'PATH',
    'GIT_SSH_COMMAND',
    'GIT_EXTERNAL_DIFF',
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'ALL_PROXY',
    // Already set by the boundary; a user override would defeat the sandbox.
    'TMPDIR',
    'TEMP',
    'TMP'
] as const

const DENIED_LOWERCASE: ReadonlySet<string> = new Set(
    DENIED_NAMES.map((name) => name.toLowerCase())
)

/** POSIX-portable variable name, with a length bound so settings stay sane. */
const VALID_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/

export interface BuildCliEnvInput {
    readonly platform: CliPlatform
    /** Usually `process.env`. Missing names are skipped, never defaulted. */
    readonly sourceEnv: Readonly<Record<string, string | undefined>>
    /**
     * Names of variables the user explicitly configured for this backend
     * (API keys, endpoint overrides). Forwarded by VALUE from `sourceEnv`;
     * a name that is not set in the source environment is skipped, so a typo
     * produces a tool that says it is unauthenticated rather than a crash.
     */
    readonly passThroughNames?: readonly string[]
    /** The run's throwaway directory; becomes the child's temp directory. */
    readonly runDir: string
}

/**
 * Builds the child environment, or refuses.
 *
 * Refusal (rather than silent dropping) is deliberate for the pass-through
 * list: a user who asked for a variable to reach the tool and did not get it
 * would debug the tool, not the setting.
 */
export function buildCliEnv(input: BuildCliEnvInput): CliEnvResult {
    const env: Record<string, string> = Object.create(null) as Record<string, string>
    const allowlist: readonly string[] =
        input.platform === 'win32' ? WINDOWS_ALLOWLIST : POSIX_ALLOWLIST

    for (const name of allowlist) {
        const value = input.sourceEnv[name]
        if (typeof value === 'string') {
            env[name] = value
        }
    }

    for (const name of input.passThroughNames ?? []) {
        if (!VALID_NAME.test(name)) {
            return {
                ok: false,
                code: 'invalid-name',
                message:
                    'Environment variable names may only contain letters, digits and ' +
                    'underscores, and may not start with a digit.'
            }
        }
        if (DENIED_LOWERCASE.has(name.toLowerCase())) {
            return {
                ok: false,
                code: 'denied-name',
                message:
                    `${name} cannot be passed to a CLI backend: it changes what the tool ` +
                    'loads or where it connects, not just how it authenticates.'
            }
        }
        const value = input.sourceEnv[name]
        if (typeof value === 'string') {
            env[name] = value
        }
    }

    // Set, not forwarded. Scratch files the agent writes land in the run's own
    // directory and die with it.
    if (input.platform === 'win32') {
        env['TEMP'] = input.runDir
        env['TMP'] = input.runDir
    } else {
        env['TMPDIR'] = input.runDir
    }
    // ANSI escapes on stdout would corrupt the JSON protocol; both spellings
    // exist in the wild and cost nothing to set.
    env['NO_COLOR'] = '1'
    env['TERM'] = 'dumb'

    return { ok: true, env: { ...env } }
}
