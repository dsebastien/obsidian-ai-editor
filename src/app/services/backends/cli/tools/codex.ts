import { parseJsonLines } from '../protocol'
import { buildCliStdin } from './prompt'
import type {
    BuildCliInvocationInput,
    CliEnvelope,
    CliInvocation,
    CliToolAdapter,
    CliToolCapabilities
} from './types'

/**
 * Codex adapter (`codex exec`).
 *
 * Read off the binary, not remembered: `codex --help` and `codex exec --help`
 * on **@openai/codex 2026-07-30**, then exercised end to end with the exact
 * argv this module emits, including the failure path. Every flag used here
 * appears in that help output.
 *
 * ```
 * codex exec --json --color never --skip-git-repo-check --ephemeral \
 *            --sandbox read-only [--model <model>] -
 * ```
 *
 * with the prompt on stdin.
 *
 * Why each flag, in security terms:
 *
 * - `exec` — the documented non-interactive subcommand. Bare `codex` starts a
 *   TUI and the run would hang until the boundary's timeout.
 * - `--json` — JSONL events on stdout. Without it the output is a rendered
 *   transcript.
 * - `--color never` — belt and braces over the boundary's `NO_COLOR`/`TERM`;
 *   an ANSI escape inside a JSON line corrupts the protocol.
 * - `--ephemeral` — **the note is not written to disk.** Codex otherwise
 *   persists session files, which for a private note means a verbatim copy
 *   outside the vault and outside its exclusion rules (Business Rules #7,
 *   #12). This is the counterpart of Claude Code's `--no-session-persistence`.
 * - `--skip-git-repo-check` — required, not optional: the boundary runs every
 *   tool in a throwaway directory that is deliberately not a git repository,
 *   and without this flag `exec` refuses to start there. The refusal exists to
 *   stop an agent editing an unversioned tree; nothing here is edited, and the
 *   directory is deleted when the run ends.
 * - `--sandbox read-only` — commands the model runs cannot write anything and
 *   cannot reach the network. Emitted unconditionally: see the consent note
 *   below. The widening values (`workspace-write`, `danger-full-access`) and
 *   `--dangerously-bypass-approvals-and-sandbox` are emitted by no code path
 *   in this plugin, and neither is `--dangerously-bypass-hook-trust` — an
 *   untrusted Codex hook is a program, and consenting to one on a user's
 *   behalf is not something a note-taking plugin gets to do.
 * - `-` — the documented spelling of "read the prompt from stdin".
 *
 * **Consent, honestly.** Codex has no equivalent of Claude
 * Code's `--tools ''`: running shell commands is not a feature of Codex that
 * can be switched off, it is how Codex answers at all. So this adapter
 * reports `canGrantTools: false` and its argv does not vary with the
 * backend's tool consent — there is nothing here that consent could
 * safely unlock, and a toggle that silently did nothing would be worse than
 * no toggle. What the plugin can state truthfully is the containment: a
 * read-only sandbox, in an empty directory that exists only for this run,
 * with an environment built from nothing. Granting Codex more than that is
 * out of scope until there is a bound the plugin can actually enforce.
 *
 * Deliberately NOT emitted:
 *
 * - `-C/--cd`, `--add-dir` — the working directory belongs to the boundary,
 *   and a caller cannot name one (that is what keeps an agent's files out of
 *   the vault).
 * - `--ignore-user-config` — tempting for isolation, but `~/.codex/config.toml`
 *   is where a user's provider, endpoint and model actually live. Ignoring it
 *   would silently redirect the run away from the setup the user tested,
 *   which is a correctness bug dressed as a security measure. The user's
 *   config is theirs, exactly like the credential store `HOME` grants access
 *   to.
 * - `--output-schema` — takes a FILE path, and the boundary owns the only
 *   directory the run has. The operation's JSON Schema is embedded in the
 *   prompt instead; Zod is the enforcement boundary either way.
 * - `--image`, `--profile`, `--enable` — nothing needs them, and each widens
 *   what the run loads.
 */

const BASE_ARGS = [
    'exec',
    '--json',
    '--color',
    'never',
    '--skip-git-repo-check',
    '--ephemeral',
    '--sandbox',
    'read-only'
] as const

function buildInvocation(input: BuildCliInvocationInput): CliInvocation {
    const args: string[] = [...BASE_ARGS]
    if (input.model.length > 0) {
        args.push('--model', input.model)
    }
    // Positional, and therefore last: the prompt comes from stdin.
    args.push('-')
    return {
        args,
        stdin: buildCliStdin({ systemPrompt: input.systemPrompt, operation: input.operation }),
        protocol: 'json-lines'
    }
}

/** The final assistant message inside an `item.completed` event, if this is one. */
function agentMessageText(event: Record<string, unknown>): string | null {
    if (event['type'] !== 'item.completed') {
        return null
    }
    const item = event['item']
    if (typeof item !== 'object' || item === null) {
        return null
    }
    const record = item as Record<string, unknown>
    if (record['type'] !== 'agent_message' || typeof record['text'] !== 'string') {
        return null
    }
    return record['text']
}

/**
 * Reads the `exec --json` event stream.
 *
 * Shape, from a live run:
 *
 * ```jsonl
 * {"type":"thread.started","thread_id":"…"}
 * {"type":"item.completed","item":{"id":"item_0","type":"error","message":"…"}}
 * {"type":"turn.started"}
 * {"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":"…"}}
 * {"type":"turn.completed","usage":{…}}
 * ```
 *
 * Three things this stream does that a naive reader gets wrong, each observed
 * rather than assumed:
 *
 * 1. **An `error` item is not a failure.** The `item_0` line above is a
 *    model-metadata warning, emitted on a run that then completed normally.
 *    Treating any error-shaped event as terminal would fail perfectly good
 *    runs.
 * 2. **Top-level `{"type":"error"}` lines are retries.** A failing run emitted
 *    five of them ("Reconnecting… 1/5") before actually giving up. Only
 *    `turn.failed` is terminal.
 * 3. **The process still exits 0 when the turn fails.** The exit status says
 *    the CLI ran; the stream says whether the request worked.
 *
 * So: `turn.failed` decides, and it outranks any message that preceded it —
 * a turn that failed after speaking did not finish its answer, and half an
 * answer parsed as a whole one is the failure mode this plugin can least
 * afford. Otherwise the LAST `agent_message` is the result, because an agent
 * may narrate before it concludes.
 *
 * `turn.failed`'s message carries the upstream error verbatim — a live one
 * contained the full endpoint URL including query parameters — so it is never
 * forwarded (Business Rules #12). The stderr diagnostics the boundary already
 * returns are where a user goes for detail, behind their explicit `reveal()`.
 */
function parseEnvelope(stdout: string): CliEnvelope {
    const parsed = parseJsonLines(stdout)
    if (!parsed.ok) {
        return { ok: false, code: 'invalid-output', message: parsed.message }
    }
    let lastMessage: string | null = null
    let completed = false
    for (const event of parsed.value) {
        const record = event as Record<string, unknown>
        if (record['type'] === 'turn.failed') {
            return {
                ok: false,
                code: 'unknown',
                message: 'The Codex CLI reported that the turn failed.'
            }
        }
        if (record['type'] === 'turn.completed') {
            completed = true
        }
        const text = agentMessageText(record)
        if (text !== null) {
            lastMessage = text
        }
    }
    if (lastMessage !== null) {
        return { ok: true, text: lastMessage }
    }
    return {
        ok: false,
        code: 'invalid-output',
        message: completed
            ? 'The Codex CLI finished without producing a message.'
            : 'The Codex CLI stopped before producing a message.'
    }
}

function capabilities(): CliToolCapabilities {
    return {
        // The events ARE incremental, but the boundary hands over a bounded
        // capture after the process ends, so nothing reaches the UI early.
        // Claiming otherwise would promise a live feed that does not exist.
        streaming: false,
        // `--output-schema` needs a file the run cannot own (module note).
        jsonSchema: false,
        // Nothing to grant: Codex cannot be run without its tools, so consent
        // has no off position to move away from (module note).
        canGrantTools: false
    }
}

export const codexAdapter: CliToolAdapter = {
    displayName: 'Codex',
    buildInvocation,
    parseEnvelope,
    capabilities
}
