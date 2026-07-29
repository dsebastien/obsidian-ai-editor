import { describe, expect, test } from 'bun:test'
import type { App, CachedMetadata } from 'obsidian'
import {
    collectNoteTags,
    frontmatterTagsOf,
    normalizeTag,
    ObsidianVaultReader,
    stripSubpath
} from './obsidian-vault-reader'

/**
 * The reader only touches `vault.getFileByPath`/`cachedRead` and
 * `metadataCache.getFirstLinkpathDest`/`getFileCache`, so a structural fake
 * covers the whole class (all obsidian imports are type-only — no runtime).
 */
interface FakeNote {
    path: string
    extension: string
    content?: string
    cache?: CachedMetadata | null
    readThrows?: boolean
}

interface FakeFile {
    path: string
    extension: string
}

function fakeApp(notes: FakeNote[], links: Record<string, string> = {}): App {
    const byPath = new Map(notes.map((note) => [note.path, note]))
    const asFile = (note: FakeNote): FakeFile => ({ path: note.path, extension: note.extension })
    const app = {
        vault: {
            getFileByPath: (path: string): FakeFile | null => {
                const note = byPath.get(path)
                return note ? asFile(note) : null
            },
            cachedRead: (file: FakeFile): Promise<string> => {
                const note = byPath.get(file.path)
                if (!note || note.readThrows === true || note.content === undefined) {
                    return Promise.reject(new Error('read failed'))
                }
                return Promise.resolve(note.content)
            }
        },
        metadataCache: {
            getFirstLinkpathDest: (linkpath: string, sourcePath: string): FakeFile | null => {
                const target = links[`${sourcePath}|${linkpath}`]
                if (target === undefined) {
                    return null
                }
                const note = byPath.get(target)
                return note ? asFile(note) : null
            },
            getFileCache: (file: FakeFile): CachedMetadata | null => {
                return byPath.get(file.path)?.cache ?? null
            }
        }
    }
    return app as unknown as App
}

describe('stripSubpath', () => {
    test('strips heading and block fragments', () => {
        expect(stripSubpath('Note#Heading')).toBe('Note')
        expect(stripSubpath('Note#^block')).toBe('Note')
        expect(stripSubpath('Note')).toBe('Note')
    })

    test('same-note fragments become empty', () => {
        expect(stripSubpath('#Heading')).toBe('')
        expect(stripSubpath('  ')).toBe('')
    })
})

describe('normalizeTag', () => {
    test('strips a leading # and trims', () => {
        expect(normalizeTag('#topic/sub')).toBe('topic/sub')
        expect(normalizeTag('  plain  ')).toBe('plain')
        expect(normalizeTag('# spaced')).toBe('spaced')
    })

    test('empty values yield null', () => {
        expect(normalizeTag('')).toBeNull()
        expect(normalizeTag('#')).toBeNull()
        expect(normalizeTag('   ')).toBeNull()
    })
})

describe('frontmatterTagsOf', () => {
    test('accepts an array of strings', () => {
        expect(frontmatterTagsOf(['a', '#b', 'c/d'])).toEqual(['a', 'b', 'c/d'])
    })

    test('accepts a single comma-separated string', () => {
        expect(frontmatterTagsOf('a, b,#c')).toEqual(['a', 'b', 'c'])
    })

    test('accepts numbers (YAML years)', () => {
        expect(frontmatterTagsOf([2024, 'a'])).toEqual(['2024', 'a'])
    })

    test('ignores non-tag shapes', () => {
        expect(frontmatterTagsOf(undefined)).toEqual([])
        expect(frontmatterTagsOf(null)).toEqual([])
        expect(frontmatterTagsOf({ nested: true })).toEqual([])
        expect(frontmatterTagsOf([true, {}, ''])).toEqual([])
    })
})

describe('collectNoteTags', () => {
    test('merges inline and frontmatter tags without #, deduplicated', () => {
        const cache = {
            tags: [{ tag: '#alpha' }, { tag: '#beta' }, { tag: '#alpha' }],
            frontmatter: { tags: ['beta', 'gamma'], tag: 'delta' }
        } as unknown as CachedMetadata
        expect(collectNoteTags(cache)).toEqual(['alpha', 'beta', 'gamma', 'delta'])
    })

    test('empty cache yields no tags', () => {
        expect(collectNoteTags({} as CachedMetadata)).toEqual([])
    })
})

describe('ObsidianVaultReader.readNote', () => {
    test('reads markdown content', async () => {
        const reader = new ObsidianVaultReader(
            fakeApp([{ path: 'Note.md', extension: 'md', content: '# Hello' }])
        )
        expect(await reader.readNote('Note.md')).toBe('# Hello')
    })

    test('missing file and non-markdown resolve to null', async () => {
        const reader = new ObsidianVaultReader(
            fakeApp([{ path: 'image.png', extension: 'png', content: 'binary' }])
        )
        expect(await reader.readNote('missing.md')).toBeNull()
        expect(await reader.readNote('image.png')).toBeNull()
    })

    test('a throwing read resolves to null instead of rejecting', async () => {
        const reader = new ObsidianVaultReader(
            fakeApp([{ path: 'Note.md', extension: 'md', readThrows: true }])
        )
        expect(await reader.readNote('Note.md')).toBeNull()
    })
})

describe('ObsidianVaultReader.resolveLink', () => {
    const app = fakeApp(
        [
            { path: 'From.md', extension: 'md' },
            { path: 'Folder/Target.md', extension: 'md' }
        ],
        { 'From.md|Target': 'Folder/Target.md' }
    )
    const reader = new ObsidianVaultReader(app)

    test('resolves link text to a vault-relative path', () => {
        expect(reader.resolveLink('Target', 'From.md')).toBe('Folder/Target.md')
    })

    test('strips subpath fragments before resolving', () => {
        expect(reader.resolveLink('Target#Heading', 'From.md')).toBe('Folder/Target.md')
    })

    test('unresolvable and same-note links yield null', () => {
        expect(reader.resolveLink('Nope', 'From.md')).toBeNull()
        expect(reader.resolveLink('#Heading', 'From.md')).toBeNull()
    })
})

describe('ObsidianVaultReader.getOutgoingLinks', () => {
    test('resolves links and embeds, markdown only, deduplicated', () => {
        const cache = {
            links: [
                { link: 'A' },
                { link: 'A#Heading' },
                { link: 'Image' },
                { link: '#Self' },
                { link: 'Unresolved' }
            ],
            embeds: [{ link: 'B' }, { link: 'A' }]
        } as unknown as CachedMetadata
        const app = fakeApp(
            [
                { path: 'From.md', extension: 'md', cache },
                { path: 'A.md', extension: 'md' },
                { path: 'B.md', extension: 'md' },
                { path: 'pic.png', extension: 'png' }
            ],
            {
                'From.md|A': 'A.md',
                'From.md|B': 'B.md',
                'From.md|Image': 'pic.png'
            }
        )
        const reader = new ObsidianVaultReader(app)
        expect(reader.getOutgoingLinks('From.md')).toEqual(['A.md', 'B.md'])
    })

    test('missing file or cold cache yields []', () => {
        const reader = new ObsidianVaultReader(
            fakeApp([{ path: 'NoCache.md', extension: 'md', cache: null }])
        )
        expect(reader.getOutgoingLinks('missing.md')).toEqual([])
        expect(reader.getOutgoingLinks('NoCache.md')).toEqual([])
    })
})

describe('ObsidianVaultReader.getNoteMetadata', () => {
    test('returns merged tags and a frontmatter copy', () => {
        const cache = {
            tags: [{ tag: '#inline' }],
            frontmatter: { tags: ['fm'], ai_editor: false, title: 'X' }
        } as unknown as CachedMetadata
        const reader = new ObsidianVaultReader(
            fakeApp([{ path: 'Note.md', extension: 'md', cache }])
        )
        const metadata = reader.getNoteMetadata('Note.md')
        expect(metadata).not.toBeNull()
        expect(metadata?.tags).toEqual(['inline', 'fm'])
        expect(metadata?.frontmatter['ai_editor']).toBe(false)
        expect(metadata?.frontmatter['title']).toBe('X')
    })

    test('frontmatter is a copy, not the live cache object', () => {
        const frontmatter = { tags: ['fm'] }
        const cache = { frontmatter } as unknown as CachedMetadata
        const reader = new ObsidianVaultReader(
            fakeApp([{ path: 'Note.md', extension: 'md', cache }])
        )
        const metadata = reader.getNoteMetadata('Note.md')
        expect(metadata?.frontmatter).not.toBe(frontmatter)
    })

    test('missing file or cold cache yields null (exclusions fail closed)', () => {
        const reader = new ObsidianVaultReader(
            fakeApp([{ path: 'NoCache.md', extension: 'md', cache: null }])
        )
        expect(reader.getNoteMetadata('missing.md')).toBeNull()
        expect(reader.getNoteMetadata('NoCache.md')).toBeNull()
    })

    test('cache without frontmatter yields empty frontmatter map', () => {
        const cache = { tags: [{ tag: '#only' }] } as unknown as CachedMetadata
        const reader = new ObsidianVaultReader(
            fakeApp([{ path: 'Note.md', extension: 'md', cache }])
        )
        expect(reader.getNoteMetadata('Note.md')).toEqual({
            tags: ['only'],
            frontmatter: {}
        })
    })
})
