import { hasToolsConsent } from '../../../../domain/settings/cli-consent'
import { parseJsonDocument } from '../protocol'
import { buildCliStdin } from './prompt'
import { safeStatusToken } from './types'
import type {
    BuildCliInvocationInput,
    CliEnvelope,
    CliInvocation,
    CliToolAdapter,
    CliToolCapabilities
} from './types'

/**
 * Claude Code adapter (`claude`).
 *
 * The invocation contract below was READ OFF the binary, not remembered:
 * `claude --help` on **2.1.220** (2026-07-30) and then exercised end to end
 * with the exact argv this module emits, including the failure path. Every
 * flag used here appears in that help output; nothing is inferred from a blog
 * post or from an older SDK. When this stops matching a future version, the
 * symptom will be an immediate non-zero exit with the unknown option named on
 * stderr — a loud failure, not a silent behavioural change.
 *
 * ```
 * claude --print --output-format json --no-session-persistence \
 *        --strict-mcp-config --permission-mode manual \
 *        [--model <model>] [--tools '']
 * ```
 *
 * with the prompt on stdin.
 *
 * Why each flag, in security terms:
 *
 * - `--print` — non-interactive. Without it the binary starts a TUI and the
 *   run hangs until the boundary's timeout kills it.
 * - `--output-format json` — a machine envelope instead of prose. `text` is
 *   the default and would leave the plugin scraping a transcript.
 * - `--no-session-persistence` — **the note is not written to disk.** By
 *   default Claude Code saves every session under the user's home directory,
 *   so a review of a note the user deliberately keeps private would leave a
 *   verbatim copy outside the vault, outside the vault's exclusion rules and
 *   outside anything the plugin can later delete (Business Rules #7, #12).
 *   Documented as `--print`-only, which is the mode used here.
 * - `--strict-mcp-config` — no MCP config file is passed, and this makes that
 *   mean "no MCP servers" instead of "whatever the user configured globally".
 *   An MCP server is an arbitrary program with network access; inheriting the
 *   user's set would hand the note to processes the plugin never mentioned.
 * - `--permission-mode manual` — the safe end of the documented choices.
 *   Nothing can answer a permission prompt in a headless run, so anything
 *   requiring one is refused. The dangerous values (`bypassPermissions`,
 *   `--dangerously-skip-permissions`) are not emitted by any code path here.
 * - `--tools ''` — the help states `Use "" to disable all tools`. Emitted
 *   whenever the backend's tool consent is not granted, which is the default.
 *   It goes **last**: `--tools` is variadic, so it swallows following
 *   non-option arguments, and keeping it at the end means no future flag can
 *   be eaten by it. There is no positional prompt argument for it to consume
 *   either — the prompt is on stdin.
 *
 * Deliberately NOT emitted, and each for a reason:
 *
 * - `--append-system-prompt` / `--system-prompt` — both take the prompt as an
 *   argv value. That is the one thing the boundary refuses (`ps` is world
 *   readable); the persona travels on stdin instead, framed by `buildCliStdin`.
 * - `--json-schema` — attractive (server-side validation of the result shape)
 *   but the operation schemas serialize to several kilobytes, well past the
 *   boundary's 4096-character argument cap. The schema is embedded in the
 *   prompt instead and Zod remains the enforcement boundary either way.
 * - `--add-dir`, `--settings`, `--mcp-config`, `--plugin-dir`, `--agents` —
 *   every one of them widens what the agent can see or execute.
 * - `--bare` — it does disable hooks, plugins and CLAUDE.md discovery, which
 *   is appealing, but its documented side effect is that authentication
 *   becomes `ANTHROPIC_API_KEY`-only, breaking every subscription user. Not a
 *   default the plugin gets to make on a user's behalf. `--safe-mode` disables
 *   the same set and more; it is admin-policy shaped and equally not ours to
 *   impose.
 * - `--setting-sources` — it exists (2.1.220) and an empty list is accepted by
 *   the binary, so it looks like the way to drop user settings without the
 *   OAuth breakage `--bare` causes. It is NOT emitted, because what it drops
 *   could not be demonstrated from outside: the help documents it as loading
 *   `user, project, local` settings and says nothing about plugins, hooks or
 *   skills, and prompt caching makes a token-count comparison between runs
 *   meaningless. Shipping a flag as a security control on the strength of its
 *   name is how a false guarantee gets written down. Revisit with a real
 *   before/after against a machine with plugins and pre-approved permission
 *   rules configured.
 *
 * **What is therefore NOT bounded, and is said so in the README, the user
 * guide and the consent dialog:** the user's own Claude Code configuration is
 * loaded — `CLAUDE.md`, skills, plugins, hooks and `settings.json`. That last
 * one matters most: `--permission-mode manual` sets the interactive default,
 * it does not overrule `permissions.allow` rules the user wrote, so a user
 * with broad rules of their own gets those tools in a headless run. There is
 * also no read-only sandbox flag for Claude Code the way there is for Codex;
 * the containment here is the throwaway directory and the empty environment.
 */

/** Not `--print`: the long form is what the help documents and is greppable. */
const BASE_ARGS = [
    '--print',
    '--output-format',
    'json',
    '--no-session-persistence',
    '--strict-mcp-config',
    '--permission-mode',
    'manual'
] as const

function buildInvocation(input: BuildCliInvocationInput): CliInvocation {
    const args: string[] = [...BASE_ARGS]
    if (input.model.length > 0) {
        args.push('--model', input.model)
    }
    if (!hasToolsConsent(input.config)) {
        // Last, and only here: `--tools` is variadic (see the module note).
        args.push('--tools', '')
    }
    return {
        args,
        stdin: buildCliStdin({ systemPrompt: input.systemPrompt, operation: input.operation }),
        protocol: 'json-document'
    }
}

/**
 * Maps the HTTP status the CLI reports for an upstream failure onto the
 * operation contract's error vocabulary. Same mapping as the API transport's
 * `assertOkStatus`, because it is the same upstream API answering — a user
 * whose key expired should read the same thing whichever family they picked.
 */
function codeForStatus(status: number): 'auth' | 'rate-limit' | 'network' | 'unknown' {
    if (status === 401 || status === 403) {
        return 'auth'
    }
    if (status === 429) {
        return 'rate-limit'
    }
    if (status >= 500) {
        return 'network'
    }
    return 'unknown'
}

/**
 * Reads the `--output-format json` envelope.
 *
 * Shape, from a live run:
 *
 * ```json
 * { "type": "result", "subtype": "success", "is_error": false,
 *   "result": "<the model's final message>", "session_id": "…",
 *   "terminal_reason": "completed", "api_error_status": null, … }
 * ```
 *
 * Two traps, both confirmed against the binary rather than assumed:
 *
 * 1. **`subtype` still reads `"success"` on a failed run.** A run against a
 *    non-existent model came back with `subtype: "success"`, `is_error: true`,
 *    `terminal_reason: "api_error"`, `api_error_status: 404`. `is_error` is
 *    the authoritative flag; keying off `subtype` would have reported an API
 *    failure as a successful answer whose text happened not to be JSON.
 * 2. **The process exits 0 on that same failure.** The exit status says the
 *    CLI ran, not that the request worked, so the envelope has to be read
 *    even for a clean exit.
 *
 * On failure `result` holds a human explanation — which is exactly the kind
 * of string that quotes back the configuration that caused it, so it is never
 * forwarded (Business Rules #12). The status number and the sanitized reason
 * token are, because neither can carry content.
 */
function parseEnvelope(stdout: string): CliEnvelope {
    const parsed = parseJsonDocument(stdout)
    if (!parsed.ok) {
        return { ok: false, code: 'invalid-output', message: parsed.message }
    }
    const envelope = parsed.value as Record<string, unknown>
    if (envelope['type'] !== 'result') {
        return {
            ok: false,
            code: 'invalid-output',
            message: 'The Claude Code CLI did not return a result envelope.'
        }
    }
    if (envelope['is_error'] === true) {
        const status = envelope['api_error_status']
        if (typeof status === 'number') {
            return {
                ok: false,
                code: codeForStatus(status),
                message: `The Claude Code CLI reported an API error (HTTP ${String(status)}).`
            }
        }
        const reason = safeStatusToken(envelope['terminal_reason'])
        return {
            ok: false,
            code: 'unknown',
            message:
                reason === null
                    ? 'The Claude Code CLI reported an error.'
                    : `The Claude Code CLI reported an error (${reason}).`
        }
    }
    const result = envelope['result']
    if (typeof result !== 'string') {
        return {
            ok: false,
            code: 'invalid-output',
            message: 'The Claude Code CLI returned a result envelope with no message.'
        }
    }
    return { ok: true, text: result }
}

function capabilities(): CliToolCapabilities {
    return {
        // The boundary hands over stdout once the process has ended; there is
        // no incremental path to the UI yet, whatever the tool can emit.
        streaming: false,
        // `--json-schema` exists but does not fit in argv (module note).
        jsonSchema: false,
        // `--tools ''` is a real switch with a real off position, so consent
        // has something to grant. Granting it does NOT relax permissions:
        // `--permission-mode manual` still stands, so what the agent gets is
        // the tools that need no approval — reads inside a throwaway empty
        // directory, and the web.
        canGrantTools: true
    }
}

export const claudeCodeAdapter: CliToolAdapter = {
    displayName: 'Claude Code',
    buildInvocation,
    parseEnvelope,
    capabilities
}
