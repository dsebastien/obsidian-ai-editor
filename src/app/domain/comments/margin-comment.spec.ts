import { describe, expect, it } from 'bun:test'
import {
    COMMENT_STORE_SCHEMA_VERSION,
    countComments,
    loadCommentStore,
    marginCommentSchema,
    MAX_COMMENTS_PER_NOTE
} from './margin-comment'
import type { MarginComment } from './margin-comment'

function comment(overrides: Partial<MarginComment> = {}): MarginComment {
    return marginCommentSchema.parse({
        id: 'c1',
        quote: 'the quick brown fox',
        instruction: 'Is this cliché?',
        editorId: 'editor-1',
        editorName: 'Concision Editor',
        status: 'done',
        createdAt: 1_000,
        updatedAt: 2_000,
        ...overrides
    })
}

function file(notes: Record<string, unknown>): unknown {
    return { schemaVersion: COMMENT_STORE_SCHEMA_VERSION, notes }
}

describe('margin comment schema', () => {
    it('keeps the locating hints and never invents offsets', () => {
        const parsed = comment({ prefix: 'over ', suffix: ' jumps', occurrence: 2 })
        expect(parsed.prefix).toEqual('over ')
        expect(parsed.suffix).toEqual(' jumps')
        expect(parsed.occurrence).toEqual(2)
        // Offsets are deliberately absent from the persisted shape: a stored
        // position would look authoritative after an out-of-session edit.
        expect(Object.keys(parsed)).not.toContain('from')
        expect(Object.keys(parsed)).not.toContain('to')
    })

    it('defaults the answer fields so a freshly submitted comment validates', () => {
        const parsed = comment({ status: 'submitted' })
        expect(parsed.findings).toEqual([])
        expect(parsed.reply).toBeUndefined()
        expect(parsed.error).toBeUndefined()
    })

    it('refuses a comment with no quote to anchor by', () => {
        expect(marginCommentSchema.safeParse({ ...comment(), quote: '' }).success).toBe(false)
    })

    it('refuses an unknown status rather than defaulting it', () => {
        expect(marginCommentSchema.safeParse({ ...comment(), status: 'pending' }).success).toBe(
            false
        )
    })

    it('validates the findings a completed job carries through the operation contract', () => {
        const withFinding = marginCommentSchema.safeParse({
            ...comment(),
            findings: [{ quote: 'fox', critique: 'Overused.' }]
        })
        expect(withFinding.success).toBe(true)
        const bogus = marginCommentSchema.safeParse({
            ...comment(),
            findings: [{ quote: '', critique: '' }]
        })
        expect(bogus.success).toBe(false)
    })
})

describe('loadCommentStore', () => {
    it('reads a clean file unchanged', () => {
        const loaded = loadCommentStore(file({ 'Notes/One.md': [comment()] }))
        expect(loaded.unreadable).toBe(false)
        expect(loaded.dropped).toEqual([])
        expect(loaded.interrupted).toEqual([])
        expect(countComments(loaded.store)).toEqual(1)
        expect(loaded.store.schemaVersion).toEqual(COMMENT_STORE_SCHEMA_VERSION)
    })

    it('reports an unusable file instead of throwing', () => {
        for (const raw of [null, undefined, 42, 'text', [], {}, { notes: [] }, { notes: 3 }]) {
            const loaded = loadCommentStore(raw)
            expect(loaded.unreadable).toBe(true)
            expect(countComments(loaded.store)).toEqual(0)
        }
    })

    it('salvages per comment: one bad entry never costs its siblings', () => {
        const loaded = loadCommentStore(
            file({
                'A.md': [comment({ id: 'ok-1' }), { id: 'broken' }, comment({ id: 'ok-2' })],
                'B.md': [comment({ id: 'ok-3' })]
            })
        )
        expect(loaded.unreadable).toBe(false)
        expect(loaded.dropped).toEqual(['A.md[1]'])
        expect(loaded.store.notes['A.md']?.map((entry) => entry.id)).toEqual(['ok-1', 'ok-2'])
        expect(loaded.store.notes['B.md']?.map((entry) => entry.id)).toEqual(['ok-3'])
    })

    it('drops a note entry that is not a list of comments, keeping the others', () => {
        const loaded = loadCommentStore(file({ 'A.md': 'nonsense', 'B.md': [comment()] }))
        expect(loaded.dropped).toEqual(['A.md'])
        expect(Object.keys(loaded.store.notes)).toEqual(['B.md'])
    })

    it('omits a note whose every comment was dropped rather than keeping an empty list', () => {
        const loaded = loadCommentStore(file({ 'A.md': [{ id: 'broken' }] }))
        expect(loaded.dropped).toEqual(['A.md[0]'])
        expect(loaded.store.notes['A.md']).toBeUndefined()
    })

    it('enforces the per-note cap and reports what it left out', () => {
        const many = Array.from({ length: MAX_COMMENTS_PER_NOTE + 2 }, (_unused, index) =>
            comment({ id: `c${index}` })
        )
        const loaded = loadCommentStore(file({ 'A.md': many }))
        expect(loaded.store.notes['A.md']?.length).toEqual(MAX_COMMENTS_PER_NOTE)
        expect(loaded.dropped).toEqual([
            `A.md[${MAX_COMMENTS_PER_NOTE}]`,
            `A.md[${MAX_COMMENTS_PER_NOTE + 1}]`
        ])
    })

    it('never lets an in-flight job load back as still running (plan M8: Retry, no fake resumption)', () => {
        const loaded = loadCommentStore(
            file({
                'A.md': [
                    comment({ id: 'was-running', status: 'running' }),
                    comment({ id: 'was-submitted', status: 'submitted' }),
                    comment({ id: 'finished', status: 'done' }),
                    comment({ id: 'closed', status: 'dismissed' })
                ]
            })
        )
        expect(loaded.store.notes['A.md']?.map((entry) => entry.status)).toEqual([
            'interrupted',
            'interrupted',
            'done',
            'dismissed'
        ])
        expect(loaded.interrupted).toEqual(['was-running', 'was-submitted'])
    })

    it('keeps an already-interrupted comment interrupted without re-reporting it', () => {
        const loaded = loadCommentStore(file({ 'A.md': [comment({ status: 'interrupted' })] }))
        expect(loaded.store.notes['A.md']?.[0]?.status).toEqual('interrupted')
        expect(loaded.interrupted).toEqual([])
    })
})
