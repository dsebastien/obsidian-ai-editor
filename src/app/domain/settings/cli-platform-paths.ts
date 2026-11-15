import type {
    BackendInstance,
    CliBackend,
    CliConsent,
    CliPlatformSlot,
    PluginSettingsV1
} from './settings-schema'

/**
 * Per-system CLI executables (issue #63), applied at the persistence boundary.
 *
 * On disk, a CLI backend holds a shared `executablePath` / `consent` (what a
 * system without a slot of its own uses, and what older plugin versions read)
 * plus one optional slot per system in `platformPaths`.
 *
 * In memory, the plugin works with a PROJECTION for the system it runs on:
 * `executablePath` / `consent` hold this system's effective values and this
 * system's slot is `null`. Every consumer (backend resolution, the executor,
 * the consent dialogs, validation) keeps reading `executablePath` / `consent`
 * and needs no knowledge of other systems. On save, `foldForPlatform` writes
 * the in-memory values back into this system's slot and restores the shared
 * values as they were loaded.
 *
 * Consent stays bound to the path of its own slot: a consent given on Linux
 * is stored in the Linux slot and never authorizes a binary on Windows
 * (Business Rules #9).
 *
 * Pure and Obsidian-free.
 */
export type HostPlatform = 'windows' | 'linux' | 'macos'

export const HOST_PLATFORMS: readonly HostPlatform[] = ['windows', 'linux', 'macos']

export const PLATFORM_LABELS: Record<HostPlatform, string> = {
    windows: 'Windows',
    linux: 'Linux',
    macos: 'macOS'
}

/** Maps `process.platform` to a system; `null` for anything else. */
export function detectHostPlatform(nodePlatform: string): HostPlatform | null {
    switch (nodePlatform) {
        case 'win32':
            return 'windows'
        case 'linux':
            return 'linux'
        case 'darwin':
            return 'macos'
        default:
            return null
    }
}

/** The shared values of each CLI backend as they were on disk, by backend id. */
export type SharedCliValues = ReadonlyMap<string, CliPlatformSlot>

function sameConsent(a: CliConsent, b: CliConsent): boolean {
    return a.launchPath === b.launchPath && a.toolsPath === b.toolsPath
}

function sameSlot(a: CliPlatformSlot, b: CliPlatformSlot): boolean {
    return a.executablePath === b.executablePath && sameConsent(a.consent, b.consent)
}

function copySlot(slot: CliPlatformSlot): CliPlatformSlot {
    return { executablePath: slot.executablePath, consent: { ...slot.consent } }
}

function projectBackend(backend: CliBackend, platform: HostPlatform): CliBackend {
    const own = backend.platformPaths[platform]
    const active = own !== null && own.executablePath.trim().length > 0 ? own : backend
    return {
        ...backend,
        executablePath: active.executablePath,
        consent: { ...active.consent },
        platformPaths: { ...backend.platformPaths, [platform]: null }
    }
}

/**
 * The in-memory projection of persisted settings for `platform`, and the
 * shared values to restore on save. With `null` (an unknown system), the
 * settings are returned unchanged and every backend uses its shared values.
 */
export function projectForPlatform(
    settings: PluginSettingsV1,
    platform: HostPlatform | null
): { settings: PluginSettingsV1; shared: SharedCliValues } {
    const shared = new Map<string, CliPlatformSlot>()
    if (platform === null) {
        return { settings, shared }
    }
    const backends = settings.backends.map((backend): BackendInstance => {
        if (backend.family !== 'cli') return backend
        shared.set(backend.id, copySlot(backend))
        return projectBackend(backend, platform)
    })
    return { settings: { ...settings, backends }, shared }
}

/**
 * The persisted form of in-memory settings: this system's values go back into
 * its slot (or the slot stays empty when they equal the shared values), and
 * the shared values are restored from `shared`.
 *
 * A backend `shared` does not know (created or imported in this session) is
 * written as it is: its values become the shared ones, so a backend added on
 * one device is visible to the others, as before issue #63.
 */
export function foldForPlatform(
    settings: PluginSettingsV1,
    platform: HostPlatform | null,
    shared: SharedCliValues
): PluginSettingsV1 {
    if (platform === null) return settings
    const backends = settings.backends.map((backend): BackendInstance => {
        if (backend.family !== 'cli') return backend
        const base = shared.get(backend.id)
        if (base === undefined) return backend
        const active: CliPlatformSlot = {
            executablePath: backend.executablePath,
            consent: { ...backend.consent }
        }
        return {
            ...backend,
            executablePath: base.executablePath,
            consent: { ...base.consent },
            platformPaths: {
                ...backend.platformPaths,
                [platform]: sameSlot(active, base) ? null : active
            }
        }
    })
    return { ...settings, backends }
}

/**
 * Sets the executable of another system from this device. Consent is never
 * carried over to a new path (it must be given on that system, about the
 * binary that is actually there); an empty path removes the slot, so that
 * system uses the shared value again.
 */
export function withOtherPlatformPath(
    backend: CliBackend,
    platform: HostPlatform,
    executablePath: string
): CliBackend {
    const path = executablePath.trim()
    const current = backend.platformPaths[platform]
    if (path.length === 0) {
        return { ...backend, platformPaths: { ...backend.platformPaths, [platform]: null } }
    }
    const consent: CliConsent =
        current !== null && current.executablePath.trim() === path
            ? { ...current.consent }
            : { launchPath: '', toolsPath: '' }
    return {
        ...backend,
        platformPaths: { ...backend.platformPaths, [platform]: { executablePath: path, consent } }
    }
}

/** Every slot without consent: for exports and imports (Business Rules #9). */
export function platformPathsWithoutConsent(backend: CliBackend): CliBackend['platformPaths'] {
    const strip = (slot: CliPlatformSlot | null): CliPlatformSlot | null =>
        slot === null
            ? null
            : { executablePath: slot.executablePath, consent: { launchPath: '', toolsPath: '' } }
    return {
        windows: strip(backend.platformPaths.windows),
        linux: strip(backend.platformPaths.linux),
        macos: strip(backend.platformPaths.macos)
    }
}

/** Whether any slot carries a consent (for the import adjustment report). */
export function platformPathsHaveConsent(backend: CliBackend): boolean {
    return HOST_PLATFORMS.some((platform) => {
        const slot = backend.platformPaths[platform]
        return (
            slot !== null &&
            (slot.consent.launchPath.length > 0 || slot.consent.toolsPath.length > 0)
        )
    })
}
