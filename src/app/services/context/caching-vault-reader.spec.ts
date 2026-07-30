import { describe, expect, test } from 'bun:test'

import { createCachingVaultReader } from './caching-vault-reader'
import type { NoteMetadata, VaultReader } from './vault-reader.intf'

interface Counts {
    readNote: number
    resolveLink: number
    getOutgoingLinks: number
    getNoteMetadata: number
    getNoteTypeIds: number
}

function countingReader(overrides: Partial<VaultReader> = {}): {
    reader: VaultReader
    counts: Counts
} {
    const counts: Counts = {
        readNote: 0,
        resolveLink: 0,
        getOutgoingLinks: 0,
        getNoteMetadata: 0,
        getNoteTypeIds: 0
    }
    const reader: VaultReader = {
        readNote(path: string): Promise<string | null> {
            counts.readNote += 1
            return Promise.resolve(path === 'Missing.md' ? null : `content of ${path}`)
        },
        resolveLink(linkText: string, fromPath: string): string | null {
            counts.resolveLink += 1
            return linkText === 'Nowhere' ? null : `${fromPath}/${linkText}.md`
        },
        getOutgoingLinks(path: string): string[] {
            counts.getOutgoingLinks += 1
            return path === 'Leaf.md' ? [] : ['A.md', 'B.md']
        },
        getNoteMetadata(path: string): NoteMetadata | null {
            counts.getNoteMetadata += 1
            return path === 'Missing.md' ? null : { tags: ['t'], frontmatter: { k: 1 } }
        },
        getNoteTypeIds(path: string): readonly string[] {
            counts.getNoteTypeIds += 1
            return path === 'Typed.md' ? ['permanent-notes'] : []
        },
        ...overrides
    }
    return { reader, counts }
}

describe('createCachingVaultReader — answers each question once', () => {
    test('reads a note once however many editors ask', async () => {
        const { reader, counts } = countingReader()
        const cached = createCachingVaultReader(reader)
        expect(await cached.readNote('A.md')).toBe('content of A.md')
        expect(await cached.readNote('A.md')).toBe('content of A.md')
        expect(await cached.readNote('A.md')).toBe('content of A.md')
        expect(counts.readNote).toBe(1)
    })

    test('caches "this note does not exist" like any other answer', async () => {
        const { reader, counts } = countingReader()
        const cached = createCachingVaultReader(reader)
        expect(await cached.readNote('Missing.md')).toBeNull()
        expect(await cached.readNote('Missing.md')).toBeNull()
        expect(counts.readNote).toBe(1)
    })

    test('concurrent readers share ONE read', async () => {
        const { reader, counts } = countingReader()
        const cached = createCachingVaultReader(reader)
        const [left, right] = await Promise.all([cached.readNote('A.md'), cached.readNote('A.md')])
        expect(left).toBe(right)
        expect(counts.readNote).toBe(1)
    })

    test('resolves a link once per (origin, target) pair', () => {
        const { reader, counts } = countingReader()
        const cached = createCachingVaultReader(reader)
        cached.resolveLink('Index', 'Notes')
        cached.resolveLink('Index', 'Notes')
        expect(counts.resolveLink).toBe(1)
    })

    test('keys link resolution by the LINKING note, not the link text alone', () => {
        // `[[Index]]` from two folders can resolve to two different notes.
        const { reader, counts } = countingReader()
        const cached = createCachingVaultReader(reader)
        expect(cached.resolveLink('Index', 'Notes')).toBe('Notes/Index.md')
        expect(cached.resolveLink('Index', 'Drafts')).toBe('Drafts/Index.md')
        expect(counts.resolveLink).toBe(2)
    })

    test('caches an unresolvable link', () => {
        const { reader, counts } = countingReader()
        const cached = createCachingVaultReader(reader)
        expect(cached.resolveLink('Nowhere', 'Notes')).toBeNull()
        expect(cached.resolveLink('Nowhere', 'Notes')).toBeNull()
        expect(counts.resolveLink).toBe(1)
    })

    test('walks a note’s outgoing links once', () => {
        const { reader, counts } = countingReader()
        const cached = createCachingVaultReader(reader)
        expect(cached.getOutgoingLinks('A.md')).toEqual(['A.md', 'B.md'])
        expect(cached.getOutgoingLinks('A.md')).toEqual(['A.md', 'B.md'])
        expect(counts.getOutgoingLinks).toBe(1)
    })

    test('caches an EMPTY link list (a leaf note is an answer too)', () => {
        const { reader, counts } = countingReader()
        const cached = createCachingVaultReader(reader)
        expect(cached.getOutgoingLinks('Leaf.md')).toEqual([])
        expect(cached.getOutgoingLinks('Leaf.md')).toEqual([])
        expect(counts.getOutgoingLinks).toBe(1)
    })

    test('hands out a fresh array so a caller cannot corrupt the cache', () => {
        const { reader } = countingReader()
        const cached = createCachingVaultReader(reader)
        const first = cached.getOutgoingLinks('A.md')
        first.push('Injected.md')
        first.sort()
        expect(cached.getOutgoingLinks('A.md')).toEqual(['A.md', 'B.md'])
    })

    test('reads metadata once, and caches a null cache entry', () => {
        const { reader, counts } = countingReader()
        const cached = createCachingVaultReader(reader)
        expect(cached.getNoteMetadata('A.md')).toEqual({ tags: ['t'], frontmatter: { k: 1 } })
        cached.getNoteMetadata('A.md')
        expect(counts.getNoteMetadata).toBe(1)
        expect(cached.getNoteMetadata('Missing.md')).toBeNull()
        expect(cached.getNoteMetadata('Missing.md')).toBeNull()
        expect(counts.getNoteMetadata).toBe(2)
    })

    test('resolves note types once (the cross-plugin call)', () => {
        const { reader, counts } = countingReader()
        const cached = createCachingVaultReader(reader)
        expect(cached.getNoteTypeIds('Typed.md')).toEqual(['permanent-notes'])
        cached.getNoteTypeIds('Typed.md')
        expect(cached.getNoteTypeIds('Plain.md')).toEqual([])
        cached.getNoteTypeIds('Plain.md')
        expect(counts.getNoteTypeIds).toBe(2)
    })
})

describe('createCachingVaultReader — failure and isolation', () => {
    test('does not cache a rejected read', async () => {
        let calls = 0
        const { reader } = countingReader({
            readNote(): Promise<string | null> {
                calls += 1
                return calls === 1 ? Promise.reject(new Error('boom')) : Promise.resolve('later')
            }
        })
        const cached = createCachingVaultReader(reader)
        let thrown: unknown = null
        try {
            await cached.readNote('A.md')
        } catch (cause: unknown) {
            thrown = cause
        }
        expect(thrown).toBeInstanceOf(Error)
        expect(await cached.readNote('A.md')).toBe('later')
    })

    test('two readers do not share a cache (one per run)', async () => {
        const { reader, counts } = countingReader()
        expect(await createCachingVaultReader(reader).readNote('A.md')).toBe('content of A.md')
        expect(await createCachingVaultReader(reader).readNote('A.md')).toBe('content of A.md')
        expect(counts.readNote).toBe(2)
    })

    test('delegates every question it has not been asked before', () => {
        const { reader, counts } = countingReader()
        const cached = createCachingVaultReader(reader)
        cached.resolveLink('X', 'Notes')
        cached.getOutgoingLinks('X.md')
        cached.getNoteMetadata('X.md')
        cached.getNoteTypeIds('X.md')
        expect(counts).toMatchObject({
            resolveLink: 1,
            getOutgoingLinks: 1,
            getNoteMetadata: 1,
            getNoteTypeIds: 1
        })
    })
})
