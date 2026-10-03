import { describe, expect, it } from 'bun:test'
import { produce } from 'immer'
import {
    LEGACY_KEY_GRACE_DAYS,
    chooseSecretName,
    clearLegacyApiKeys,
    defaultApiKeySecretName,
    dropStaleLegacyKey,
    hasLegacyApiKeys,
    isValidSecretName,
    legacyGraceExpired,
    reconcileApiKeySecrets,
    removeLegacyApiKeys
} from './api-key-secrets'
import type { SecretStore } from './api-key-secrets'
import { apiBackendSchema, pluginSettingsSchema } from './settings-schema'
import type { ApiBackend, PluginSettingsV1 } from './settings-schema'

/** In-memory SecretStorage: '' is how Obsidian "deletes" a secret. */
class MemoryStore implements SecretStore {
    readonly values = new Map<string, string>()
    writes = 0
    getSecret(id: string): string | null {
        return this.values.get(id) ?? null
    }
    setSecret(id: string, secret: string): void {
        if (!isValidSecretName(id)) {
            throw new Error(`invalid id ${id}`)
        }
        this.writes++
        this.values.set(id, secret)
    }
}

const NOW = new Date('2026-10-03T12:00:00.000Z')
const DAY_MS = 24 * 60 * 60 * 1000

function backend(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return { id: 'b1', family: 'api', kind: 'anthropic', label: 'Work Claude', ...overrides }
}

function settingsOf(overrides: Record<string, unknown> = {}): PluginSettingsV1 {
    return pluginSettingsSchema.parse(overrides)
}

function apiAt(settings: PluginSettingsV1, index = 0): ApiBackend {
    const found = settings.backends[index]
    if (!found || found.family !== 'api') {
        throw new Error('expected an API backend')
    }
    return found
}

describe('secret names', () => {
    it('derives a valid default name from the label, falling back to the kind', () => {
        expect(defaultApiKeySecretName('Work Claude', 'anthropic')).toBe(
            'editor-ai-daemons-work-claude-api-key'
        )
        expect(defaultApiKeySecretName('★★★', 'openrouter')).toBe(
            'editor-ai-daemons-openrouter-api-key'
        )
        expect(isValidSecretName(defaultApiKeySecretName('Ünïcode Label!', 'x'))).toBe(true)
    })

    it('suffixes past claimed names and different stored values, reuses an equal one', () => {
        const store = new MemoryStore()
        const base = 'editor-ai-daemons-work-claude-api-key'
        const source = { label: 'Work Claude', kind: 'anthropic' as const }
        expect(chooseSecretName(source, 'k', new Set([base]), store)).toBe(`${base}-2`)
        store.values.set(base, 'other')
        expect(chooseSecretName(source, 'k', new Set(), store)).toBe(`${base}-2`)
        store.values.set(base, 'k')
        expect(chooseSecretName(source, 'k', new Set(), store)).toBe(base)
    })
})

describe('reconcileApiKeySecrets (per-device migration)', () => {
    it('device A: moves the legacy key into secret storage, keeps the plaintext as bootstrap', () => {
        const store = new MemoryStore()
        const result = reconcileApiKeySecrets(
            settingsOf({ backends: [backend({ apiKey: 'sk-1' })] }),
            store,
            NOW
        )
        const migrated = apiAt(result.settings)
        expect(migrated.apiKeySecretName).toBe('editor-ai-daemons-work-claude-api-key')
        expect(store.getSecret(migrated.apiKeySecretName)).toBe('sk-1')
        // Kept for the other devices (SecretStorage does not sync).
        expect(migrated.apiKey).toBe('sk-1')
        expect(result.settings.legacySecretMigratedAt).toBe(NOW.toISOString())
        expect(result.changed).toBe(true)
        expect(result.migrated).toEqual(['Work Claude'])
    })

    it('device B: synced data.json with name + legacy value, empty storage → migrated and working', () => {
        const deviceA = new MemoryStore()
        const afterA = reconcileApiKeySecrets(
            settingsOf({ backends: [backend({ apiKey: 'sk-1' })] }),
            deviceA,
            NOW
        ).settings
        const deviceB = new MemoryStore()
        const later = new Date(NOW.getTime() + DAY_MS)
        const result = reconcileApiKeySecrets(afterA, deviceB, later)
        const name = apiAt(afterA).apiKeySecretName
        expect(deviceB.getSecret(name)).toBe('sk-1')
        expect(result.migrated).toEqual(['Work Claude'])
        expect(result.missing).toEqual([])
        // Nothing to persist: same name, legacy kept, grace clock untouched.
        expect(result.changed).toBe(false)
        expect(result.settings.legacySecretMigratedAt).toBe(NOW.toISOString())
    })

    it('is idempotent', () => {
        const store = new MemoryStore()
        const first = reconcileApiKeySecrets(
            settingsOf({ backends: [backend({ apiKey: 'sk-1' })] }),
            store,
            NOW
        )
        const writes = store.writes
        const second = reconcileApiKeySecrets(first.settings, store, NOW)
        expect(second.changed).toBe(false)
        expect(second.settings).toBe(first.settings)
        expect(store.writes).toBe(writes)
    })

    it('never overwrites a different secret already stored under the default name', () => {
        const store = new MemoryStore()
        store.values.set('editor-ai-daemons-work-claude-api-key', 'someone-else')
        const result = reconcileApiKeySecrets(
            settingsOf({ backends: [backend({ apiKey: 'sk-1' })] }),
            store,
            NOW
        )
        expect(apiAt(result.settings).apiKeySecretName).toBe(
            'editor-ai-daemons-work-claude-api-key-2'
        )
        expect(store.getSecret('editor-ai-daemons-work-claude-api-key')).toBe('someone-else')
    })

    it('gives two backends with the same label distinct secret names', () => {
        const store = new MemoryStore()
        const result = reconcileApiKeySecrets(
            settingsOf({
                backends: [backend({ apiKey: 'sk-1' }), backend({ id: 'b2', apiKey: 'sk-1' })]
            }),
            store,
            NOW
        )
        expect(apiAt(result.settings, 0).apiKeySecretName).not.toBe(
            apiAt(result.settings, 1).apiKeySecretName
        )
    })

    it('rotation: a stored value differing from the legacy copy drops the stale copy', () => {
        const store = new MemoryStore()
        const name = 'editor-ai-daemons-work-claude-api-key'
        store.values.set(name, 'sk-rotated')
        const result = reconcileApiKeySecrets(
            settingsOf({ backends: [backend({ apiKey: 'sk-old', apiKeySecretName: name })] }),
            store,
            NOW
        )
        expect(apiAt(result.settings).apiKey).toBe('')
        expect(store.getSecret(name)).toBe('sk-rotated')
    })

    it('reports a name with no value on this device and no legacy copy', () => {
        const result = reconcileApiKeySecrets(
            settingsOf({ backends: [backend({ apiKeySecretName: 'editor-ai-daemons-x' })] }),
            new MemoryStore(),
            NOW
        )
        expect(result.missing).toEqual(['Work Claude'])
        expect(result.changed).toBe(false)
    })

    it('treats an emptied secret as absent and re-bootstraps from the legacy copy', () => {
        const store = new MemoryStore()
        const name = 'editor-ai-daemons-work-claude-api-key'
        store.values.set(name, '')
        reconcileApiKeySecrets(
            settingsOf({ backends: [backend({ apiKey: 'sk-1', apiKeySecretName: name })] }),
            store,
            NOW
        )
        expect(store.getSecret(name)).toBe('sk-1')
    })

    it('keeps the legacy copy and reports when the store refuses the write', () => {
        const store: SecretStore = {
            getSecret: () => null,
            setSecret: () => {
                throw new Error('boom')
            }
        }
        const result = reconcileApiKeySecrets(
            settingsOf({ backends: [backend({ apiKey: 'sk-1' })] }),
            store,
            NOW
        )
        expect(result.failed).toEqual(['Work Claude'])
        expect(apiAt(result.settings).apiKey).toBe('sk-1')
    })

    it(`purges every legacy copy ${LEGACY_KEY_GRACE_DAYS} days after the first migration`, () => {
        const store = new MemoryStore()
        const migrated = reconcileApiKeySecrets(
            settingsOf({ backends: [backend({ apiKey: 'sk-1' })] }),
            store,
            NOW
        ).settings
        const almost = new Date(NOW.getTime() + (LEGACY_KEY_GRACE_DAYS - 1) * DAY_MS)
        expect(reconcileApiKeySecrets(migrated, store, almost).purged).toBe(false)
        const expired = new Date(NOW.getTime() + LEGACY_KEY_GRACE_DAYS * DAY_MS)
        const result = reconcileApiKeySecrets(migrated, store, expired)
        expect(result.purged).toBe(true)
        expect(result.changed).toBe(true)
        expect(hasLegacyApiKeys(result.settings)).toBe(false)
        // The device's own secret survives the purge.
        expect(store.getSecret(apiAt(result.settings).apiKeySecretName)).toBe('sk-1')
    })

    it('does not start the grace clock when there is nothing to migrate', () => {
        const result = reconcileApiKeySecrets(settingsOf({}), new MemoryStore(), NOW)
        expect(result.settings.legacySecretMigratedAt).toBe('')
        expect(legacyGraceExpired('', NOW)).toBe(false)
        expect(legacyGraceExpired('not a date', NOW)).toBe(false)
    })
})

describe('removing the plain-text copy', () => {
    it('"Remove plain-text copy now" clears every legacy key', () => {
        const settings = settingsOf({
            backends: [backend({ apiKey: 'sk-1' }), backend({ id: 'b2', apiKey: 'sk-2' })]
        })
        const cleared = produce(settings, clearLegacyApiKeys)
        expect(hasLegacyApiKeys(cleared)).toBe(false)
        expect(removeLegacyApiKeys(cleared)).toBe(cleared)
    })
})

describe('dropStaleLegacyKey (save / rotate / clear)', () => {
    const name = 'editor-ai-daemons-work-claude-api-key'
    const legacyBackend = (): ApiBackend =>
        apiBackendSchema.parse(backend({ apiKey: 'sk-old', apiKeySecretName: name }))

    it('rotate: a new value in secret storage removes the legacy copy', () => {
        const store = new MemoryStore()
        store.values.set(name, 'sk-new')
        expect(dropStaleLegacyKey(legacyBackend(), store).apiKey).toBe('')
    })

    it('an unchanged secret keeps the legacy copy for the other devices', () => {
        const store = new MemoryStore()
        store.values.set(name, 'sk-old')
        expect(dropStaleLegacyKey(legacyBackend(), store).apiKey).toBe('sk-old')
    })

    it('logout/clear: an emptied secret plus a cleared legacy copy leaves no key anywhere', () => {
        const store = new MemoryStore()
        store.values.set(name, 'sk-old')
        // What the Clear button does: empty this device's secret, drop the copy.
        store.setSecret(name, '')
        const cleared = produce(settingsOf({ backends: [legacyBackend()] }), clearLegacyApiKeys)
        const result = reconcileApiKeySecrets(cleared, store, NOW)
        expect(apiAt(result.settings).apiKey).toBe('')
        expect(store.getSecret(name)).toBe('')
        expect(result.missing).toEqual(['Work Claude'])
    })
})
