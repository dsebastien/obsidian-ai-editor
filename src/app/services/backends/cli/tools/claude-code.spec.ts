import { describe, expect, it } from 'bun:test'
import { MAX_ARGUMENT_LENGTH, validateCliArguments } from '../spawn'
import { claudeCodeAdapter } from './claude-code'
import type { CliEnvelopeErrorCode } from './types'
import {
    CLI_DOCUMENT_TEXT,
    claudeErrorEnvelope,
    claudeSuccessEnvelope,
    cliReviewOperation,
    makeCliConfig,
    makeConsentedCliConfig
} from './spec-fixtures'

function invoke(overrides: { model?: string; allowTools?: boolean; systemPrompt?: string } = {}) {
    return claudeCodeAdapter.buildInvocation({
        operation: cliReviewOperation(),
        systemPrompt: overrides.systemPrompt ?? 'You are the Concision Editor.',
        model: overrides.model ?? '',
        config: makeConsentedCliConfig({
            kind: 'claude-code',
            tools: overrides.allowTools ?? false
        })
    })
}

describe('claudeCodeAdapter.buildInvocation', () => {
    it('emits the verified headless argv', () => {
        expect(invoke().args).toEqual([
            '--print',
            '--output-format',
            'json',
            '--no-session-persistence',
            '--strict-mcp-config',
            '--permission-mode',
            'manual',
            '--tools',
            ''
        ])
    })

    it('reads the JSON document protocol', () => {
        expect(invoke().protocol).toBe('json-document')
    })

    it('disables every tool while consent is off (the default)', () => {
        const args = invoke().args
        expect(args).toContain('--tools')
        expect(args[args.indexOf('--tools') + 1]).toBe('')
    })

    it('keeps the variadic --tools flag last, so nothing can be swallowed by it', () => {
        const args = invoke({ model: 'sonnet' }).args
        expect(args[args.length - 2]).toBe('--tools')
        expect(args[args.length - 1]).toBe('')
    })

    it('omits --tools only when the backend consented to tools', () => {
        expect(invoke({ allowTools: true }).args).not.toContain('--tools')
    })

    it('disables tools when the tool-consent record names a different binary', () => {
        // The stale-consent case: the user consented for one executable and
        // the path was changed afterwards. Tools must go back off, not stay on.
        const stale = claudeCodeAdapter.buildInvocation({
            operation: cliReviewOperation(),
            systemPrompt: 'You are the Concision Editor.',
            model: '',
            config: makeCliConfig({
                kind: 'claude-code',
                executablePath: '/opt/new/claude',
                consent: { launchPath: '/usr/local/bin/claude', toolsPath: '/usr/local/bin/claude' }
            })
        })
        expect(stale.args).toContain('--tools')
    })

    it('disables tools when tool consent exists without launch consent', () => {
        const orphaned = claudeCodeAdapter.buildInvocation({
            operation: cliReviewOperation(),
            systemPrompt: 'You are the Concision Editor.',
            model: '',
            config: makeCliConfig({
                kind: 'claude-code',
                consent: { launchPath: '', toolsPath: '/usr/local/bin/claude' }
            })
        })
        expect(orphaned.args).toContain('--tools')
    })

    it('never widens permissions, whatever the consent', () => {
        for (const allowTools of [false, true]) {
            const args = invoke({ allowTools }).args
            expect(args).not.toContain('--dangerously-skip-permissions')
            expect(args).not.toContain('--allow-dangerously-skip-permissions')
            expect(args).not.toContain('--add-dir')
            expect(args).not.toContain('--mcp-config')
            expect(args).not.toContain('--settings')
            expect(args).not.toContain('bypassPermissions')
            expect(args).toContain('manual')
        }
    })

    it('keeps the session off disk on every path (the note must not be persisted)', () => {
        for (const allowTools of [false, true]) {
            expect(invoke({ allowTools }).args).toContain('--no-session-persistence')
        }
    })

    it('passes a resolved model and omits the flag when the tool default applies', () => {
        const withModel = invoke({ model: 'claude-fable-5' }).args
        expect(withModel[withModel.indexOf('--model') + 1]).toBe('claude-fable-5')
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

describe('claudeCodeAdapter.parseEnvelope', () => {
    it('returns the model message from a successful envelope', () => {
        const parsed = claudeCodeAdapter.parseEnvelope(claudeSuccessEnvelope('{"kind":"review"}'))
        expect(parsed).toEqual({ ok: true, text: '{"kind":"review"}' })
    })

    it('trusts is_error over subtype, which still reads "success" on failures', () => {
        const parsed = claudeCodeAdapter.parseEnvelope(claudeErrorEnvelope(404))
        expect(parsed.ok).toBe(false)
    })

    it.each<[number, CliEnvelopeErrorCode]>([
        [401, 'auth'],
        [403, 'auth'],
        [429, 'rate-limit'],
        [500, 'network'],
        [503, 'network'],
        [400, 'unknown']
    ])('maps HTTP %i to the %s code', (status, code) => {
        const parsed = claudeCodeAdapter.parseEnvelope(claudeErrorEnvelope(status))
        expect(parsed.ok === false && parsed.code).toBe(code)
    })

    it("never echoes the tool's error text, which quotes back configuration", () => {
        const parsed = claudeCodeAdapter.parseEnvelope(claudeErrorEnvelope(404))
        expect(parsed.ok === false && parsed.message).not.toContain('no-such-model-xyz')
        expect(parsed.ok === false && parsed.message).toContain('404')
    })

    it('reports a sanitized terminal reason when there is no HTTP status', () => {
        const parsed = claudeCodeAdapter.parseEnvelope(claudeErrorEnvelope(null, 'max_turns'))
        expect(parsed.ok === false && parsed.message).toContain('max_turns')
    })

    it('classifies not-logged-in as auth with the /login fix in the message (issue #39)', () => {
        // Field-observed on 2.1.220: no structured marker at all —
        // terminal_reason is the generic 'api_error', api_error_status is
        // null, and the failure is named only in the free-text result. The
        // result is sniffed for classification; the message echoes none of it.
        const envelope = JSON.stringify({
            type: 'result',
            subtype: 'success',
            is_error: true,
            terminal_reason: 'api_error',
            api_error_status: null,
            result: 'Not logged in · Please run /login',
            session_id: 'secret-session-1401ec1c'
        })
        const parsed = claudeCodeAdapter.parseEnvelope(envelope)
        expect(parsed.ok).toBe(false)
        expect(parsed.ok === false && parsed.code).toBe('auth')
        expect(parsed.ok === false && parsed.message).toContain('/login')
        expect(parsed.ok === false && parsed.message).not.toContain('secret-session')
    })

    it('drops a terminal reason that does not look like a status token', () => {
        const parsed = claudeCodeAdapter.parseEnvelope(
            claudeErrorEnvelope(null, 'sk-live-abcdef0123456789 leaked into the reason')
        )
        expect(parsed.ok === false && parsed.message).toBe('The Claude Code CLI reported an error.')
    })

    it.each([
        ['not JSON at all', 'not json'],
        ['a JSON array', '[]'],
        ['no output', '   '],
        ['a foreign envelope', '{"type":"assistant"}'],
        ['a result envelope with no message', '{"type":"result","is_error":false}']
    ])('refuses %s as invalid output', (_label, stdout) => {
        const parsed = claudeCodeAdapter.parseEnvelope(stdout)
        expect(parsed.ok === false && parsed.code).toBe('invalid-output')
    })
})

describe('claudeCodeAdapter.capabilities', () => {
    it('claims no streaming and no server-side schema, and can grant tools', () => {
        expect(claudeCodeAdapter.capabilities()).toEqual({
            streaming: false,
            jsonSchema: false,
            canGrantTools: true
        })
    })
})
