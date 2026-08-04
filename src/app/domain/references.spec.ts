import { describe, expect, it } from 'bun:test'
import { formatReference, referenceFootnote, referenceSectionInsertion } from './references'

describe('formatReference (issue #30)', () => {
    it('links a titled URL and falls back to the bare title', () => {
        expect(formatReference({ title: 'A study', url: 'https://x.test/a' })).toBe(
            '[A study](https://x.test/a)'
        )
        expect(formatReference({ title: 'A book' })).toBe('A book')
        expect(formatReference({ title: 'A book', url: '' })).toBe('A book')
    })

    it('flattens square brackets that would break the link/footnote syntax', () => {
        expect(formatReference({ title: 'Weird [2024] title', url: 'https://x.test' })).toBe(
            '[Weird 2024 title](https://x.test)'
        )
    })
})

describe('referenceFootnote (issue #30)', () => {
    it('wraps the reference in an inline footnote with its leading space', () => {
        expect(referenceFootnote({ title: 'Src', url: 'https://x.test' })).toBe(
            ' ^[[Src](https://x.test)]'
        )
    })
})

describe('referenceSectionInsertion (issue #30)', () => {
    const source = { title: 'Src', url: 'https://x.test' }

    it('appends a bullet at an existing References section content end', () => {
        const text = '# Note\nBody.\n\n## References\n- [Old](https://old.test)\n\n## After\nX.'
        const { offset, insert } = referenceSectionInsertion(text, source)
        expect(insert).toBe('\n- [Src](https://x.test)')
        expect(text.slice(offset - '(https://old.test)'.length, offset)).toBe('(https://old.test)')
    })

    it('appends right after the heading when the section is empty', () => {
        const text = '# Note\nBody.\n\n## References'
        const { offset, insert } = referenceSectionInsertion(text, source)
        expect(offset).toBe(text.length)
        expect(insert).toBe('\n- [Src](https://x.test)')
    })

    it('creates the section at the note content end when it is missing', () => {
        const text = '# Note\nBody.\n\n\n'
        const { offset, insert } = referenceSectionInsertion(text, source)
        expect(text.slice(0, offset).endsWith('Body.')).toBeTrue()
        expect(insert).toBe('\n\n## References\n\n- [Src](https://x.test)')
    })

    it('an empty note gets the section without leading blank lines', () => {
        const { offset, insert } = referenceSectionInsertion('', source)
        expect(offset).toBe(0)
        expect(insert).toBe('## References\n\n- [Src](https://x.test)')
    })

    it('matches the heading case-insensitively but not partial words', () => {
        const partial = '# Note\n## Reference materials\n- x'
        expect(referenceSectionInsertion(partial, source).insert).toContain('## References')
        const lower = '# Note\n## references\n- x'
        expect(referenceSectionInsertion(lower, source).insert).toBe('\n- [Src](https://x.test)')
    })
})
