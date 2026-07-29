import { describe, expect, it } from 'bun:test'
import { apiProviderKindSchema } from '../../../domain/settings/settings-schema'
import { anthropicAdapter } from './anthropic'
import { azureOpenAiAdapter } from './azure-openai'
import { getProviderAdapter } from './index'
import { ollamaAdapter } from './ollama'
import { openAiAdapter } from './openai'

describe('getProviderAdapter', () => {
    it('returns the matching adapter per provider kind', () => {
        expect(getProviderAdapter('anthropic')).toBe(anthropicAdapter)
        expect(getProviderAdapter('openai')).toBe(openAiAdapter)
        expect(getProviderAdapter('openai-compatible')).toBe(openAiAdapter)
        expect(getProviderAdapter('azure-openai')).toBe(azureOpenAiAdapter)
        expect(getProviderAdapter('ollama')).toBe(ollamaAdapter)
    })

    it('covers every kind the settings schema allows', () => {
        for (const kind of apiProviderKindSchema.options) {
            expect(getProviderAdapter(kind)).toBeDefined()
        }
    })
})
