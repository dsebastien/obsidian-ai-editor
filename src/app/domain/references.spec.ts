import { describe, expect, it } from 'bun:test'
import {
    formatReference,
    referenceFootnote,
    referenceSectionInsertion,
    getSourceAddedPlacement,
    isSourceAlreadyAdded
} from './references'

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

describe('getSourceAddedPlacement (issue #30)', () => {
    it('detects a source already added as a footnote', () => {
        const source = { title: 'Study', url: 'https://x.test' }
        const text = 'Some text. ^[[Study](https://x.test)] More text.'
        expect(getSourceAddedPlacement(text, source)).toBe('footnote')
    })

    it('detects a source already added as a bullet in References section', () => {
        const source = { title: 'Study', url: 'https://x.test' }
        const text = '# Note\nBody.\n\n## References\n- [Study](https://x.test)'
        expect(getSourceAddedPlacement(text, source)).toBe('section')
    })

    it('returns null when the source is not yet added', () => {
        const source = { title: 'Study', url: 'https://x.test' }
        const text = '# Note\nBody with no references.'
        expect(getSourceAddedPlacement(text, source)).toBeNull()
    })

    it('matches case-insensitively for both footnotes and sections', () => {
        const source = { title: 'Study', url: 'https://X.TEST' }
        const footnoteText = 'Text. ^[[study](https://x.test)] More.'
        expect(getSourceAddedPlacement(footnoteText, source)).toBe('footnote')

        const sectionText = '# Note\n\n## References\n- [STUDY](https://X.test)'
        expect(getSourceAddedPlacement(sectionText, source)).toBe('section')
    })

    it('requires exact URL match; partial URLs do not match', () => {
        const source = { title: 'Study', url: 'https://x.test/full/path' }
        const partial = '# Note\n- [Study](https://x.test)'
        expect(getSourceAddedPlacement(partial, source)).toBeNull()
    })

    it('extracts only the correct References section (stops at next heading)', () => {
        const source = { title: 'Study', url: 'https://x.test' }
        const text =
            '# Note\nBody.\n\n## References\n- [Old](https://old.test)\n\n## Next Section\n- [Study](https://x.test)'
        // The footnote is after the References section, so should not be found there
        expect(getSourceAddedPlacement(text, source)).toBeNull()
    })

    it('keeps deeper subsections inside the References section', () => {
        const source = { title: 'Study', url: 'https://x.test' }
        const text =
            '# Note\n\n## References\n### Academic\n- [Study](https://x.test)\n\n## Next Section'
        // The level-3 subsection belongs to the level-2 References section, so
        // a bullet under it counts as already added.
        expect(getSourceAddedPlacement(text, source)).toBe('section')
    })

    it('stops the References section at a higher-level heading', () => {
        const source = { title: 'Study', url: 'https://x.test' }
        const text =
            '# Note\n\n### References\n- [Old](https://old.test)\n\n# Top\n- [Study](https://x.test)'
        expect(getSourceAddedPlacement(text, source)).toBeNull()
    })

    it('handles title-only sources (no URL) in References section only', () => {
        const source = { title: 'Personal Communication', url: undefined }
        const text =
            '# Note\nBody mentions Personal Communication.\n\n## References\n- Personal Communication'
        // Should find it in References, not in body text
        expect(getSourceAddedPlacement(text, source)).toBe('section')
    })

    it('does not match title-only sources in body text (only References section)', () => {
        const source = { title: 'Study', url: undefined }
        const text = '# Note\nThis Study was performed. No References section.'
        expect(getSourceAddedPlacement(text, source)).toBeNull()
    })

    it('round-trips a title-only footnote add (Add as footnote is offered without a URL)', () => {
        const source = { title: 'Personal Communication', url: undefined }
        const text = `# Note\nA claim.${referenceFootnote(source)}\nMore text.`
        // The dedup MUST report the footnote, or the card would keep offering
        // Add and let the same source be footnoted twice.
        expect(getSourceAddedPlacement(text, source)).toBe('footnote')
    })

    it('flattens brackets in title when matching (matches formatReference behavior)', () => {
        const source = { title: 'Report [2024]', url: 'https://x.test' }
        const text = '# Note\n\n## References\n- [Report 2024](https://x.test)'
        expect(getSourceAddedPlacement(text, source)).toBe('section')
    })

    it('handles multiple footnotes and finds the matching one', () => {
        const source = { title: 'Study A', url: 'https://a.test' }
        const text = 'Text ^[[Study B](https://b.test)] more ^[[Study A](https://a.test)] end.'
        expect(getSourceAddedPlacement(text, source)).toBe('footnote')
    })

    it('handles References section with multiple bullets', () => {
        const source = { title: 'Study C', url: 'https://c.test' }
        const text =
            '# Note\n\n## References\n- [Study A](https://a.test)\n- [Study B](https://b.test)\n- [Study C](https://c.test)'
        expect(getSourceAddedPlacement(text, source)).toBe('section')
    })
})

describe('isSourceAlreadyAdded (issue #30)', () => {
    it('returns true when source is in footnote or References', () => {
        const source = { title: 'Study', url: 'https://x.test' }
        const footnoteText = 'Text. ^[[Study](https://x.test)]'
        expect(isSourceAlreadyAdded(footnoteText, source)).toBeTrue()

        const sectionText = '# Note\n\n## References\n- [Study](https://x.test)'
        expect(isSourceAlreadyAdded(sectionText, source)).toBeTrue()
    })

    it('returns false when source is not found', () => {
        const source = { title: 'Study', url: 'https://x.test' }
        const text = '# Note\nNo sources here.'
        expect(isSourceAlreadyAdded(text, source)).toBeFalse()
    })
})
