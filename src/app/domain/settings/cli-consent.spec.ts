import { describe, expect, it } from 'bun:test'
import {
    consentForPath,
    grantLaunchConsent,
    grantToolsConsent,
    hasLaunchConsent,
    hasToolsConsent,
    launchConsentState,
    revokeLaunchConsent,
    revokeToolsConsent,
    toolsConsentState
} from './cli-consent'
import { cliBackendSchema } from './settings-schema'
import type { CliBackend } from './settings-schema'

const CLAUDE = '/usr/local/bin/claude'
const OTHER = '/opt/homebrew/bin/claude'

function backend(overrides: Partial<CliBackend> = {}): CliBackend {
    return cliBackendSchema.parse({
        id: 'cli-1',
        family: 'cli',
        kind: 'claude-code',
        label: 'Claude Code',
        executablePath: CLAUDE,
        ...overrides
    })
}

describe('cliBackendSchema consent defaults', () => {
    it('defaults to no consent and disabled', () => {
        const parsed = backend()
        expect(parsed.consent).toEqual({ launchPath: '', toolsPath: '' })
        expect(parsed.enabled).toBe(false)
    })
})

describe('hasLaunchConsent', () => {
    it('is false without a recorded path', () => {
        expect(hasLaunchConsent(backend())).toBe(false)
    })

    it('is true when the recorded path is the configured one', () => {
        expect(hasLaunchConsent(backend({ consent: { launchPath: CLAUDE, toolsPath: '' } }))).toBe(
            true
        )
    })

    it('is false when the executable was changed after consent', () => {
        const changed = backend({
            executablePath: OTHER,
            consent: { launchPath: CLAUDE, toolsPath: CLAUDE }
        })
        expect(hasLaunchConsent(changed)).toBe(false)
        expect(hasToolsConsent(changed)).toBe(false)
    })

    it('never treats an unconfigured executable as consented', () => {
        // '' is also the "not granted" marker: an empty-vs-empty match must not
        // read as consent to run nothing.
        expect(
            hasLaunchConsent(
                backend({ executablePath: '', consent: { launchPath: '', toolsPath: '' } })
            )
        ).toBe(false)
    })

    it('compares trimmed paths, like the boundary does', () => {
        expect(
            hasLaunchConsent(
                backend({
                    executablePath: `  ${CLAUDE} `,
                    consent: { launchPath: CLAUDE, toolsPath: '' }
                })
            )
        ).toBe(true)
    })
})

describe('hasToolsConsent', () => {
    it('requires launch consent as well', () => {
        const toolsOnly = backend({ consent: { launchPath: '', toolsPath: CLAUDE } })
        expect(hasToolsConsent(toolsOnly)).toBe(false)
    })

    it('is true only when both name the configured executable', () => {
        expect(
            hasToolsConsent(backend({ consent: { launchPath: CLAUDE, toolsPath: CLAUDE } }))
        ).toBe(true)
        expect(
            hasToolsConsent(backend({ consent: { launchPath: CLAUDE, toolsPath: OTHER } }))
        ).toBe(false)
    })

    it('defaults to off on a freshly consented backend', () => {
        const granted = backend()
        expect(hasToolsConsent({ ...granted, consent: grantLaunchConsent(granted) })).toBe(false)
    })
})

describe('consent states', () => {
    it('tells a missing consent apart from a stale one', () => {
        expect(launchConsentState(backend())).toBe('missing')
        expect(
            launchConsentState(backend({ consent: { launchPath: CLAUDE, toolsPath: '' } }))
        ).toBe('granted')
        expect(
            launchConsentState(
                backend({ executablePath: OTHER, consent: { launchPath: CLAUDE, toolsPath: '' } })
            )
        ).toBe('stale')
    })

    it('does the same for tool consent', () => {
        expect(toolsConsentState(backend())).toBe('missing')
        expect(
            toolsConsentState(backend({ consent: { launchPath: CLAUDE, toolsPath: CLAUDE } }))
        ).toBe('granted')
        expect(
            toolsConsentState(
                backend({
                    executablePath: OTHER,
                    consent: { launchPath: OTHER, toolsPath: CLAUDE }
                })
            )
        ).toBe('stale')
    })
})

describe('granting and revoking', () => {
    it('grants launch consent for the current path only', () => {
        const target = backend()
        expect(grantLaunchConsent(target)).toEqual({ launchPath: CLAUDE, toolsPath: '' })
    })

    it('refuses to record tool consent without launch consent', () => {
        const target = backend()
        expect(grantToolsConsent(target)).toEqual({ launchPath: '', toolsPath: '' })
    })

    it('records tool consent on top of launch consent', () => {
        const target = backend({ consent: { launchPath: CLAUDE, toolsPath: '' } })
        expect(grantToolsConsent(target)).toEqual({ launchPath: CLAUDE, toolsPath: CLAUDE })
    })

    it('revoking tool consent leaves the backend runnable', () => {
        const target = backend({ consent: { launchPath: CLAUDE, toolsPath: CLAUDE } })
        const consent = revokeToolsConsent(target)
        expect(consent).toEqual({ launchPath: CLAUDE, toolsPath: '' })
        expect(hasLaunchConsent({ ...target, consent })).toBe(true)
        expect(hasToolsConsent({ ...target, consent })).toBe(false)
    })

    it('revoking launch consent takes tool consent with it', () => {
        // Otherwise a later re-grant of launch consent would silently restore
        // tool mode the user never re-approved.
        expect(revokeLaunchConsent()).toEqual({ launchPath: '', toolsPath: '' })
    })
})

describe('consentForPath', () => {
    it('keeps consent that names the path', () => {
        expect(consentForPath({ launchPath: CLAUDE, toolsPath: CLAUDE }, CLAUDE)).toEqual({
            launchPath: CLAUDE,
            toolsPath: CLAUDE
        })
    })

    it('drops consent that names a different binary', () => {
        expect(consentForPath({ launchPath: CLAUDE, toolsPath: CLAUDE }, OTHER)).toEqual({
            launchPath: '',
            toolsPath: ''
        })
    })

    it('drops everything when the path is cleared', () => {
        expect(consentForPath({ launchPath: CLAUDE, toolsPath: CLAUDE }, '   ')).toEqual({
            launchPath: '',
            toolsPath: ''
        })
    })
})
