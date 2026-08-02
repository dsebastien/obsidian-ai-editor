import { chatCompletionContent, chatCompletionTruncated } from './openai'
import { buildUserMessage, resultJsonSchema } from './prompt'
import {
    extractJsonPayload,
    guardTruncation,
    validateOperationResult,
    type ValidatedOperationResult
} from './result'
import {
    ProviderError,
    redactSecret,
    type BuildRequestInput,
    type HttpRequestDescriptor,
    type ProviderAdapter,
    type ProviderCapabilities
} from './types'

/**
 * Azure OpenAI adapter. Deployment-based routing: the model is selected by
 * the deployment baked into the URL
 * (`{baseUrl}/openai/deployments/{deployment}/chat/completions?api-version=…`),
 * not by a `model` field — the resolved model input is intentionally ignored.
 * Auth uses the `api-key` header (not a bearer token). The response envelope
 * is Chat Completions, shared with the OpenAI adapter.
 */

function trimTrailingSlash(url: string): string {
    return url.endsWith('/') ? url.slice(0, -1) : url
}

export const azureOpenAiAdapter: ProviderAdapter = {
    buildRequest(input: BuildRequestInput): HttpRequestDescriptor {
        const { operation, systemPrompt, config } = input
        const missing = [
            config.baseUrl.length === 0 ? 'base URL' : null,
            config.azureDeployment.length === 0 ? 'deployment' : null,
            config.azureApiVersion.length === 0 ? 'api version' : null,
            config.apiKey.length === 0 ? 'API key' : null
        ].filter((item): item is string => item !== null)
        if (missing.length > 0) {
            throw new ProviderError(
                'invalid-config',
                redactSecret(
                    `Azure OpenAI backend "${config.label}" is missing: ${missing.join(', ')}`,
                    config.apiKey
                )
            )
        }
        const baseUrl = trimTrailingSlash(config.baseUrl)
        const deployment = encodeURIComponent(config.azureDeployment)
        const apiVersion = encodeURIComponent(config.azureApiVersion)
        const body: Record<string, unknown> = {
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: buildUserMessage(operation, 'json-object') }
            ],
            response_format: {
                type: 'json_schema',
                json_schema: {
                    name: 'operation_result',
                    schema: resultJsonSchema(operation.kind)
                }
            },
            stream: false
        }
        // reasoning_effort passthrough; 'default' sends nothing so deployments
        // of non-reasoning models never see an unknown parameter.
        if (config.reasoningEffort !== 'default') {
            body['reasoning_effort'] = config.reasoningEffort
        }
        return {
            url: `${baseUrl}/openai/deployments/${deployment}/chat/completions?api-version=${apiVersion}`,
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                'api-key': config.apiKey
            },
            body: JSON.stringify(body)
        }
    },

    parseBufferedResponse(raw: unknown): ValidatedOperationResult {
        return guardTruncation(chatCompletionTruncated(raw), () =>
            validateOperationResult(extractJsonPayload(chatCompletionContent(raw, 'Azure OpenAI')))
        )
    },

    capabilities(): ProviderCapabilities {
        // Buffered baseline until Azure streaming is verified end-to-end.
        return { streaming: false, jsonSchema: true, reportsUsage: true }
    }
}
