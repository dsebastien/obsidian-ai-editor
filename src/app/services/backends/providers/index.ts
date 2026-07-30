import type { ApiProviderKind } from '../../../domain/settings/settings-schema'
import { anthropicAdapter } from './anthropic'
import { azureOpenAiAdapter } from './azure-openai'
import { ollamaAdapter } from './ollama'
import { openAiAdapter } from './openai'
import type { ProviderAdapter } from './types'

/**
 * Adapter registry: one stateless adapter per provider profile.
 * 'openrouter' and 'openai-compatible' share the OpenAI adapter — base
 * URL, headers, and reasoning passthrough differences are handled inside
 * `buildRequest` via `config.kind`.
 */
export function getProviderAdapter(kind: ApiProviderKind): ProviderAdapter {
    switch (kind) {
        case 'anthropic':
            return anthropicAdapter
        case 'openai':
        case 'openrouter':
        case 'openai-compatible':
            return openAiAdapter
        case 'azure-openai':
            return azureOpenAiAdapter
        case 'ollama':
            return ollamaAdapter
    }
}

export { ProviderError, redactSecret } from './types'
export type {
    BuildRequestInput,
    HttpRequestDescriptor,
    ProviderAdapter,
    ProviderCapabilities,
    ProviderErrorCode
} from './types'
