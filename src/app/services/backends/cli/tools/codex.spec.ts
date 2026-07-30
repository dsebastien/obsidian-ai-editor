import { describe, expect, it } from 'bun:test'
import { MAX_ARGUMENT_LENGTH, validateCliArguments } from '../spawn'
import { codexAdapter } from './codex'
import {
    CLI_DOCUMENT_TEXT,
    CODEX_THREAD_STARTED,
    CODEX_TURN_COMPLETED,
    CODEX_TURN_STARTED,
    CODEX_WARNING_ITEM,
    cliReviewOperation,
    codexAgentMessage,
    codexStream,
    makeConsentedCliConfig
} from './spec-fixtures'

function invoke(overrides: { model?: string; allowTools?: boolean; systemPrompt?: string } = {}) {
    return codexAdapter.buildInvocation({
        operation: cliReviewOperation(),
        systemPrompt: overrides.systemPrompt ?? 'You are the Concision Editor.',
        model: overrides.model ?? '',
        config: makeConsentedCliConfig({
            kind: 'codex',
            tools: overrides.allowTools ?? false
        })
    })
}

describe('codexAdapter.buildInvocation', () => {
    it('emits the verified non-interactive argv', () => {
        expect(invoke().args).toEqual([
            'exec',
            '--json',
            '--color',
            'never',
            '--skip-git-repo-check',
            '--ephemeral',
            '--sandbox',
            'read-only',
            '-'
        ])
    })

    it('reads the JSONL event protocol', () => {
        expect(invoke().protocol).toBe('json-lines')
    })

    it('keeps the stdin marker last, where a positional argument belongs', () => {
        expect(invoke({ model: 'gpt-5.3-codex' }).args.at(-1)).toBe('-')
    })

    it('never leaves the read-only sandbox, whatever the consent', () => {
        for (const allowTools of [false, true]) {
            const args = invoke({ allowTools }).args
            expect(args[args.indexOf('--sandbox') + 1]).toBe('read-only')
            expect(args).not.toContain('workspace-write')
            expect(args).not.toContain('danger-full-access')
            expect(args).not.toContain('--dangerously-bypass-approvals-and-sandbox')
            expect(args).not.toContain('--dangerously-bypass-hook-trust')
            expect(args).not.toContain('--add-dir')
            expect(args).not.toContain('-C')
            expect(args).not.toContain('--cd')
        }
    })

    it('does not vary with allowTools, because there is nothing safe to grant', () => {
        expect(invoke({ allowTools: true }).args).toEqual(invoke({ allowTools: false }).args)
    })

    it('keeps the session off disk (the note must not be persisted)', () => {
        expect(invoke().args).toContain('--ephemeral')
    })

    it('passes a resolved model and omits the flag when the tool default applies', () => {
        const withModel = invoke({ model: 'gpt-5.3-codex' }).args
        expect(withModel[withModel.indexOf('--model') + 1]).toBe('gpt-5.3-codex')
        expect(invoke({ model: '' }).args).not.toContain('--model')
    })

    it('puts the content on stdin and nothing but flags in argv', () => {
        const invocation = invoke()
        expect(invocation.stdin).toContain(CLI_DOCUMENT_TEXT)
        expect(invocation.args.join(' ')).not.toContain(CLI_DOCUMENT_TEXT)
    })

    it('produces argv the security boundary accepts even with a huge persona', () => {
        const invocation = invoke({ systemPrompt: 'x'.repeat(MAX_ARGUMENT_LENGTH * 4) })
        expect(validateCliArguments(invocation.args).ok).toBe(true)
        expect(invocation.stdin.length).toBeGreaterThan(MAX_ARGUMENT_LENGTH)
    })
})

describe('codexAdapter.parseEnvelope', () => {
    it('returns the agent message from a completed turn', () => {
        const stdout = codexStream([
            CODEX_THREAD_STARTED,
            CODEX_TURN_STARTED,
            codexAgentMessage('{"kind":"review"}'),
            CODEX_TURN_COMPLETED
        ])
        expect(codexAdapter.parseEnvelope(stdout)).toEqual({ ok: true, text: '{"kind":"review"}' })
    })

    it('ignores an error ITEM, which is a warning on a run that then succeeds', () => {
        const stdout = codexStream([
            CODEX_THREAD_STARTED,
            CODEX_WARNING_ITEM,
            CODEX_TURN_STARTED,
            codexAgentMessage('answer'),
            CODEX_TURN_COMPLETED
        ])
        expect(codexAdapter.parseEnvelope(stdout)).toEqual({ ok: true, text: 'answer' })
    })

    it('ignores top-level error lines, which are reconnection attempts', () => {
        const stdout = codexStream([
            CODEX_TURN_STARTED,
            { type: 'error', message: 'Reconnecting... 1/5 (unexpected status 503)' },
            codexAgentMessage('answer'),
            CODEX_TURN_COMPLETED
        ])
        expect(codexAdapter.parseEnvelope(stdout)).toEqual({ ok: true, text: 'answer' })
    })

    it('takes the LAST agent message, because an agent narrates before it concludes', () => {
        const stdout = codexStream([
            codexAgentMessage('Let me look at the document.', 'item_1'),
            codexAgentMessage('{"kind":"review"}', 'item_2'),
            CODEX_TURN_COMPLETED
        ])
        expect(codexAdapter.parseEnvelope(stdout)).toEqual({ ok: true, text: '{"kind":"review"}' })
    })

    it('fails on turn.failed even when a message came first', () => {
        const stdout = codexStream([
            codexAgentMessage('partial answer'),
            { type: 'turn.failed', error: { message: 'unexpected status 404' } }
        ])
        const parsed = codexAdapter.parseEnvelope(stdout)
        expect(parsed.ok).toBe(false)
        expect(parsed.ok === false && parsed.code).toBe('unknown')
    })

    it('never echoes the failure message, which carries the endpoint URL', () => {
        const stdout = codexStream([
            {
                type: 'turn.failed',
                error: {
                    message:
                        'unexpected status 404, url: https://example.invalid/openai/responses?api-key=sk-secret'
                }
            }
        ])
        const parsed = codexAdapter.parseEnvelope(stdout)
        expect(parsed.ok === false && parsed.message).not.toContain('sk-secret')
        expect(parsed.ok === false && parsed.message).not.toContain('example.invalid')
    })

    it('distinguishes a turn that finished silently from one that stopped early', () => {
        const finished = codexAdapter.parseEnvelope(
            codexStream([CODEX_TURN_STARTED, CODEX_TURN_COMPLETED])
        )
        expect(finished.ok === false && finished.message).toContain('finished without producing')
        const stopped = codexAdapter.parseEnvelope(codexStream([CODEX_THREAD_STARTED]))
        expect(stopped.ok === false && stopped.message).toContain('stopped before producing')
    })

    it.each([
        ['a malformed line', '{"type":"turn.started"}\nnot json\n'],
        ['no output', '   '],
        ['a JSON array line', '[]\n']
    ])('refuses %s as invalid output', (_label, stdout) => {
        const parsed = codexAdapter.parseEnvelope(stdout)
        expect(parsed.ok === false && parsed.code).toBe('invalid-output')
    })
})

describe('codexAdapter.capabilities', () => {
    it('reports that tool mode cannot be granted, because Codex cannot run without tools', () => {
        expect(codexAdapter.capabilities()).toEqual({
            streaming: false,
            jsonSchema: false,
            canGrantTools: false
        })
    })
})
