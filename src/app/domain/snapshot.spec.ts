import { describe, expect, it } from 'bun:test'
import { createSnapshot, hashText } from './snapshot'

describe('hashText', () => {
    it('is deterministic', () => {
        expect(hashText('hello world')).toEqual(hashText('hello world'))
    })

    it('differs for different content', () => {
        expect(hashText('hello world')).not.toEqual(hashText('hello world!'))
        expect(hashText('a')).not.toEqual(hashText('b'))
        expect(hashText('')).not.toEqual(hashText(' '))
    })

    it('is sensitive to character order', () => {
        expect(hashText('ab')).not.toEqual(hashText('ba'))
    })

    it('handles unicode content', () => {
        expect(hashText('héllo — “wörld”')).toEqual(hashText('héllo — “wörld”'))
        expect(hashText('héllo')).not.toEqual(hashText('hello'))
    })
})

describe('createSnapshot', () => {
    it('captures text, path, and hash', () => {
        const snapshot = createSnapshot({ filePath: 'notes/Test.md', text: '# Title\n\nBody.' })
        expect(snapshot.filePath).toEqual('notes/Test.md')
        expect(snapshot.text).toEqual('# Title\n\nBody.')
        expect(snapshot.hash).toEqual(hashText('# Title\n\nBody.'))
        expect(snapshot.id.length).toBeGreaterThan(0)
        expect(snapshot.selection).toBeUndefined()
    })

    it('captures the selection when provided', () => {
        const snapshot = createSnapshot({
            filePath: 'a.md',
            text: 'abcdef',
            selection: { from: 1, to: 4 }
        })
        expect(snapshot.selection).toEqual({ from: 1, to: 4 })
    })

    it('generates unique ids', () => {
        const a = createSnapshot({ filePath: 'a.md', text: 'x' })
        const b = createSnapshot({ filePath: 'a.md', text: 'x' })
        expect(a.id).not.toEqual(b.id)
        expect(a.hash).toEqual(b.hash)
    })
})
