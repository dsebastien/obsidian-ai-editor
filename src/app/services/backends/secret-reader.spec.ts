import { afterEach, describe, expect, it } from 'bun:test'
import type { SecretStore } from '../../domain/settings/api-key-secrets'
import { isApiKeyMissing, lookupApiKey, setSecretStore } from './secret-reader'

class MemoryStore implements SecretStore {
    readonly values = new Map<string, string>()
    getSecret(id: string): string | null {
        return this.values.get(id) ?? null
    }
    setSecret(id: string, secret: string): void {
        this.values.set(id, secret)
    }
}

const NAME = 'editor-ai-daemons-work-api-key'
let restore: (() => void) | null = null

function install(store: SecretStore): void {
    restore = setSecretStore(store)
}

afterEach(() => {
    restore?.()
    restore = null
})

describe('lookupApiKey', () => {
    it('prefers secret storage', () => {
        const store = new MemoryStore()
        store.values.set(NAME, 'sk-stored')
        install(store)
        expect(lookupApiKey({ apiKeySecretName: NAME, apiKey: 'sk-legacy' })).toEqual({
            status: 'ok',
            key: 'sk-stored'
        })
    })

    it('falls back to the legacy copy and migrates it at that moment', () => {
        const store = new MemoryStore()
        install(store)
        expect(lookupApiKey({ apiKeySecretName: NAME, apiKey: 'sk-legacy' })).toEqual({
            status: 'ok',
            key: 'sk-legacy'
        })
        expect(store.getSecret(NAME)).toBe('sk-legacy')
    })

    it('reports a configured name with no value anywhere as missing', () => {
        const store = new MemoryStore()
        store.values.set(NAME, '')
        install(store)
        const backend = { apiKeySecretName: NAME, apiKey: '' }
        expect(lookupApiKey(backend)).toEqual({ status: 'missing', name: NAME })
        expect(isApiKeyMissing(backend)).toBe(true)
    })

    it('treats no name and no legacy key as "no key configured"', () => {
        install(new MemoryStore())
        expect(lookupApiKey({ apiKeySecretName: '', apiKey: '' })).toEqual({ status: 'none' })
    })
})
