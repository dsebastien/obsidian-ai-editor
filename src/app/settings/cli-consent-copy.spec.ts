import { describe, expect, it } from 'bun:test'
import { cliBackendSchema } from '../domain/settings/settings-schema'
import type { CliBackend } from '../domain/settings/settings-schema'
import {
    cliToolCanGrantTools,
    cliToolName,
    launchConsentCopy,
    launchConsentLine,
    toolsConsentCopy,
    toolsConsentLine,
    toolsUnavailableCopy
} from './cli-consent-copy'

const CLAUDE = '/usr/local/bin/claude'

function backend(overrides: Record<string, unknown> = {}): CliBackend {
    return cliBackendSchema.parse({
        id: 'cli-1',
        family: 'cli',
        kind: 'claude-code',
        label: 'Claude Code',
        executablePath: CLAUDE,
        ...overrides
    })
}

describe('launchConsentCopy', () => {
    it('states what is being agreed to, in the first sentence', () => {
        const copy = launchConsentCopy(backend())
        expect(copy.message).toContain('starts a program on this computer')
        expect(copy.message).toContain('standard input')
        expect(copy.message).toContain('responsible')
    })

    it('names the exact file that will run', () => {
        // Consent is bound to one binary; the dialog has to show which.
        expect(launchConsentCopy(backend()).lines.join('\n')).toContain(CLAUDE)
    })

    it('states the containment AFTER the responsibility, never instead of it', () => {
        const copy = launchConsentCopy(backend())
        const lines = copy.lines.join('\n')
        expect(lines).toContain('temporary folder')
        expect(lines).toContain('minimal environment')
        expect(lines).toContain('withdraw')
        // The reassuring parts are lines; the responsibility is the message.
        expect(copy.message).toContain('responsible for what that program does')
    })

    it('says nothing runs until the user asks', () => {
        expect(launchConsentCopy(backend()).lines.join('\n')).toContain(
            'Nothing runs until you ask'
        )
    })

    it('asks again, differently, when the executable changed', () => {
        const stale = backend({
            executablePath: '/opt/new/claude',
            consent: { launchPath: CLAUDE, toolsPath: CLAUDE }
        })
        const copy = launchConsentCopy(stale)
        expect(copy.title).toContain('new')
        expect(copy.message).toContain('no longer applies')
        expect(copy.lines.join('\n')).toContain('/opt/new/claude')
    })
})

describe('toolsConsentCopy', () => {
    it('leads with the extra reach, not with the containment', () => {
        const copy = toolsConsentCopy(backend())
        expect(copy.message).toContain('read and write files')
        expect(copy.message).toContain('network')
        expect(copy.message).toContain('bigger permission')
    })

    it('says the plugin cannot bound what the tool does with the network', () => {
        expect(toolsConsentCopy(backend()).lines.join('\n')).toContain('cannot see or limit')
    })

    it('says turning it off leaves the backend working', () => {
        expect(toolsConsentCopy(backend()).lines.join('\n')).toContain('leaves the backend working')
    })

    it('is not a reworded copy of the launch dialog', () => {
        const target = backend()
        expect(toolsConsentCopy(target).message).not.toBe(launchConsentCopy(target).message)
        expect(toolsConsentCopy(target).ctaLabel).not.toBe(launchConsentCopy(target).ctaLabel)
    })
})

describe('tool capability honesty', () => {
    it('offers tool consent for Claude Code, which has a real off switch', () => {
        expect(cliToolCanGrantTools(backend())).toBe(true)
    })

    it('does not offer it for Codex, and says why', () => {
        const codex = backend({ kind: 'codex', label: 'Codex' })
        expect(cliToolCanGrantTools(codex)).toBe(false)
        const line = toolsUnavailableCopy(codex)
        expect(line).toContain('how it answers')
        expect(line).toContain('read-only sandbox')
        expect(toolsConsentLine(codex)).toBe(line)
    })

    it('names each tool the way its vendor does', () => {
        expect(cliToolName(backend())).toBe('Claude Code')
        expect(cliToolName(backend({ kind: 'codex' }))).toBe('Codex')
    })
})

describe('settings row lines', () => {
    it('says an unconsented backend is skipped', () => {
        expect(launchConsentLine(backend())).toContain('skipped')
    })

    it('tells a stale consent apart from a missing one', () => {
        const stale = backend({
            executablePath: '/opt/new/claude',
            consent: { launchPath: CLAUDE, toolsPath: '' }
        })
        expect(launchConsentLine(stale)).toContain('changed')
        expect(launchConsentLine(stale)).not.toBe(launchConsentLine(backend()))
    })

    it('reports tool mode as off by default', () => {
        expect(toolsConsentLine(backend())).toContain('Off')
    })

    it('reports tool mode as on once consented', () => {
        const granted = backend({ consent: { launchPath: CLAUDE, toolsPath: CLAUDE } })
        expect(toolsConsentLine(granted)).toContain('On —')
    })

    it('reports tool mode as off when the executable changed under it', () => {
        const stale = backend({
            executablePath: '/opt/new/claude',
            consent: { launchPath: '/opt/new/claude', toolsPath: CLAUDE }
        })
        expect(toolsConsentLine(stale)).toContain('Off')
    })
})
