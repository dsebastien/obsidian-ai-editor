import { describe, expect, it } from 'bun:test'
import { CONTRACT_VERSION, type OperationRequest } from '../../../domain/operations/contract'
import { buildUserMessage, resultJsonSchema } from './prompt'
import { aggregatePanelOperation, DOCUMENT_TEXT, reviewOperation } from './spec-fixtures'

const base = { contractVersion: CONTRACT_VERSION, runId: 'run-1', snapshotHash: 'h1' } as const

describe('buildUserMessage', () => {
    it('embeds the verbatim document and the strict output contract for review', () => {
        const message = buildUserMessage(reviewOperation(), 'json-object')
        expect(message).toContain(`<document>\n${DOCUMENT_TEXT}\n</document>`)
        expect(message).toContain('OUTPUT FORMAT — follow exactly:')
        expect(message).toContain('"kind" set to "review"')
        expect(message).toContain('character-for-character verbatim')
        expect(message).toContain('"prefix"')
        expect(message).toContain('"suffix"')
        // The inline schema is the review result schema, not another kind's.
        expect(message).toContain('"const":"review"')
    })

    it('omits the JSON-only directive and inline schema in tool-input style', () => {
        const message = buildUserMessage(reviewOperation(), 'tool-input')
        expect(message).toContain('calling the provided tool')
        expect(message).not.toContain('Respond with a single JSON object')
        expect(message).not.toContain('"$schema"')
    })

    it('includes the selection excerpt for selection-scoped reviews', () => {
        const operation: OperationRequest = {
            ...reviewOperation(),
            selection: { from: 0, to: 11 }
        }
        const message = buildUserMessage(operation, 'json-object')
        expect(message).toContain('<selection>\nHello world\n</selection>')
    })

    it('reframes a continuation pass around what was already reported', () => {
        const operation: OperationRequest = {
            ...reviewOperation(),
            alreadyReported: [{ quote: 'Hello world', critique: 'Too generic an opening' }]
        }
        const message = buildUserMessage(operation, 'json-object')
        expect(message).toContain('report what you did NOT report the first time')
        expect(message).toContain('<already-reported>')
        expect(message).toContain('<quote>\nHello world\n</quote>')
        expect(message).toContain('<critique>\nToo generic an opening\n</critique>')
        expect(message).toContain('report only findings you have NOT already made')
        // Padding is the failure mode a second pass invites; say so explicitly.
        expect(message).toContain('Reporting nothing further is a valid and honest result')
    })

    it('says nothing about additional passes on a first review', () => {
        const message = buildUserMessage(reviewOperation(), 'json-object')
        expect(message).not.toContain('already-reported')
        expect(message).not.toContain('ADDITIONAL pass')
    })

    it('slices the selection for transform-selection and carries the instruction', () => {
        const operation: OperationRequest = {
            ...base,
            kind: 'transform-selection',
            text: DOCUMENT_TEXT,
            selection: { from: 13, to: 35 },
            instruction: 'Make it punchier'
        }
        const message = buildUserMessage(operation, 'json-object')
        expect(message).toContain(`<selection>\n${DOCUMENT_TEXT.slice(13, 35)}\n</selection>`)
        expect(message).toContain('<instruction>\nMake it punchier\n</instruction>')
        expect(message).toContain('"kind" set to "transform-selection"')
    })

    it('splits the document around the insertion point for insert-at', () => {
        const operation: OperationRequest = {
            ...base,
            kind: 'insert-at',
            text: 'before|after',
            position: 6
        }
        const message = buildUserMessage(operation, 'json-object')
        expect(message).toContain(
            '<text-before-insertion-point>\nbefore\n</text-before-insertion-point>'
        )
        expect(message).toContain(
            '<text-after-insertion-point>\n|after\n</text-after-insertion-point>'
        )
        expect(message).not.toContain('<instruction>')
    })

    it('serializes thread history in order for thread-turn', () => {
        const operation: OperationRequest = {
            ...base,
            kind: 'thread-turn',
            findingId: 'f1',
            quote: 'Hello world',
            critique: 'Too generic',
            history: [
                { role: 'user', content: 'Why is this a problem?' },
                { role: 'editor', content: 'It sets no expectation.' }
            ],
            message: 'Fine, propose something better.'
        }
        const message = buildUserMessage(operation, 'json-object')
        expect(message.indexOf('Why is this a problem?')).toBeLessThan(
            message.indexOf('It sets no expectation.')
        )
        expect(message).toContain(
            '<user-message>\nFine, propose something better.\n</user-message>'
        )
    })

    it('embeds the member reviews for aggregate-panel', () => {
        const message = buildUserMessage(aggregatePanelOperation(), 'json-object')
        expect(message).toContain('member-reviews')
        expect(message).toContain('Cliché opener')
        expect(message).toContain('"kind" set to "aggregate-panel"')
    })
})

describe('resultJsonSchema', () => {
    it('pins the kind constant per operation kind', () => {
        for (const kind of [
            'review',
            'transform-selection',
            'insert-at',
            'refine-proposal',
            'thread-turn',
            'aggregate-panel'
        ] as const) {
            const schema = resultJsonSchema(kind) as {
                properties: { kind: { const: string } }
                required: string[]
            }
            expect(schema.properties.kind.const).toBe(kind)
            expect(schema.required).toContain('kind')
        }
    })

    it('keeps defaulted finding fields optional for the model (input mode)', () => {
        const schema = resultJsonSchema('review') as {
            properties: {
                findings: { items: { required: string[] } }
            }
        }
        const required = schema.properties.findings.items.required
        expect(required).toContain('quote')
        expect(required).toContain('critique')
        expect(required).not.toContain('severity')
        expect(required).not.toContain('evidence')
    })
})
