import { describe, expect, it } from 'bun:test'
import { hasLaunchConsent } from './cli-consent'
import {
    detectHostPlatform,
    foldForPlatform,
    platformPathsHaveConsent,
    platformPathsWithoutConsent,
    projectForPlatform,
    withOtherPlatformPath
} from './cli-platform-paths'
import {
    DEFAULT_PLUGIN_SETTINGS,
    cliBackendSchema,
    loadSettings,
    pluginSettingsSchema,
    type CliBackend,
    type PluginSettingsV1
} from './settings-schema'

const LINUX_PATH = '/home/me/.local/bin/claude'
const WIN_PATH = 'C:/Users/me/.local/bin/claude.exe'

function cli(overrides: Partial<CliBackend> = {}): CliBackend {
    return cliBackendSchema.parse({
        id: 'cli-1',
        family: 'cli',
        kind: 'claude-code',
        label: 'Claude Code',
        executablePath: LINUX_PATH,
        consent: { launchPath: LINUX_PATH, toolsPath: '' },
        enabled: true,
        ...overrides
    })
}

function settingsWith(...backends: CliBackend[]): PluginSettingsV1 {
    return { ...DEFAULT_PLUGIN_SETTINGS, backends }
}

function onlyCli(settings: PluginSettingsV1): CliBackend {
    const backend = settings.backends[0]
    if (backend?.family !== 'cli') throw new Error('expected a CLI backend')
    return backend
}

describe('detectHostPlatform', () => {
    it('maps the Node platform names', () => {
        expect(detectHostPlatform('win32')).toBe('windows')
        expect(detectHostPlatform('linux')).toBe('linux')
        expect(detectHostPlatform('darwin')).toBe('macos')
        expect(detectHostPlatform('freebsd')).toBeNull()
        expect(detectHostPlatform('')).toBeNull()
    })
})

describe('schema compatibility', () => {
    it('a CLI backend saved before per-system paths loads with empty slots', () => {
        const loaded = loadSettings({
            schemaVersion: 1,
            backends: [
                {
                    id: 'cli-1',
                    family: 'cli',
                    kind: 'codex',
                    label: 'Codex',
                    executablePath: LINUX_PATH,
                    consent: { launchPath: LINUX_PATH, toolsPath: '' },
                    enabled: true
                }
            ]
        })
        const backend = onlyCli(loaded)
        expect(backend.platformPaths).toEqual({ windows: null, linux: null, macos: null })
        expect(backend.executablePath).toBe(LINUX_PATH)
    })
})

describe('projectForPlatform', () => {
    it('without a slot, this system uses the shared path and consent', () => {
        const { settings } = projectForPlatform(settingsWith(cli()), 'windows')
        const backend = onlyCli(settings)
        expect(backend.executablePath).toBe(LINUX_PATH)
        expect(backend.consent.launchPath).toBe(LINUX_PATH)
    })

    it('with a slot, this system uses its own path and consent, and the slot is cleared in memory', () => {
        const stored = cli({
            platformPaths: {
                windows: {
                    executablePath: WIN_PATH,
                    consent: { launchPath: WIN_PATH, toolsPath: WIN_PATH }
                },
                linux: null,
                macos: null
            }
        })
        const { settings } = projectForPlatform(settingsWith(stored), 'windows')
        const backend = onlyCli(settings)
        expect(backend.executablePath).toBe(WIN_PATH)
        expect(backend.consent).toEqual({ launchPath: WIN_PATH, toolsPath: WIN_PATH })
        expect(backend.platformPaths.windows).toBeNull()
        expect(hasLaunchConsent(backend)).toBe(true)
        expect(pluginSettingsSchema.safeParse(settings).success).toBe(true)
    })

    it('a slot with an empty path falls back to the shared values', () => {
        const stored = cli({
            platformPaths: {
                windows: { executablePath: '  ', consent: { launchPath: '', toolsPath: '' } },
                linux: null,
                macos: null
            }
        })
        const backend = onlyCli(projectForPlatform(settingsWith(stored), 'windows').settings)
        expect(backend.executablePath).toBe(LINUX_PATH)
    })

    it('an unknown system leaves the settings untouched', () => {
        const input = settingsWith(cli())
        expect(projectForPlatform(input, null).settings).toBe(input)
    })

    it('leaves API backends alone', () => {
        const input = loadSettings({
            backends: [{ id: 'api-1', family: 'api', kind: 'openai', label: 'OpenAI' }]
        })
        const { settings, shared } = projectForPlatform(input, 'linux')
        expect(settings.backends).toEqual(input.backends)
        expect(shared.size).toBe(0)
    })
})

describe('foldForPlatform', () => {
    it('an untouched backend saves exactly as it was loaded', () => {
        const stored = settingsWith(cli())
        const { settings, shared } = projectForPlatform(stored, 'windows')
        expect(foldForPlatform(settings, 'windows', shared)).toEqual(stored)
    })

    it('a path set on this system goes into its slot; the shared values stay', () => {
        const { settings, shared } = projectForPlatform(settingsWith(cli()), 'windows')
        const edited: PluginSettingsV1 = {
            ...settings,
            backends: [
                {
                    ...onlyCli(settings),
                    executablePath: WIN_PATH,
                    consent: { launchPath: WIN_PATH, toolsPath: '' }
                }
            ]
        }
        const saved = onlyCli(foldForPlatform(edited, 'windows', shared))
        expect(saved.executablePath).toBe(LINUX_PATH)
        expect(saved.consent).toEqual({ launchPath: LINUX_PATH, toolsPath: '' })
        expect(saved.platformPaths.windows).toEqual({
            executablePath: WIN_PATH,
            consent: { launchPath: WIN_PATH, toolsPath: '' }
        })

        // The other system still sees its own path and its own consent.
        const onLinux = onlyCli(projectForPlatform(settingsWith(saved), 'linux').settings)
        expect(onLinux.executablePath).toBe(LINUX_PATH)
        expect(hasLaunchConsent(onLinux)).toBe(true)
        // And this system gets its value back after a reload.
        const onWindows = onlyCli(projectForPlatform(settingsWith(saved), 'windows').settings)
        expect(onWindows.executablePath).toBe(WIN_PATH)
    })

    it('a consent given on one system never travels to the other', () => {
        const stored = cli({ consent: { launchPath: '', toolsPath: '' } })
        const { settings, shared } = projectForPlatform(settingsWith(stored), 'linux')
        const granted: PluginSettingsV1 = {
            ...settings,
            backends: [{ ...onlyCli(settings), consent: { launchPath: LINUX_PATH, toolsPath: '' } }]
        }
        const saved = onlyCli(foldForPlatform(granted, 'linux', shared))
        expect(saved.consent.launchPath).toBe('')
        expect(saved.platformPaths.linux?.consent.launchPath).toBe(LINUX_PATH)
        const onWindows = onlyCli(projectForPlatform(settingsWith(saved), 'windows').settings)
        expect(hasLaunchConsent(onWindows)).toBe(false)
    })

    it('keeps the slots of other systems edited from this device', () => {
        const { settings, shared } = projectForPlatform(settingsWith(cli()), 'linux')
        const edited: PluginSettingsV1 = {
            ...settings,
            backends: [withOtherPlatformPath(onlyCli(settings), 'windows', WIN_PATH)]
        }
        const saved = onlyCli(foldForPlatform(edited, 'linux', shared))
        expect(saved.platformPaths.windows?.executablePath).toBe(WIN_PATH)
        expect(saved.platformPaths.linux).toBeNull()
    })

    it('a backend created in this session is written as it is (its values become shared)', () => {
        const { settings, shared } = projectForPlatform(settingsWith(), 'windows')
        const created: PluginSettingsV1 = {
            ...settings,
            backends: [
                cli({ executablePath: WIN_PATH, consent: { launchPath: WIN_PATH, toolsPath: '' } })
            ]
        }
        const saved = onlyCli(foldForPlatform(created, 'windows', shared))
        expect(saved.executablePath).toBe(WIN_PATH)
        expect(saved.platformPaths.windows).toBeNull()
    })
})

describe('withOtherPlatformPath', () => {
    it('never gives a consent to a new path', () => {
        const backend = withOtherPlatformPath(cli(), 'windows', ` ${WIN_PATH} `)
        expect(backend.platformPaths.windows).toEqual({
            executablePath: WIN_PATH,
            consent: { launchPath: '', toolsPath: '' }
        })
    })

    it('keeps the consent when the same path is set again', () => {
        const withConsent = cli({
            platformPaths: {
                windows: {
                    executablePath: WIN_PATH,
                    consent: { launchPath: WIN_PATH, toolsPath: '' }
                },
                linux: null,
                macos: null
            }
        })
        const backend = withOtherPlatformPath(withConsent, 'windows', WIN_PATH)
        expect(backend.platformPaths.windows?.consent.launchPath).toBe(WIN_PATH)
    })

    it('an empty path removes the slot', () => {
        const backend = withOtherPlatformPath(
            withOtherPlatformPath(cli(), 'macos', '/x'),
            'macos',
            ' '
        )
        expect(backend.platformPaths.macos).toBeNull()
    })
})

describe('consent in exported or imported files', () => {
    it('strips the consent of every slot and keeps the paths', () => {
        const backend = cli({
            platformPaths: {
                windows: {
                    executablePath: WIN_PATH,
                    consent: { launchPath: WIN_PATH, toolsPath: WIN_PATH }
                },
                linux: null,
                macos: null
            }
        })
        expect(platformPathsHaveConsent(backend)).toBe(true)
        const stripped = { ...backend, platformPaths: platformPathsWithoutConsent(backend) }
        expect(platformPathsHaveConsent(stripped)).toBe(false)
        expect(stripped.platformPaths.windows?.executablePath).toBe(WIN_PATH)
    })
})
