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
 * There is deliberately NO third kind. An earlier draft of this module let a
 * user name extra variables (API keys) to forward; the setting to name them
 * was never built, so the parameter had no caller and the docs promised a
 * control that did not exist. It is gone rather than half-present: the tools
 * this plugin runs authenticate from their own login under `HOME`, and a
 * pass-through list is a door that only gets opened once there is a screen
 * that asks for consent to open it.
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

export interface BuildCliEnvInput {
    readonly platform: CliPlatform
    /** Usually `process.env`. Missing names are skipped, never defaulted. */
    readonly sourceEnv: Readonly<Record<string, string | undefined>>
    /** The run's throwaway directory; becomes the child's temp directory. */
    readonly runDir: string
}

/**
 * Builds the child environment.
 *
 * Total: nothing in the input is user-supplied any more, so there is no
 * refusal to model and no failure the caller has to handle. A name the source
 * environment does not define is simply absent from the result — never
 * defaulted, and never `undefined` (Node reads that as "inherit" on some
 * platforms, which would quietly re-open the hole).
 */
export function buildCliEnv(input: BuildCliEnvInput): Record<string, string> {
    const env: Record<string, string> = Object.create(null) as Record<string, string>
    const allowlist: readonly string[] =
        input.platform === 'win32' ? WINDOWS_ALLOWLIST : POSIX_ALLOWLIST

    for (const name of allowlist) {
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

    return { ...env }
}
