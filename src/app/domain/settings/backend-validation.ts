import { apiBackendSchema } from './settings-schema'
import type { ApiBackend } from './settings-schema'

/**
 * What makes an API backend configuration usable — the one rule, shared by
 * every surface that authors one (the Backends tab's dialog and the setup
 * wizard).
 *
 * The messages live here with the rule rather than in a separate copy module:
 * each one IS the rule stated in words ("OpenAI-compatible backends need a
 * base URL"), and splitting them would let two surfaces enforce the same
 * requirement while explaining it differently.
 *
 * Pure: no Obsidian, no I/O. Whether the endpoint actually answers is a
 * different question, asked by `checkBackendHealth`.
 */

export type BackendValidationCode =
    | 'label-required'
    | 'base-url-required'
    | 'api-key-required'
    | 'deployment-required'
    | 'extra-body-not-object'
    | 'schema-invalid'

export type BackendValidation =
    | { readonly ok: true; readonly backend: ApiBackend }
    | { readonly ok: false; readonly code: BackendValidationCode; readonly message: string }

/** True when the string parses as a plain JSON object (not array/scalar). */
export function isJsonObject(value: string): boolean {
    try {
        const parsed = JSON.parse(value) as unknown
        return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
    } catch {
        return false
    }
}

/**
 * Validates a backend draft, returning the normalized backend (label, base URL
 * and extra body trimmed) or the first problem with it.
 *
 * The per-kind requirements are the ones a request cannot be built without:
 * an OpenAI-compatible endpoint has no default URL to fall back on, Azure
 * addresses a deployment rather than a model, and OpenRouter rejects
 * unauthenticated calls outright. Everything else (a missing model, a missing
 * key on a provider that has a free tier) is legitimately optional here and is
 * caught by the resolution step that actually needs it.
 */
export function validateApiBackend(draft: ApiBackend): BackendValidation {
    const normalized: ApiBackend = {
        ...draft,
        label: draft.label.trim(),
        baseUrl: draft.baseUrl.trim(),
        extraBodyJson: draft.extraBodyJson.trim()
    }
    if (normalized.label.length === 0) {
        return { ok: false, code: 'label-required', message: 'A label is required.' }
    }
    if (normalized.kind === 'openai-compatible' && normalized.baseUrl.length === 0) {
        return {
            ok: false,
            code: 'base-url-required',
            message: 'OpenAI-compatible backends need a base URL.'
        }
    }
    if (normalized.kind === 'openrouter' && normalized.apiKey.trim().length === 0) {
        return {
            ok: false,
            code: 'api-key-required',
            message: 'OpenRouter backends need an API key.'
        }
    }
    if (normalized.kind === 'azure-openai' && normalized.azureDeployment.trim().length === 0) {
        return {
            ok: false,
            code: 'deployment-required',
            message: 'Azure OpenAI backends need a deployment name.'
        }
    }
    if (normalized.extraBodyJson.length > 0 && !isJsonObject(normalized.extraBodyJson)) {
        return {
            ok: false,
            code: 'extra-body-not-object',
            message: 'Extra request body must be a JSON object, e.g. {"think": true}.'
        }
    }
    const parsed = apiBackendSchema.safeParse(normalized)
    if (!parsed.success) {
        return {
            ok: false,
            code: 'schema-invalid',
            message: 'Invalid backend configuration.'
        }
    }
    return { ok: true, backend: parsed.data }
}
