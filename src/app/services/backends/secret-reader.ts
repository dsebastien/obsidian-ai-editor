import { isValidSecretName, readSecret } from '../../domain/settings/api-key-secrets'
import type { SecretStore } from '../../domain/settings/api-key-secrets'
import type { ApiBackend } from '../../domain/settings/settings-schema'

/**
 * Request-time access to API keys held in Obsidian's SecretStorage.
 *
 * The plugin installs `app.secretStorage` here at load (`setSecretStore`);
 * every key is read when a request is built and never copied into the
 * settings object. Module-level like `backendHealth`: every dispatch path
 * crosses `createBackendExecutor`, which is the only consumer. Until a store
 * is installed (or in specs that install none), no secret exists.
 */

const NO_SECRETS: SecretStore = {
    getSecret: () => null,
    setSecret: () => {
        throw new Error('No secret storage available')
    }
}

let store: SecretStore = NO_SECRETS

/** Installs the store; returns a function restoring the previous one. */
export function setSecretStore(next: SecretStore): () => void {
    const previous = store
    store = next
    return (): void => {
        store = previous
    }
}

/** The installed store (settings UI: missing-secret hints, rotation). */
export function getSecretStore(): SecretStore {
    return store
}

/** What a backend's configured key resolves to on this device. */
export type ApiKeyLookup =
    /** No key configured (endpoints that need none, e.g. local Ollama). */
    | { readonly status: 'none' }
    | { readonly status: 'ok'; readonly key: string }
    /** A secret name is configured but neither this device nor data.json has a value. */
    | { readonly status: 'missing'; readonly name: string }

/**
 * Reads a backend's API key: SecretStorage first, then the legacy plaintext
 * copy (grace period), which is migrated into SecretStorage at that moment.
 */
export function lookupApiKey(
    backend: Pick<ApiBackend, 'apiKeySecretName' | 'apiKey'>
): ApiKeyLookup {
    const name = backend.apiKeySecretName.trim()
    const stored = name.length > 0 ? readSecret(store, name) : null
    if (stored !== null) {
        return { status: 'ok', key: stored }
    }
    if (backend.apiKey.length > 0) {
        if (isValidSecretName(name)) {
            try {
                store.setSecret(name, backend.apiKey)
            } catch {
                // Still usable from the legacy copy; the load step reports it.
            }
        }
        return { status: 'ok', key: backend.apiKey }
    }
    if (name.length === 0) {
        return { status: 'none' }
    }
    return { status: 'missing', name }
}

/** Whether a backend has a key name but no value on this device. */
export function isApiKeyMissing(backend: Pick<ApiBackend, 'apiKeySecretName' | 'apiKey'>): boolean {
    const name = backend.apiKeySecretName.trim()
    return name.length > 0 && backend.apiKey.length === 0 && readSecret(store, name) === null
}

/** User-facing explanation for a missing secret on this device. */
export function missingSecretMessage(label: string, name: string): string {
    return (
        `“${label}” uses the API key secret “${name}”, which is not set on this device. ` +
        'Secrets are stored per device: open the Backends tab, edit this backend and set the secret.'
    )
}
