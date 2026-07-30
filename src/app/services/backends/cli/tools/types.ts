import type { OperationRequest } from '../../../../domain/operations/contract'
import type { CliBackend } from '../../../../domain/settings/settings-schema'

/**
 * Per-tool adapter contract: pure invocation builders and envelope parsers.
 *
 * The mirror image of `backends/providers/types.ts`. An API adapter turns an
 * operation into an `HttpRequestDescriptor` a transport executes later; a CLI
 * adapter turns the same operation into a `CliInvocation` the security
 * boundary (`spawnCliProcess`) executes later, and turns the tool's stdout
 * back into the model's final message. Both layers perform NO I/O, so every
 * tool quirk is unit-testable without the binary being installed.
 *
 * What an adapter is explicitly NOT allowed to decide is anything the
 * boundary owns: there is no `cwd`, no environment, no shell, no timeout and
 * no kill policy in this contract. An adapter contributes argv and reads
 * text; `spawn.ts` decides what the process can see and how it dies.
 *
 * The tool's kind vocabulary comes from `cliBackendSchema` — the settings
 * schema is the authority on which tools exist, not this module.
 */

export type CliToolKind = CliBackend['kind']

/**
 * How a tool frames its stdout. Both shapes are parsed by `protocol.ts`;
 * which one a given tool speaks is a per-tool fact and lives in its adapter.
 *
 * - `json-document` — one JSON object for the whole run (Claude Code
 *   `--output-format json`).
 * - `json-lines` — one JSON object per line, emitted as the agent works
 *   (Codex `exec --json`).
 */
export type CliOutputProtocol = 'json-document' | 'json-lines'

/** Everything the boundary needs from an adapter to start one run. */
export interface CliInvocation {
    /**
     * Flags only, in the order the tool expects them. Never note content:
     * argv is world-readable in `ps`, and `validateCliArguments` refuses
     * anything long enough to look like a document.
     */
    readonly args: readonly string[]
    /** The whole prompt. The only channel note content travels on. */
    readonly stdin: string
    /** How `parseEnvelope` will read this run's stdout. */
    readonly protocol: CliOutputProtocol
}

/**
 * What a tool profile supports.
 *
 * Deliberately pessimistic: a capability is false until it has been verified
 * against the real binary, because the cost of claiming one that does not
 * hold is a run that silently does less than the user was told.
 */
export interface CliToolCapabilities {
    /**
     * Incremental results reach the UI while the tool works. False for every
     * tool today: the boundary reads a bounded capture and hands over stdout
     * once the process has ended, so there is nothing to stream even for a
     * tool whose protocol is event-framed.
     */
    readonly streaming: boolean
    /** The tool enforces a JSON Schema on the model's final message. */
    readonly jsonSchema: boolean
    /**
     * Whether tool/research mode can be GRANTED to this tool at all — i.e.
     * whether the backend's tool consent (plan M7, Business Rules #9)
     * has anything to switch on. False means the plugin found no way to hand
     * this tool extra reach that it could also bound, so it never tries.
     */
    readonly canGrantTools: boolean
}

export interface BuildCliInvocationInput {
    readonly operation: OperationRequest
    /** Assembled persona system prompt (voice profile + persona + context). */
    readonly systemPrompt: string
    /**
     * Resolved model id, or `''` to let the tool pick its own default.
     * Unlike an API backend — where a missing model is a configuration error
     * because the request body needs one — a CLI tool already has a default
     * of its own, and overriding it with a guess would be worse than
     * deferring to it.
     */
    readonly model: string
    readonly config: CliBackend
}

/**
 * Failure codes an envelope can establish on its own, without knowing
 * anything about the process. A subset of the operation contract's error
 * vocabulary so normalization stays a pass-through.
 */
export type CliEnvelopeErrorCode = 'auth' | 'rate-limit' | 'network' | 'invalid-output' | 'unknown'

/**
 * The tool's final message, or why there is not one.
 *
 * `text` is the model's answer and nothing else — the envelope's own
 * bookkeeping (session ids, token usage, cost, timings) is dropped here, so
 * the layer above parses exactly what an API backend's `content` would have
 * carried.
 *
 * Failure messages are STATUS ONLY. A CLI tool's error text routinely
 * contains the endpoint URL it called and the configuration it was given,
 * and configuration routinely contains the key it was given (Business Rules
 * #12) — so nothing an adapter reads out of the payload is ever interpolated
 * into a message a user can see.
 */
export type CliEnvelope =
    | { readonly ok: true; readonly text: string }
    | {
          readonly ok: false
          readonly code: CliEnvelopeErrorCode
          readonly message: string
      }

/**
 * One CLI tool profile (Claude Code, Codex).
 *
 * Implementations must be stateless: the same input always yields the same
 * invocation, and `parseEnvelope` depends only on `stdout`.
 */
export interface CliToolAdapter {
    /** The tool's own display name, for messages the user reads. */
    readonly displayName: string
    buildInvocation(input: BuildCliInvocationInput): CliInvocation
    parseEnvelope(stdout: string): CliEnvelope
    capabilities(): CliToolCapabilities
}

/**
 * Renders a tool-authored status token safe to show a user.
 *
 * Tools label their outcomes with short enum-like strings (`api_error`,
 * `max_turns`). Those are genuinely useful in an error message and genuinely
 * not content — but they arrive inside a payload the plugin does not control,
 * so the shape is enforced rather than trusted: lowercase words only, and
 * short. Anything else is dropped entirely instead of being truncated,
 * because a truncated secret is still a leaked secret.
 */
export function safeStatusToken(value: unknown): string | null {
    if (typeof value !== 'string') {
        return null
    }
    return /^[a-z][a-z0-9_]{0,39}$/.test(value) ? value : null
}
