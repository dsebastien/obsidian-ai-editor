import { describe, expect, it } from 'bun:test'
import type { OperationEvent } from '../../../domain/operations/contract'

type OperationErrorCode = Extract<OperationEvent, { type: 'error' }>['error']['code']

import { backendRefSchema, type BackendRef } from '../../../domain/settings/settings-schema'
import { toStderrDiagnostics, BoundedCapture } from './capture'
import type { StderrDiagnostics } from './capture'
import type { KillResult } from './kill'
import {
    cliTimeoutMs,
    createCliEditorExecutor,
    resolveCliModel,
    type SpawnCliProcessFn
} from './cli-editor-backend'
import type { CliProcessFailureCode, CliProcessOutcome, SpawnCliProcessInput } from './spawn'
import {
    CODEX_TURN_COMPLETED,
    claudeErrorEnvelope,
    claudeSuccessEnvelope,
    cliReviewOperation,
    codexAgentMessage,
    codexStream,
    makeCliConfig,
    makeConsentedCliConfig
} from './tools/spec-fixtures'

/**
 * The executor is spec'd against an INJECTED boundary, never a real one: the
 * point of this layer is the translation between a process outcome and the
 * operation contract, and requiring `claude` or `codex` to be installed would
 * make the suite untestable on CI and on anyone else's machine. The boundary
 * itself has its own conformance suite against real children (`spawn.spec.ts`).
 */

function stderr(bytes = 0, text = ''): StderrDiagnostics {
    const capture = new BoundedCapture(64 * 1024, 'keep-tail')
    if (bytes > 0) {
        capture.push(new TextEncoder().encode(text.length > 0 ? text : 'x'.repeat(bytes)))
    }
    return toStderrDiagnostics(capture)
}

function okOutcome(stdout: string, kill: KillResult | null = 'already-gone'): CliProcessOutcome {
    return { ok: true, stdout, stderr: stderr(), durationMs: 12, kill }
}

function failedOutcome(
    code: CliProcessFailureCode,
    overrides: Partial<Extract<CliProcessOutcome, { ok: false }>> = {}
): CliProcessOutcome {
    return {
        ok: false,
        code,
        message: 'Boundary message.',
        stdout: '',
        exitCode: 1,
        termSignal: null,
        kill: null,
        stderr: stderr(),
        durationMs: 12,
        ...overrides
    }
}

interface Harness {
    readonly events: OperationEvent[]
    readonly calls: SpawnCliProcessInput[]
}

async function run(
    outcome: CliProcessOutcome | ((input: SpawnCliProcessInput) => Promise<CliProcessOutcome>),
    options: {
        kind?: 'claude-code' | 'codex'
        model?: string
        signal?: AbortSignal
        allowTools?: boolean
    } = {}
): Promise<Harness> {
    const calls: SpawnCliProcessInput[] = []
    const spawn: SpawnCliProcessFn = async (input) => {
        calls.push(input)
        return typeof outcome === 'function' ? await outcome(input) : outcome
    }
    const execute = createCliEditorExecutor({
        backendConfig: makeConsentedCliConfig({
            kind: options.kind ?? 'claude-code',
            executablePath: '/usr/local/bin/claude',
            timeoutSeconds: 120,
            tools: options.allowTools ?? false
        }),
        model: options.model ?? '',
        systemPrompt: 'You are the Concision Editor.',
        timeoutMs: 120_000,
        spawn
    })
    const events: OperationEvent[] = []
    for await (const event of execute(
        cliReviewOperation(),
        options.signal ?? new AbortController().signal
    )) {
        events.push(event)
    }
    return { events, calls }
}

const VALID_REVIEW = JSON.stringify({
    kind: 'review',
    findings: [{ quote: 'Hello world', critique: 'Generic opener', severity: 'suggestion' }],
    summary: 'Fine draft'
})

// ---------------------------------------------------------------------------

describe('createCliEditorExecutor — happy path', () => {
    it('validates the tool result through the operation contract and emits it once', async () => {
        const { events } = await run(okOutcome(claudeSuccessEnvelope(VALID_REVIEW)))
        expect(events).toHaveLength(1)
        const [event] = events
        expect(event?.type).toBe('result')
        expect(event?.type === 'result' && event.result.kind).toBe('review')
        expect(event?.runId).toBe(cliReviewOperation().runId)
    })

    it('works the same for a JSONL tool, because the seam is the envelope', async () => {
        const stdout = codexStream([codexAgentMessage(VALID_REVIEW), CODEX_TURN_COMPLETED])
        const { events } = await run(okOutcome(stdout), { kind: 'codex' })
        expect(events[0]?.type).toBe('result')
    })

    it('tolerates a fenced payload exactly as the API parsers do', async () => {
        const fenced = `\`\`\`json\n${VALID_REVIEW}\n\`\`\``
        const { events } = await run(okOutcome(claudeSuccessEnvelope(fenced)))
        expect(events[0]?.type).toBe('result')
    })

    it('hands the boundary the tool argv, the content on stdin, and the timeout', async () => {
        const { calls } = await run(okOutcome(claudeSuccessEnvelope(VALID_REVIEW)), {
            model: 'sonnet'
        })
        const [call] = calls
        expect(call?.executablePath).toBe('/usr/local/bin/claude')
        expect(call?.args).toContain('--print')
        expect(call?.args).toContain('sonnet')
        expect(call?.stdin).toContain('Hello world. This is a test document')
        expect(call?.timeoutMs).toBe(120_000)
    })

    it('never lets a caller set a working directory (the boundary owns it)', async () => {
        const { calls } = await run(okOutcome(claudeSuccessEnvelope(VALID_REVIEW)))
        expect(calls[0]).not.toHaveProperty('cwd')
    })
})

describe('createCliEditorExecutor — result validation', () => {
    it('salvages a well-formed answer whose finding is malformed (dropped, counted)', async () => {
        const wrong = JSON.stringify({ kind: 'review', findings: [{ critique: 'no quote' }] })
        const { events } = await run(okOutcome(claudeSuccessEnvelope(wrong)))
        expect(events).toHaveLength(1)
        const event = events[0]
        expect(event?.type).toBe('result')
        if (event?.type === 'result') {
            expect(event.result.kind === 'review' && event.result.findings).toEqual([])
            expect(event.salvage).toEqual({ discardedFindings: 1, invalidProposals: 0 })
        }
    })

    it('refuses prose, which is what an agent CLI produces when it forgets', async () => {
        const { events } = await run(
            okOutcome(claudeSuccessEnvelope("Sure! Here's what I found: the opening is weak."))
        )
        expect(events[0]?.type === 'error' && events[0].error.code).toBe('invalid-output')
    })

    it('does not echo the tool payload in the validation failure', async () => {
        const { events } = await run(
            okOutcome(claudeSuccessEnvelope('{"kind":"review","findings":"sk-live-SECRET"}'))
        )
        expect(events[0]?.type === 'error' && events[0].error.message).not.toContain('SECRET')
    })
})

describe('createCliEditorExecutor — boundary failures', () => {
    it.each<[CliProcessFailureCode, OperationErrorCode]>([
        ['cancelled', 'cancelled'],
        ['timeout', 'timeout'],
        ['stdout-overflow', 'invalid-output'],
        ['invalid-executable', 'unknown'],
        ['invalid-argument', 'unknown'],
        ['run-dir-failed', 'unknown'],
        ['spawn-failed', 'unknown'],
        ['nonzero-exit', 'unknown'],
        ['killed', 'unknown']
    ])('maps %s to the %s contract code', async (failure, code) => {
        const { events } = await run(failedOutcome(failure))
        expect(events).toHaveLength(1)
        expect(events[0]?.type === 'error' && events[0].error.code).toBe(code)
    })

    it('fails a run whose process tree could not be stopped, even though the tool answered', async () => {
        // Containment is the premise the consent dialog was granted on. A leak
        // the user is never told about is the one failure this whole boundary
        // exists to prevent, and there is no durable place to hang a warning on
        // a successful result — so the good answer is given up instead.
        const { events } = await run(okOutcome(claudeSuccessEnvelope(VALID_REVIEW), 'survived'))
        expect(events).toHaveLength(1)
        const message = events[0]?.type === 'error' ? events[0].error.message : ''
        expect(message).toContain('could not be stopped')
        expect(message).toContain('Claude Code')
    })

    it('delivers the result when the tree ended normally', async () => {
        const { events } = await run(okOutcome(claudeSuccessEnvelope(VALID_REVIEW), 'already-gone'))
        expect(events).toHaveLength(1)
        expect(events[0]?.type).toBe('result')
    })

    it('names the timeout setting so the fix is in the message', async () => {
        const { events } = await run(failedOutcome('timeout'))
        expect(events[0]?.type === 'error' && events[0].error.message).toContain('Timeout')
    })

    it('reports that stderr had something to say, without saying what', async () => {
        const { events } = await run(
            failedOutcome('nonzero-exit', { stderr: stderr(30, 'key=sk-live-SECRET failed') })
        )
        const message = events[0]?.type === 'error' ? events[0].error.message : ''
        expect(message).toContain('error stream')
        expect(message).not.toContain('SECRET')
    })

    it('surfaces a process tree that could not be stopped', async () => {
        const { events } = await run(failedOutcome('cancelled', { kill: 'survived' }))
        expect(events[0]?.type === 'error' && events[0].error.message).toContain(
            'may still be running'
        )
    })

    it('says nothing about surviving processes when the tree died', async () => {
        const { events } = await run(failedOutcome('timeout', { kill: 'terminated' }))
        expect(events[0]?.type === 'error' && events[0].error.message).not.toContain(
            'may still be running'
        )
    })

    it('reads the error envelope a tool wrote to stdout before dying (issue #39)', async () => {
        // Claude Code reports a missing login and upstream API failures as a
        // JSON envelope on stdout AND a nonzero exit, with nothing on stderr.
        // "Exited with status 1" is true but useless; the envelope names it.
        const { events } = await run(
            failedOutcome('nonzero-exit', { stdout: claudeErrorEnvelope(401) })
        )
        const event = events[0]
        expect(event?.type === 'error' && event.error.code).toBe('auth')
        const message = event?.type === 'error' ? event.error.message : ''
        expect(message).toContain('HTTP 401')
        // Both facts are true, so both are stated.
        expect(message).toContain('Boundary message.')
        // The envelope's own text quotes configuration — never forwarded.
        expect(message).not.toContain('no-such-model-xyz')
    })

    it('keeps the exit-status story when stdout is not an envelope', async () => {
        const { events } = await run(
            failedOutcome('nonzero-exit', { stdout: 'error: unknown option --frobnicate\n' })
        )
        const event = events[0]
        expect(event?.type === 'error' && event.error.code).toBe('unknown')
        expect(event?.type === 'error' && event.error.message).toBe('Boundary message.')
    })

    it('never parses stdout for failures other than a nonzero exit', async () => {
        // A timeout with a complete-looking envelope on stdout is still a
        // timeout: the envelope was written by a process that was killed, and
        // trusting it would misreport what ended the run.
        const { events } = await run(failedOutcome('timeout', { stdout: claudeErrorEnvelope(401) }))
        expect(events[0]?.type === 'error' && events[0].error.code).toBe('timeout')
    })

    it('attaches captured output as reveal-only diagnostics (issue #39)', async () => {
        const { events } = await run(
            failedOutcome('nonzero-exit', {
                stdout: 'partial output',
                stderr: stderr(30, 'key=sk-live-SECRET failed')
            })
        )
        const event = events[0]
        if (event?.type !== 'error') {
            throw new Error('expected error')
        }
        const diagnostics = event.error.diagnostics
        expect(diagnostics).toBeDefined()
        // The summary is safe anywhere; the content only behind reveal().
        expect(diagnostics?.summary).toContain('error stream')
        expect(diagnostics?.summary).not.toContain('SECRET')
        expect(diagnostics?.reveal()).toContain('sk-live-SECRET')
        expect(diagnostics?.reveal()).toContain('partial output')
        expect(diagnostics?.reveal()).toContain('Exit status: 1')
    })

    it('attaches no diagnostics when the tool wrote nothing', async () => {
        const { events } = await run(failedOutcome('spawn-failed', { exitCode: null }))
        const event = events[0]
        if (event?.type !== 'error') {
            throw new Error('expected error')
        }
        expect(event.error.diagnostics).toBeUndefined()
    })
})

describe('createCliEditorExecutor — envelope failures', () => {
    it('forwards the tool-reported API status as its contract code', async () => {
        const { events } = await run(okOutcome(claudeErrorEnvelope(401)))
        expect(events[0]?.type === 'error' && events[0].error.code).toBe('auth')
    })

    it('treats a rate limit the same as an API backend would', async () => {
        const { events } = await run(okOutcome(claudeErrorEnvelope(429)))
        expect(events[0]?.type === 'error' && events[0].error.code).toBe('rate-limit')
    })

    it('refuses stdout that is not the tool protocol at all', async () => {
        const { events } = await run(okOutcome('bash: claude: command not found\n'))
        expect(events[0]?.type === 'error' && events[0].error.code).toBe('invalid-output')
    })
})

describe('createCliEditorExecutor — cancellation', () => {
    it('never starts a process when the signal is already aborted', async () => {
        const controller = new AbortController()
        controller.abort()
        const { events, calls } = await run(okOutcome(claudeSuccessEnvelope(VALID_REVIEW)), {
            signal: controller.signal
        })
        expect(calls).toHaveLength(0)
        expect(events[0]?.type === 'error' && events[0].error.code).toBe('cancelled')
    })

    it('reports cancellation even when the boundary raced to another failure', async () => {
        const controller = new AbortController()
        const { events } = await run(
            async () => {
                controller.abort()
                return failedOutcome('nonzero-exit')
            },
            { signal: controller.signal }
        )
        expect(events[0]?.type === 'error' && events[0].error.code).toBe('cancelled')
    })
})

describe('createCliEditorExecutor — protocol invariants', () => {
    it('emits exactly one terminal event and never throws, even on a broken boundary', async () => {
        const { events } = await run(() => Promise.reject(new Error('sk-live-SECRET exploded')))
        expect(events).toHaveLength(1)
        expect(events[0]?.type).toBe('error')
        expect(events[0]?.type === 'error' && events[0].error.code).toBe('unknown')
        expect(events[0]?.type === 'error' && events[0].error.message).not.toContain('SECRET')
    })

    it('echoes the request runId on every event', async () => {
        const outcomes: CliProcessOutcome[] = [
            okOutcome(claudeSuccessEnvelope(VALID_REVIEW)),
            okOutcome('garbage'),
            failedOutcome('spawn-failed')
        ]
        for (const outcome of outcomes) {
            const { events } = await run(outcome)
            expect(events.every((event) => event.runId === cliReviewOperation().runId)).toBe(true)
        }
    })

    it('emits no progress events, because there is nothing incremental to report', async () => {
        const { events } = await run(okOutcome(claudeSuccessEnvelope(VALID_REVIEW)))
        expect(events.some((event) => event.type === 'progress')).toBe(false)
    })
})

describe('resolveCliModel', () => {
    const ref = (model: string): BackendRef => backendRefSchema.parse({ backendId: 'cli-1', model })

    it('prefers the per-editor override', () => {
        const backend = makeCliConfig({ defaultModel: 'backend-default' })
        expect(resolveCliModel(ref('editor-override'), backend)).toBe('editor-override')
    })

    it('falls back to the backend default', () => {
        const backend = makeCliConfig({ defaultModel: 'backend-default' })
        expect(resolveCliModel(ref(''), backend)).toBe('backend-default')
        expect(resolveCliModel(null, backend)).toBe('backend-default')
    })

    it("defers to the tool's own default when nothing is configured", () => {
        // Empty is a valid answer here, unlike the API path where a missing
        // model is 'no-model-configured'.
        expect(resolveCliModel(null, makeCliConfig({ defaultModel: '' }))).toBe('')
        expect(resolveCliModel(ref(''), makeCliConfig({ defaultModel: '' }))).toBe('')
    })
})

describe('cliTimeoutMs', () => {
    it('converts the backend timeout from seconds to milliseconds', () => {
        expect(cliTimeoutMs(makeCliConfig({ timeoutSeconds: 300 }))).toBe(300_000)
    })
})
