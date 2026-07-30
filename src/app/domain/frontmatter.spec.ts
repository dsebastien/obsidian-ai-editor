import { describe, expect, it } from 'bun:test'
import { stripFrontmatterBlock } from './frontmatter'

describe('stripFrontmatterBlock', () => {
    it('removes a leading block and reports what it removed', () => {
        const text = '---\ntitle: Secret\nclient: ACME\n---\n# Heading\n\nBody.'
        const result = stripFrontmatterBlock(text)
        expect(result.text).toBe('# Heading\n\nBody.')
        expect(result.removedChars).toBe(text.length - result.text.length)
        expect(result.text).not.toContain('---')
    })

    it('leaves text without frontmatter untouched', () => {
        const text = '# Heading\n\nBody with a --- thematic break.\n\n---\n\nMore.'
        expect(stripFrontmatterBlock(text)).toEqual({ text, removedChars: 0 })
    })

    it('does not treat a mid-document delimiter as frontmatter', () => {
        const text = '\n---\ntitle: not frontmatter\n---\n'
        expect(stripFrontmatterBlock(text).removedChars).toBe(0)
    })

    it('handles an empty block', () => {
        expect(stripFrontmatterBlock('---\n---\nBody.')).toEqual({
            text: 'Body.',
            removedChars: 8
        })
    })

    it('handles CRLF and trailing whitespace on the delimiters', () => {
        const text = '---  \r\ntags: [a]\r\n--- \r\nBody.'
        expect(stripFrontmatterBlock(text).text).toBe('Body.')
    })

    it('handles a file that is nothing but frontmatter', () => {
        expect(stripFrontmatterBlock('---\ntitle: x\n---').text).toBe('')
    })

    it('leaves an unterminated block alone rather than eating the note', () => {
        const text = '---\ntitle: x\n\n# Heading\n\nBody.'
        expect(stripFrontmatterBlock(text).removedChars).toBe(0)
    })

    it('removes only the FIRST block', () => {
        const text = '---\na: 1\n---\n---\nb: 2\n---\n'
        expect(stripFrontmatterBlock(text).text).toBe('---\nb: 2\n---\n')
    })
})
