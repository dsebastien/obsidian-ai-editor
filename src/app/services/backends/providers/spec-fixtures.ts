import {
    CONTRACT_VERSION,
    type AggregatePanelRequest,
    type ReviewRequest
} from '../../../domain/operations/contract'
import { apiBackendSchema, type ApiBackend } from '../../../domain/settings/settings-schema'

/**
 * Test-only fixture builders shared by the provider adapter specs. Not a
 * test file itself (bun only collects `*.spec.ts`), never imported by
 * production code.
 */

export const TEST_API_KEY = 'sk-super-secret-key-123'

export function makeConfig(overrides: Partial<ApiBackend> = {}): ApiBackend {
    return apiBackendSchema.parse({
        id: 'backend-1',
        family: 'api',
        kind: 'anthropic',
        label: 'Test backend',
        apiKey: TEST_API_KEY,
        ...overrides
    })
}

export const DOCUMENT_TEXT = 'Hello world. This is a test document about writing well.'

export function reviewOperation(): ReviewRequest {
    return {
        contractVersion: CONTRACT_VERSION,
        kind: 'review',
        runId: 'run-1',
        snapshotHash: 'hash-1',
        text: DOCUMENT_TEXT
    }
}

export function aggregatePanelOperation(): AggregatePanelRequest {
    return {
        contractVersion: CONTRACT_VERSION,
        kind: 'aggregate-panel',
        runId: 'run-2',
        snapshotHash: 'hash-1',
        members: [
            {
                editorName: 'Hater',
                findings: [
                    {
                        quote: 'Hello world',
                        critique: 'Cliché opener',
                        severity: 'warning',
                        evidence: []
                    }
                ],
                verdict: 'needs-work',
                failed: false,
                omittedFindings: 0
            },
            { editorName: 'Beginner', findings: [], failed: true, omittedFindings: 0 }
        ]
    }
}

/** A schema-valid review result, as a model would emit it (defaults omitted). */
export function validReviewResult(): Record<string, unknown> {
    return {
        kind: 'review',
        findings: [
            {
                quote: 'Hello world',
                prefix: '',
                suffix: '. This is',
                critique: 'Generic opening line',
                suggestion: 'Bonjour world',
                rationale: 'More distinctive',
                severity: 'suggestion',
                confidence: 0.9
            }
        ],
        summary: 'Solid draft overall'
    }
}

/** A schema-valid panel aggregation result. */
export function validPanelResult(): Record<string, unknown> {
    return {
        kind: 'aggregate-panel',
        recommendation: 'needs-work',
        memberVerdicts: [
            { editorName: 'Hater', verdict: 'needs-work', keyPoint: 'Opening is weak' }
        ],
        topFixes: [
            { action: 'Rewrite the opening sentence', editorName: 'Hater', quote: 'It was a' }
        ],
        dissent: [
            {
                subject: 'Whether the opening works',
                positions: [
                    { editorName: 'Hater', stance: 'It buries the point' },
                    { editorName: 'Beginner', stance: 'Found it accessible' }
                ]
            }
        ],
        missingMembers: ['Beginner']
    }
}

/** A payload with the right kind but a contract violation inside. */
export function wrongSchemaResult(): Record<string, unknown> {
    return {
        kind: 'review',
        findings: [{ critique: 'finding without the required quote' }]
    }
}
