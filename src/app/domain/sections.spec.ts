import { describe, expect, it } from 'bun:test'
import { sectionInsertionPoint } from './sections'

const NOTE = [
    'Preamble line.', // 0..14
    '',
    '# Title', // 16..23
    'Intro under the title.',
    '',
    '## First', // 48..56
    'First body.',
    '',
    '### Nested', // 70..80
    'Nested body.',
    '',
    '## Second', // 95..104
    'Second body.'
].join('\n')

function offsetOf(needle: string): number {
    const at = NOTE.indexOf(needle)
    expect(at).toBeGreaterThanOrEqual(0)
    return at
}

describe('sectionInsertionPoint (issue #31)', () => {
    it('ends the cursor’s section right after its last content line', () => {
        // Cursor inside "First body." — the section runs to just before
        // "### Nested"? No: a NESTED subsection belongs to its parent, so
        // "## First" ends at "## Second".
        const inFirst = offsetOf('First body')
        const point = sectionInsertionPoint(NOTE, inFirst)
        expect(NOTE.slice(point - 'Nested body.'.length, point)).toBe('Nested body.')
    })

    it('a nested section ends before the next heading of same-or-higher level', () => {
        const inNested = offsetOf('Nested body')
        const point = sectionInsertionPoint(NOTE, inNested)
        expect(NOTE.slice(point - 'Nested body.'.length, point)).toBe('Nested body.')
    })

    it('an offset ON a heading line targets that heading’s section', () => {
        const onHeading = offsetOf('## First')
        const point = sectionInsertionPoint(NOTE, onHeading)
        expect(NOTE.slice(point - 'Nested body.'.length, point)).toBe('Nested body.')
    })

    it('the preamble ends before the first heading', () => {
        const point = sectionInsertionPoint(NOTE, 3)
        expect(NOTE.slice(0, point)).toBe('Preamble line.')
    })

    it('the last section ends at the end of the note, trailing blanks stepped over', () => {
        const text = `${NOTE}\n\n\n`
        const point = sectionInsertionPoint(text, offsetOf('Second body'))
        expect(text.slice(point - 'Second body.'.length, point)).toBe('Second body.')
    })

    it('an empty section answers the end of its own heading line', () => {
        const text = '# A\n## Empty\n## Next\nBody.'
        const point = sectionInsertionPoint(text, text.indexOf('## Empty'))
        expect(text.slice(point - '## Empty'.length, point)).toBe('## Empty')
    })

    it('heading-looking lines inside code fences do not split a section', () => {
        const text = '# Only\nBefore.\n```\n# not a heading\n```\nAfter.'
        const point = sectionInsertionPoint(text, text.indexOf('Before'))
        expect(text.slice(point - 'After.'.length, point)).toBe('After.')
    })

    it('a note with no headings is one section ending at its content end', () => {
        const text = 'Just prose.\nMore prose.\n'
        const point = sectionInsertionPoint(text, 0)
        expect(text.slice(point - 'More prose.'.length, point)).toBe('More prose.')
    })
})
