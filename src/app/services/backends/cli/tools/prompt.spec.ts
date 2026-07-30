import { describe, expect, it } from 'bun:test'
import { buildCliStdin } from './prompt'
import { CLI_DOCUMENT_TEXT, cliReviewOperation } from './spec-fixtures'

describe('buildCliStdin', () => {
    it('frames the persona and carries the operation payload', () => {
        const stdin = buildCliStdin({
            systemPrompt: 'You are the Concision Editor.',
            operation: cliReviewOperation()
        })
        expect(stdin).toContain(
            '<persona-instructions>\nYou are the Concision Editor.\n</persona-instructions>'
        )
        expect(stdin).toContain(CLI_DOCUMENT_TEXT)
    })

    it('omits the persona block entirely when there is no persona', () => {
        const stdin = buildCliStdin({ systemPrompt: '   ', operation: cliReviewOperation() })
        expect(stdin).not.toContain('persona-instructions')
        expect(stdin).toContain(CLI_DOCUMENT_TEXT)
    })

    it('embeds the operation result schema, since no CLI flag can carry it', () => {
        const stdin = buildCliStdin({ systemPrompt: '', operation: cliReviewOperation() })
        // The 'json-object' style is what makes the schema inline rather than
        // server-enforced; both tools' schema flags are unusable here.
        expect(stdin).toContain('Respond with a single JSON object')
        expect(stdin).toContain('"findings"')
    })

    it('closes with the no-prose directive, so it is the last thing read', () => {
        const stdin = buildCliStdin({ systemPrompt: 'Persona', operation: cliReviewOperation() })
        expect(
            stdin
                .trimEnd()
                .endsWith('no preamble, no explanation, no progress notes, no closing remarks.')
        ).toBe(true)
    })

    it('keeps the persona ahead of the request', () => {
        const stdin = buildCliStdin({
            systemPrompt: 'PERSONA_MARKER',
            operation: cliReviewOperation()
        })
        expect(stdin.indexOf('PERSONA_MARKER')).toBeLessThan(stdin.indexOf(CLI_DOCUMENT_TEXT))
    })
})
