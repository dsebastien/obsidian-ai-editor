import type { CliBackend, CliConsent } from './settings-schema'

/**
 * The two-step consent a CLI backend needs before it may run, and the only
 * module allowed to change it (Business Rules #9, plan M7).
 *
 * Spawning a local program from a note-taking app is the highest-risk thing
 * this plugin does, so consent is modelled as a fact about a SPECIFIC binary
 * rather than as a preference:
 *
 * 1. **Launch consent** — the user was told, in plain words, that using this
 *    backend starts a program on their computer with their note content on its
 *    standard input, and said yes. Without it the backend never runs, however
 *    `enabled` reads.
 * 2. **Tool consent** — a second, stronger act: the agent may read and write
 *    files and reach the network on the user's behalf. Default off, granted
 *    separately, and revocable on its own — revoking it leaves the backend
 *    perfectly usable, just without tools.
 *
 * Both are stored as the executable path they were granted for
 * (`cliConsentSchema`), which makes three otherwise-invisible situations safe
 * by construction: the path is edited afterwards, a settings import brings a
 * different one, or a synced `data.json` merges another machine's. In every
 * case the recorded path stops matching and the backend reads as
 * not-consented, so the user is asked again about the program that is actually
 * there. A boolean could not tell those apart from the consent it was given.
 *
 * Pure and Obsidian-free: the dialogs decide when to ask, this decides what
 * the answer means.
 */

/** Comparison form of a configured path (the same trim the boundary applies). */
function normalizePath(value: string): string {
    return value.trim()
}

/**
 * Whether the user consented to launching THIS backend's current executable.
 *
 * An empty configured path can never match, because `''` is also the "not
 * granted" marker — a backend with no executable configured is never
 * consented, which is the answer we want anyway.
 */
export function hasLaunchConsent(backend: CliBackend): boolean {
    const path = normalizePath(backend.executablePath)
    return path.length > 0 && normalizePath(backend.consent.launchPath) === path
}

/**
 * Whether tool/research mode is granted for this backend's current executable.
 *
 * Requires launch consent as well: permission to let an agent touch files and
 * the network is meaningless — and would be actively dangerous to honor — if
 * the permission to start the process at all is missing or stale.
 */
export function hasToolsConsent(backend: CliBackend): boolean {
    if (!hasLaunchConsent(backend)) {
        return false
    }
    const path = normalizePath(backend.executablePath)
    return normalizePath(backend.consent.toolsPath) === path
}

/**
 * What the settings UI has to say about a backend's consent state.
 *
 * `stale` is deliberately distinct from `missing`: the user DID consent, to a
 * different binary, and telling them that is the difference between "confirm
 * this" and "you changed the executable — confirm the new one".
 */
export type ConsentState = 'granted' | 'missing' | 'stale'

export function launchConsentState(backend: CliBackend): ConsentState {
    if (hasLaunchConsent(backend)) {
        return 'granted'
    }
    return normalizePath(backend.consent.launchPath).length > 0 ? 'stale' : 'missing'
}

export function toolsConsentState(backend: CliBackend): ConsentState {
    if (hasToolsConsent(backend)) {
        return 'granted'
    }
    return normalizePath(backend.consent.toolsPath).length > 0 ? 'stale' : 'missing'
}

/** Grants launch consent for the backend's current executable path. */
export function grantLaunchConsent(backend: CliBackend): CliConsent {
    return { ...backend.consent, launchPath: normalizePath(backend.executablePath) }
}

/**
 * Revokes launch consent — and tool consent with it.
 *
 * Tool consent alone would be a record the plugin must never act on
 * (`hasToolsConsent` requires launch consent), and leaving it behind would let
 * a later re-grant of launch consent silently restore tool mode the user never
 * re-approved.
 */
export function revokeLaunchConsent(): CliConsent {
    return { launchPath: '', toolsPath: '' }
}

/**
 * Grants tool consent for the backend's current executable path.
 *
 * Refuses when launch consent is not in place, so the stronger consent can
 * never be recorded without the weaker one. The caller's UI asks for them in
 * order; this makes the order structural.
 */
export function grantToolsConsent(backend: CliBackend): CliConsent {
    if (!hasLaunchConsent(backend)) {
        return backend.consent
    }
    return { ...backend.consent, toolsPath: normalizePath(backend.executablePath) }
}

/** Revokes tool consent only. The backend keeps running, without tools. */
export function revokeToolsConsent(backend: CliBackend): CliConsent {
    return { ...backend.consent, toolsPath: '' }
}

/**
 * Strips any consent that does not apply to the given executable path.
 *
 * Called when the path changes while a backend is being edited: consent
 * already evaluates as not-granted at that point, and clearing it makes the
 * persisted record say the same thing as the evaluation, so a later revert to
 * the old path does not resurrect a decision the user has since moved past.
 */
export function consentForPath(consent: CliConsent, executablePath: string): CliConsent {
    const path = normalizePath(executablePath)
    return {
        launchPath: normalizePath(consent.launchPath) === path ? consent.launchPath : '',
        toolsPath: normalizePath(consent.toolsPath) === path ? consent.toolsPath : ''
    }
}
