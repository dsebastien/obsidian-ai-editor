import { describe, expect, it } from 'bun:test'
import { parseJsonDocument, parseJsonLines } from './protocol'

describe('parseJsonDocument', () => {
    it('parses one object, trailing newline included', () => {
        const result = parseJsonDocument('{"findings":[]}\n')
        expect(result).toEqual({ ok: true, value: { findings: [] } })
    })

    it('reports empty output as its own problem', () => {
        expect(parseJsonDocument('').ok).toBe(false)
        expect(parseJsonDocument('   \n\n').ok).toBe(false)
        const result = parseJsonDocument('')
        expect(result.ok ? '' : result.code).toBe('empty-output')
    })

    it('refuses malformed JSON without quoting it back', () => {
        const result = parseJsonDocument('{"key":"sk-super-secret"')
        expect(result.ok ? '' : result.code).toBe('malformed-json')
        expect(result.ok ? '' : result.message).not.toContain('sk-super-secret')
    })

    it('refuses a banner before the payload instead of hunting for the first brace', () => {
        const result = parseJsonDocument('Using model claude-x\n{"findings":[]}')
        expect(result.ok ? '' : result.code).toBe('malformed-json')
    })

    it('refuses a non-object document', () => {
        for (const raw of ['[]', '"text"', '42', 'null']) {
            const result = parseJsonDocument(raw)
            expect(result.ok ? '' : result.code).toBe('not-an-object')
        }
    })
})

describe('parseJsonLines', () => {
    it('parses one object per line', () => {
        const result = parseJsonLines('{"type":"start"}\n{"type":"finding"}\n{"type":"done"}\n')
        expect(result.ok ? result.value.length : 0).toBe(3)
        expect(result.ok ? result.value[1] : null).toEqual({ type: 'finding' })
    })

    it('skips blank lines', () => {
        const result = parseJsonLines('\n{"a":1}\n\n\n{"b":2}\n')
        expect(result.ok ? result.value.length : 0).toBe(2)
    })

    it('fails the stream on a malformed line and names the line, not its content', () => {
        const result = parseJsonLines('{"a":1}\nkey=sk-super-secret\n{"b":2}')
        expect(result.ok ? '' : result.code).toBe('malformed-json')
        expect(result.ok ? '' : result.message).toContain('Line 2')
        expect(result.ok ? '' : result.message).not.toContain('sk-super-secret')
    })

    it('fails on a line that parses but is not an object', () => {
        const result = parseJsonLines('{"a":1}\n[1,2,3]')
        expect(result.ok ? '' : result.code).toBe('not-an-object')
        expect(result.ok ? '' : result.message).toContain('Line 2')
    })

    it('reports a stream with no events as empty output', () => {
        const result = parseJsonLines('\n   \n')
        expect(result.ok ? '' : result.code).toBe('empty-output')
    })
})
