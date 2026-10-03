import { produce } from 'immer'
import type { Draft } from 'immer'
import type { ApiBackend, PluginSettingsV1 } from './settings-schema'

/**
 * API keys live in Obsidian's SecretStorage, not in `data.json`.
 *
 * `data.json` travels with the vault (git, Syncthing, cloud sync), so a
 * plaintext key in it travels too. Each API backend stores the NAME of a
 * SecretStorage entry (`apiKeySecretName`); the value is read at request time
 * (`services/backends/secret-reader.ts`).
 *
 * SecretStorage is DEVICE-LOCAL. Deleting the legacy plaintext `apiKey` on the
 * first device that migrates would log out every other synced device, so the
 * legacy field is kept as a read-only bootstrap during a grace period:
 *
 * - Every device, on every load, copies a legacy value into its own
 *   SecretStorage when that device holds none (`reconcileApiKeySecrets`).
 * - New or changed values are only ever written to SecretStorage. A secret
 *   that now differs from the legacy copy means the key was rotated: the
 *   stale legacy copy is dropped.
 * - "Clear key" empties this device's secret AND the legacy copy.
 * - The legacy copies are purged 60 days after the first migration
 *   (`legacySecretMigratedAt`), or at once with "Remove plain-text copy now".
 *
 * SecretStorage has no delete API: an empty string is treated as absent.
 * Pure: the store and the clock are injected.
 */

/** Plugin id, the prefix of every secret name this plugin creates. */
export const SECRET_NAME_PREFIX = 'editor-ai-daemons'

/** Grace period during which legacy plaintext keys are kept in data.json. */
export const LEGACY_KEY_GRACE_DAYS = 60

const DAY_MS = 24 * 60 * 60 * 1000

/** The part of Obsidian's `SecretStorage` this plugin uses. */
export interface SecretStore {
    getSecret(id: string): string | null
    setSecret(id: string, secret: string): void
}

/** SecretStorage ids: lowercase alphanumeric with optional dashes. */
const SECRET_NAME_PATTERN = /^[a-z0-9-]+$/

/** Whether a name is accepted by `SecretStorage.setSecret`. */
export function isValidSecretName(name: string): boolean {
    return SECRET_NAME_PATTERN.test(name)
}

/** A stored secret, with '' (the only way to "delete") read as absent. */
export function readSecret(store: Pick<SecretStore, 'getSecret'>, name: string): string | null {
    if (!isValidSecretName(name)) {
        return null
    }
    try {
        const value = store.getSecret(name)
        return value === null || value.length === 0 ? null : value
    } catch {
        return null
    }
}

/** Lowercase, dash-separated slug usable inside a secret name ('' if none). */
export function secretNameSlug(text: string): string {
    return text
        .toLowerCase()
        .normalize('NFKD')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 60)
        .replace(/-+$/g, '')
}

/**
 * Default secret name for a backend: `editor-ai-daemons-<label>-api-key`,
 * falling back to the provider kind when the label has no usable characters.
 */
export function defaultApiKeySecretName(label: string, kind: string): string {
    const slug = secretNameSlug(label) || secretNameSlug(kind) || 'backend'
    return `${SECRET_NAME_PREFIX}-${slug}-api-key`
}

/** `base`, then `base-2`, `base-3`… — the first candidate `accept` takes. */
export function firstAvailableSecretName(base: string, accept: (name: string) => boolean): string {
    if (accept(base)) {
        return base
    }
    let suffix = 2
    while (!accept(`${base}-${suffix}`)) {
        suffix++
    }
    return `${base}-${suffix}`
}

/**
 * A secret name for a backend that has none yet: the default name, suffixed
 * when another backend claims it or the store holds a DIFFERENT value under
 * it. A store already holding `value` under the name is reused, so a re-run
 * (another device, an interrupted save) converges on the same name.
 */
export function chooseSecretName(
    backend: Pick<ApiBackend, 'label' | 'kind'>,
    value: string,
    claimed: ReadonlySet<string>,
    store: Pick<SecretStore, 'getSecret'>
): string {
    return firstAvailableSecretName(
        defaultApiKeySecretName(backend.label, backend.kind),
        (name) => {
            if (claimed.has(name)) {
                return false
            }
            const stored = readSecret(store, name)
            return stored === null || stored === value
        }
    )
}

/** Secret names referenced by the configured API backends. */
export function claimedSecretNames(settings: PluginSettingsV1, exceptBackendId = ''): Set<string> {
    const claimed = new Set<string>()
    for (const backend of settings.backends) {
        if (
            backend.family === 'api' &&
            backend.id !== exceptBackendId &&
            backend.apiKeySecretName.length > 0
        ) {
            claimed.add(backend.apiKeySecretName)
        }
    }
    return claimed
}

/** Outcome of `reconcileApiKeySecrets`. */
export interface ApiKeyReconciliation {
    /** Same object as the input when nothing changed. */
    readonly settings: PluginSettingsV1
    /** True when the settings changed and must be persisted. */
    readonly changed: boolean
    /** Backends whose legacy key was copied into this device's SecretStorage. */
    readonly migrated: readonly string[]
    /** Backends whose key could not be stored; the legacy copy is kept. */
    readonly failed: readonly string[]
    /**
     * Backends with a secret name but no value on this device and no legacy
     * copy to bootstrap from. The caller must tell the user to set it.
     */
    readonly missing: readonly string[]
    /** True when the grace period expired and the legacy copies were purged. */
    readonly purged: boolean
}

/** Whether the legacy grace period started at `migratedAt` is over at `now`. */
export function legacyGraceExpired(migratedAt: string, now: Date): boolean {
    if (migratedAt.length === 0) {
        return false
    }
    const started = Date.parse(migratedAt)
    if (Number.isNaN(started)) {
        return false
    }
    return now.getTime() - started >= LEGACY_KEY_GRACE_DAYS * DAY_MS
}

/** Whether any API backend still carries a legacy plaintext key. */
export function hasLegacyApiKeys(settings: PluginSettingsV1): boolean {
    return settings.backends.some(
        (backend) => backend.family === 'api' && backend.apiKey.length > 0
    )
}

/** Mutator: drops every legacy plaintext key ("Remove plain-text copy now"). */
export function clearLegacyApiKeys(draft: Draft<PluginSettingsV1>): void {
    for (const backend of draft.backends) {
        if (backend.family === 'api') {
            backend.apiKey = ''
        }
    }
}

/** Drops every legacy plaintext key (grace-period purge). */
export function removeLegacyApiKeys(settings: PluginSettingsV1): PluginSettingsV1 {
    if (!hasLegacyApiKeys(settings)) {
        return settings
    }
    return produce(settings, clearLegacyApiKeys)
}

/**
 * Per-device load step. For each API backend carrying a legacy key: name it
 * if needed, copy the value into THIS device's SecretStorage when it holds
 * none, and drop the legacy copy when the stored secret differs (rotated).
 * Starts the grace clock on first migration, and purges every legacy copy
 * once it expired. Idempotent.
 */
export function reconcileApiKeySecrets(
    settings: PluginSettingsV1,
    store: SecretStore,
    now: Date
): ApiKeyReconciliation {
    const migrated: string[] = []
    const failed: string[] = []
    const missing: string[] = []
    const claimed = claimedSecretNames(settings)
    let sawLegacy = false

    let next = produce(settings, (draft) => {
        for (const backend of draft.backends) {
            if (backend.family !== 'api') {
                continue
            }
            const legacy = backend.apiKey
            if (legacy.length === 0) {
                if (
                    backend.apiKeySecretName.length > 0 &&
                    readSecret(store, backend.apiKeySecretName) === null
                ) {
                    missing.push(backend.label)
                }
                continue
            }
            sawLegacy = true
            if (!isValidSecretName(backend.apiKeySecretName)) {
                backend.apiKeySecretName = chooseSecretName(backend, legacy, claimed, store)
                claimed.add(backend.apiKeySecretName)
            }
            const stored = readSecret(store, backend.apiKeySecretName)
            if (stored === null) {
                try {
                    store.setSecret(backend.apiKeySecretName, legacy)
                    migrated.push(backend.label)
                } catch {
                    failed.push(backend.label)
                }
            } else if (stored !== legacy) {
                // Rotated on this device: the legacy copy is stale.
                backend.apiKey = ''
            }
        }
        if (sawLegacy && draft.legacySecretMigratedAt.length === 0) {
            draft.legacySecretMigratedAt = now.toISOString()
        }
    })

    let purged = false
    if (legacyGraceExpired(next.legacySecretMigratedAt, now) && hasLegacyApiKeys(next)) {
        next = removeLegacyApiKeys(next)
        purged = true
    }
    return { settings: next, changed: next !== settings, migrated, failed, missing, purged }
}

/**
 * Applied when the user saves a backend: if the secret it now points at
 * holds a value that differs from its legacy copy (a new value, or another secret picked), the
 * legacy copy is stale and is dropped. New values never reach data.json.
 */
export function dropStaleLegacyKey<T extends ApiBackend>(
    backend: T,
    store: Pick<SecretStore, 'getSecret'>
): T {
    if (backend.apiKey.length === 0) {
        return backend
    }
    const stored = readSecret(store, backend.apiKeySecretName)
    // Nothing stored here yet: the legacy copy is still the only source.
    if (stored === null || stored === backend.apiKey) {
        return backend
    }
    return { ...backend, apiKey: '' }
}
