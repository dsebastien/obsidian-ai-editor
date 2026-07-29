import { describe, expect, it } from 'bun:test'
import { basenameOf, matchTier, rankNotePaths } from './note-path-ranking'

const PATHS = [
    '10 Meta/My Voice Profile.md',
    '10 Meta/Voice Notes/Recording Setup.md',
    '20 Areas/Writing/Voice and Tone.md',
    '30 Notes/Profiles.md',
    'Inbox/Untitled.md'
]

describe('basenameOf', () => {
    it('strips folders and the md extension', () => {
        expect(basenameOf('10 Meta/My Voice Profile.md')).toEqual('My Voice Profile')
    })

    it('handles root-level paths and non-md files', () => {
        expect(basenameOf('Untitled.md')).toEqual('Untitled')
        expect(basenameOf('assets/logo.png')).toEqual('logo.png')
    })
})

describe('matchTier', () => {
    it('ranks basename prefix above basename substring above path substring', () => {
        expect(matchTier('my voice', '10 Meta/My Voice Profile.md')).toEqual('basename-prefix')
        expect(matchTier('voice', '20 Areas/Writing/Voice and Tone.md')).toEqual('basename-prefix')
        expect(matchTier('profile', '10 Meta/My Voice Profile.md')).toEqual('basename-substring')
        expect(matchTier('meta', '10 Meta/My Voice Profile.md')).toEqual('path-substring')
        expect(matchTier('nope', '10 Meta/My Voice Profile.md')).toEqual('none')
    })

    it('is case-insensitive and trims the query', () => {
        expect(matchTier('  MY VOICE ', '10 Meta/My Voice Profile.md')).toEqual('basename-prefix')
    })

    it('matches everything weakly on an empty query', () => {
        expect(matchTier('', 'Inbox/Untitled.md')).toEqual('path-substring')
    })
})

describe('rankNotePaths', () => {
    it('orders by tier then basename', () => {
        expect(rankNotePaths('voice', PATHS)).toEqual([
            // basename prefix, alphabetical by basename
            '20 Areas/Writing/Voice and Tone.md',
            // basename substring
            '10 Meta/My Voice Profile.md',
            // path substring only
            '10 Meta/Voice Notes/Recording Setup.md'
        ])
    })

    it('drops excluded (already referenced) paths', () => {
        const ranked = rankNotePaths('voice', PATHS, {
            exclude: new Set(['10 Meta/My Voice Profile.md'])
        })
        expect(ranked).not.toContain('10 Meta/My Voice Profile.md')
        expect(ranked).toHaveLength(2)
    })

    it('applies the limit after ranking', () => {
        expect(rankNotePaths('', PATHS, { limit: 2 })).toHaveLength(2)
    })

    it('returns nothing when nothing matches', () => {
        expect(rankNotePaths('zzz-does-not-exist', PATHS)).toEqual([])
    })
})
