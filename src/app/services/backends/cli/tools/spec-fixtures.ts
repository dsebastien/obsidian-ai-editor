import { CONTRACT_VERSION, type ReviewRequest } from '../../../../domain/operations/contract'
import { cliBackendSchema, type CliBackend } from '../../../../domain/settings/settings-schema'

/**
 * Test-only fixture builders shared by the CLI tool adapter specs. Not a test
 * file itself (bun only collects `*.spec.ts`), never imported by production
 * code.
 */

export function makeCliConfig(overrides: Partial<CliBackend> = {}): CliBackend {
    return cliBackendSchema.parse({
        id: 'cli-1',
        family: 'cli',
        kind: 'claude-code',
        label: 'Test CLI backend',
        executablePath: '/usr/local/bin/claude',
        ...overrides
    })
}

export const CLI_DOCUMENT_TEXT = 'Hello world. This is a test document about writing well.'

export function cliReviewOperation(): ReviewRequest {
    return {
        contractVersion: CONTRACT_VERSION,
        kind: 'review',
        runId: 'run-cli-1',
        snapshotHash: 'hash-1',
        text: CLI_DOCUMENT_TEXT
    }
}

/** The Claude Code `--output-format json` envelope, as the binary emits it. */
export function claudeSuccessEnvelope(result: string): string {
    return `${JSON.stringify({
        type: 'result',
        subtype: 'success',
        is_error: false,
        result: result,
        session_id: '5e1b0cda-0772-4762-a982-40dd6c4e6570',
        terminal_reason: 'completed',
        api_error_status: null,
        num_turns: 1,
        total_cost_usd: 0.0009874
    })}\n`
}

/**
 * The failure envelope observed live against a non-existent model. Note that
 * `subtype` still reads 'success' — `is_error` is the authoritative flag.
 */
export function claudeErrorEnvelope(
    apiErrorStatus: number | null,
    terminalReason = 'api_error'
): string {
    return `${JSON.stringify({
        type: 'result',
        subtype: 'success',
        is_error: true,
        result: "There's an issue with the selected model (no-such-model-xyz).",
        terminal_reason: terminalReason,
        api_error_status: apiErrorStatus
    })}\n`
}

/** Joins Codex events into the JSONL stdout shape. */
export function codexStream(events: readonly Record<string, unknown>[]): string {
    return `${events.map((event) => JSON.stringify(event)).join('\n')}\n`
}

export const CODEX_THREAD_STARTED = { type: 'thread.started', thread_id: 'thread-1' }
export const CODEX_TURN_STARTED = { type: 'turn.started' }
export const CODEX_TURN_COMPLETED = { type: 'turn.completed', usage: { output_tokens: 5 } }

/** The model-metadata warning Codex emits on a run that then succeeds. */
export const CODEX_WARNING_ITEM = {
    type: 'item.completed',
    item: {
        id: 'item_0',
        type: 'error',
        message: 'Model metadata for `gpt-5.3-codex` not found.'
    }
}

export function codexAgentMessage(text: string, id = 'item_1'): Record<string, unknown> {
    return { type: 'item.completed', item: { id: id, type: 'agent_message', text: text } }
}
