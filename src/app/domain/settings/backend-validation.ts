import { validateExecutablePath } from '../../services/backends/cli/executable'
import type { ExecutableProbe } from '../../services/backends/cli/executable'
import type { CliPlatform } from '../../services/backends/cli/platform'
import { consentForPath } from './cli-consent'
import { apiBackendSchema, cliBackendSchema } from './settings-schema'
import type { ApiBackend, CliBackend } from './settings-schema'

/**
 * What makes a backend configuration usable — one rule per family, shared by
 * every surface that authors one (the Backends tab's dialogs and the setup
 * wizard).
 *
 * The messages live here with the rule rather than in a separate copy module:
 * each one IS the rule stated in words ("OpenAI-compatible backends need a
 * base URL"), and splitting them would let two surfaces enforce the same
 * requirement while explaining it differently.
 *
 * No Obsidian. The API rule is pure; the CLI rule asks the filesystem exactly
 * one question — is this an executable file? — through the same injected probe
 * the security boundary uses, so the dialog and the spawn can never disagree
 * about a path. Whether the backend actually ANSWERS is a different question
 * again, asked by `checkBackendHealth`.
 */

export type BackendValidationCode =
    | 'label-required'
    | 'base-url-required'
    | 'api-key-required'
    | 'deployment-required'
    | 'extra-body-not-object'
    | 'executable-required'
    | 'executable-invalid'
    | 'schema-invalid'

export type BackendValidation =
    | { readonly ok: true; readonly backend: ApiBackend }
    | { readonly ok: false; readonly code: BackendValidationCode; readonly message: string }

export type CliBackendValidation =
    | { readonly ok: true; readonly backend: CliBackend }
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

export interface ValidateCliBackendInput {
    readonly draft: CliBackend
    readonly platform: CliPlatform
    /**
     * The same filesystem probe the security boundary uses. Passing the real
     * one is the point: the executable check the spawn performs is the check
     * the dialog performs, so a backend cannot be saved as valid and then fail
     * at the boundary for a reason the dialog could have named.
     */
    readonly probe: ExecutableProbe
}

/**
 * Validates a CLI backend draft, returning the normalized backend or the first
 * problem with it.
 *
 * The executable is not optional the way an API key sometimes is: without a
 * path there is nothing to run, and with a bad one the boundary refuses at
 * spawn time anyway. Checking it here — through `validateExecutablePath`, the
 * boundary's own gate — means the user is told at save time, in the dialog
 * where the field is, rather than at the end of their first review.
 *
 * Consent is re-derived rather than trusted: `consentForPath` drops any
 * recorded consent that does not name the path being saved, so an edited path
 * cannot carry a previous decision forward, and neither can an imported or
 * sync-merged settings file (Business Rules #9, #12).
 */
export function validateCliBackend(input: ValidateCliBackendInput): CliBackendValidation {
    const draft = input.draft
    const executablePath = draft.executablePath.trim()
    const normalized: CliBackend = {
        ...draft,
        label: draft.label.trim(),
        executablePath,
        defaultModel: draft.defaultModel.trim(),
        consent: consentForPath(draft.consent, executablePath)
    }
    if (normalized.label.length === 0) {
        return { ok: false, code: 'label-required', message: 'A label is required.' }
    }
    if (executablePath.length === 0) {
        return {
            ok: false,
            code: 'executable-required',
            message: 'CLI backends need the full path to the tool’s executable.'
        }
    }
    const executable = validateExecutablePath({
        platform: input.platform,
        path: executablePath,
        probe: input.probe
    })
    if (!executable.ok) {
        return { ok: false, code: 'executable-invalid', message: executable.message }
    }
    const parsed = cliBackendSchema.safeParse(normalized)
    if (!parsed.success) {
        return { ok: false, code: 'schema-invalid', message: 'Invalid backend configuration.' }
    }
    return { ok: true, backend: parsed.data }
}
