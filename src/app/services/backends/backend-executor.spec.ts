import { describe, expect, it } from 'bun:test'
import { CONTRACT_VERSION } from '../../domain/operations/contract'
import type { OperationEvent, OperationRequest } from '../../domain/operations/contract'
import {
    DEFAULT_PLUGIN_SETTINGS,
    apiBackendSchema,
    cliBackendSchema,
    type ApiBackend,
    type CliBackend
} from '../../domain/settings/settings-schema'
import {
    backendTimeoutMs,
    createBackendExecutor,
    resolvedBackendLabel,
    reviewTimeoutMs
} from './backend-executor'

const API_KEY = 'sk-secret-value'
const behavior = DEFAULT_PLUGIN_SETTINGS.behavior

function apiBackend(): ApiBackend {
    return apiBackendSchema.parse({
        id: 'api-1',
        family: 'api',
        kind: 'anthropic',
        label: 'Anthropic',
        apiKey: API_KEY,
        defaultModel: 'claude-test-1'
    })
}

function cliBackend(overrides: Record<string, unknown> = {}): CliBackend {
    return cliBackendSchema.parse({
        id: 'cli-1',
        family: 'cli',
        kind: 'claude-code',
        label: 'Claude Code',
        executablePath: '/usr/local/bin/claude',
        consent: { launchPath: '/usr/local/bin/claude', toolsPath: '' },
        enabled: true,
        ...overrides
    })
}

function operation(): OperationRequest {
    return {
        contractVersion: CONTRACT_VERSION,
        runId: 'run-1',
        snapshotHash: 'hash-1',
        kind: 'review',
        text: 'A sentence to review.'
    }
}

describe('backendTimeoutMs', () => {
    it('gives an API backend the behavior-level request timeout', () => {
        expect(reviewTimeoutMs(behavior)).toBe(behavior.requestTimeoutSeconds * 1_000)
        expect(backendTimeoutMs(apiBackend(), behavior)).toBe(reviewTimeoutMs(behavior))
    })

    it('gives a CLI backend its own budget instead', () => {
        // An agent CLI is slower than a chat completion by an order of
        // magnitude; sharing one number would cut one of them off.
        const backend = cliBackend({ timeoutSeconds: 900 })
        expect(backendTimeoutMs(backend, behavior)).toBe(900_000)
        expect(backendTimeoutMs(backend, { ...behavior, requestTimeoutSeconds: 10 })).toBe(900_000)
    })
})

describe('resolvedBackendLabel', () => {
    it('names the model when there is one', () => {
        expect(resolvedBackendLabel(apiBackend(), 'claude-test-1')).toBe(
            'Anthropic (claude-test-1)'
        )
    })

    it('says "tool default" rather than rendering empty brackets', () => {
        expect(resolvedBackendLabel(cliBackend(), '')).toBe('Claude Code (tool default)')
    })
})

describe('createBackendExecutor', () => {
    it('redacts the key of an API backend', () => {
        const executor = createBackendExecutor({
            backend: apiBackend(),
            model: 'claude-test-1',
            systemPrompt: 'Be harsh.',
            behavior,
            fetchImpl: globalThis.fetch
        })
        expect(executor.redactError(`401 echoing ${API_KEY}`)).toBe('401 echoing [redacted]')
    })

    it('leaves a CLI backend message alone — there is no key of ours in it', () => {
        const executor = createBackendExecutor({
            backend: cliBackend(),
            model: '',
            systemPrompt: 'Be harsh.',
            behavior,
            fetchImpl: globalThis.fetch
        })
        expect(executor.redactError('The tool exited with status 1.')).toBe(
            'The tool exited with status 1.'
        )
    })

    it('returns a CLI executor that honors the contract without a binary present', async () => {
        // The path is bogus on purpose: the boundary refuses it before any
        // process is created, and the run still ends in exactly one terminal
        // event — which is the property every dispatch surface relies on.
        const executor = createBackendExecutor({
            backend: cliBackend({
                executablePath: '/definitely/not/here/claude',
                consent: { launchPath: '/definitely/not/here/claude', toolsPath: '' }
            }),
            model: '',
            systemPrompt: 'Be harsh.',
            behavior,
            fetchImpl: globalThis.fetch
        })
        const events: OperationEvent[] = []
        for await (const event of executor.execute(operation(), new AbortController().signal)) {
            events.push(event)
        }
        expect(events).toHaveLength(1)
        const terminal = events[0]
        if (terminal?.type !== 'error') {
            throw new Error('expected a terminal error event')
        }
        expect(terminal.runId).toBe('run-1')
        expect(terminal.error.message).toContain('/definitely/not/here/claude')
    })

    it('refuses a CLI backend the user has not allowed to launch — before the boundary', async () => {
        // The proof that the refusal comes first: the executable path is one
        // the boundary would reject on its own. If consent were checked later
        // (or only by the review path, or only by a dialog), the message would
        // be about the missing file rather than about the missing permission —
        // which would mean the process seam had already been reached.
        const executor = createBackendExecutor({
            backend: cliBackend({
                executablePath: '/definitely/not/here/claude',
                consent: { launchPath: '', toolsPath: '' }
            }),
            model: '',
            systemPrompt: 'Be harsh.',
            behavior,
            fetchImpl: globalThis.fetch
        })
        const events: OperationEvent[] = []
        for await (const event of executor.execute(operation(), new AbortController().signal)) {
            events.push(event)
        }
        expect(events).toHaveLength(1)
        const terminal = events[0]
        if (terminal?.type !== 'error') {
            throw new Error('expected a terminal error event')
        }
        expect(terminal.error.message).toContain('has not been allowed to run')
        expect(terminal.error.message).not.toContain('/definitely/not/here/claude')
    })

    it('refuses a CLI backend whose consent names a DIFFERENT executable', async () => {
        const executor = createBackendExecutor({
            backend: cliBackend({
                executablePath: '/usr/local/bin/claude',
                consent: { launchPath: '/opt/homebrew/bin/claude', toolsPath: '' }
            }),
            model: '',
            systemPrompt: 'Be harsh.',
            behavior,
            fetchImpl: globalThis.fetch
        })
        const events: OperationEvent[] = []
        for await (const event of executor.execute(operation(), new AbortController().signal)) {
            events.push(event)
        }
        expect(events).toHaveLength(1)
        expect(events[0]?.type === 'error' && events[0].error.message).toContain(
            'has not been allowed to run'
        )
    })

    it('never starts a process for an aborted CLI run', async () => {
        const controller = new AbortController()
        controller.abort()
        const executor = createBackendExecutor({
            backend: cliBackend(),
            model: '',
            systemPrompt: 'Be harsh.',
            behavior,
            fetchImpl: globalThis.fetch
        })
        const events: OperationEvent[] = []
        for await (const event of executor.execute(operation(), controller.signal)) {
            events.push(event)
        }
        expect(events).toEqual([
            {
                type: 'error',
                runId: 'run-1',
                error: { code: 'cancelled', message: 'Run cancelled' }
            }
        ])
    })
})
