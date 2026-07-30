import { describe, expect, test } from 'bun:test'
import {
    ATTACHMENT_PRIORITY,
    allocateAttachments,
    sectionKindLabel,
    sectionStatusLabel,
    summarizeBudget,
    type ContextSection,
    type ContextSectionKind,
    type ContextSectionStatus
} from './context-budget'

function section(overrides: Partial<ContextSection> = {}): ContextSection {
    return {
        kind: 'prompt-ref',
        label: 'Prompt note',
        path: 'Ref.md',
        sourceChars: 10,
        sentChars: 10,
        status: 'sent',
        ...overrides
    }
}

describe('ATTACHMENT_PRIORITY', () => {
    test('is the locked send/priority order, highest first', () => {
        expect([...ATTACHMENT_PRIORITY]).toEqual([
            'prompt-ref',
            'wikilink-ref',
            'followed-link',
            'linked-note'
        ])
    })
})

describe('allocateAttachments', () => {
    test('sends everything that fits in the remainder', () => {
        const result = allocateAttachments({
            budgetChars: 100,
            fixedChars: 40,
            attachmentChars: [30, 30]
        })
        expect(result.allocations).toEqual([
            { sentChars: 30, status: 'sent' },
            { sentChars: 30, status: 'sent' }
        ])
        expect(result.overBudgetChars).toBe(0)
    })

    test('truncates the first attachment that does not fit and drops the rest', () => {
        const result = allocateAttachments({
            budgetChars: 100,
            fixedChars: 40,
            attachmentChars: [30, 100, 5]
        })
        expect(result.allocations).toEqual([
            { sentChars: 30, status: 'sent' },
            { sentChars: 30, status: 'truncated' },
            { sentChars: 0, status: 'dropped' }
        ])
    })

    test('an exact fit is sent, not truncated', () => {
        const result = allocateAttachments({
            budgetChars: 100,
            fixedChars: 40,
            attachmentChars: [60, 1]
        })
        expect(result.allocations).toEqual([
            { sentChars: 60, status: 'sent' },
            { sentChars: 0, status: 'dropped' }
        ])
    })

    test('a zero remainder drops rather than truncates to nothing', () => {
        // "Truncated" promises a prefix arrives; an empty prefix is no
        // content at all, so it must report as dropped.
        const result = allocateAttachments({
            budgetChars: 40,
            fixedChars: 40,
            attachmentChars: [10]
        })
        expect(result.allocations).toEqual([{ sentChars: 0, status: 'dropped' }])
        expect(result.overBudgetChars).toBe(0)
    })

    test('reports the overflow when the never-truncated sections alone exceed the budget', () => {
        const result = allocateAttachments({
            budgetChars: 100,
            fixedChars: 250,
            attachmentChars: [10, 10]
        })
        expect(result.allocations.every((a) => a.status === 'dropped')).toBe(true)
        expect(result.overBudgetChars).toBe(150)
    })

    test('returns one allocation per attachment, in the given order', () => {
        const result = allocateAttachments({
            budgetChars: 10,
            fixedChars: 0,
            attachmentChars: [4, 4, 4, 4]
        })
        expect(result.allocations).toHaveLength(4)
        expect(result.allocations.map((a) => a.status)).toEqual([
            'sent',
            'sent',
            'truncated',
            'dropped'
        ])
    })

    test('handles an empty attachment list', () => {
        expect(
            allocateAttachments({ budgetChars: 10, fixedChars: 2, attachmentChars: [] })
        ).toEqual({ allocations: [], overBudgetChars: 0 })
    })
})

describe('summarizeBudget', () => {
    test('totals what is sent and splits truncated from dropped, in send order', () => {
        const report = summarizeBudget(
            [
                section({ kind: 'system-prompt', path: null, sourceChars: 5, sentChars: 5 }),
                section({ kind: 'reviewed-note', path: 'Note.md', sourceChars: 7, sentChars: 7 }),
                section({ path: 'A.md', sourceChars: 100, sentChars: 40, status: 'truncated' }),
                section({ path: 'B.md', sourceChars: 100, sentChars: 0, status: 'dropped' }),
                section({ path: 'C.md', sourceChars: 100, sentChars: 0, status: 'dropped' })
            ],
            1_000,
            0
        )
        expect(report).toEqual({
            budgetChars: 1_000,
            totalChars: 52,
            overBudgetChars: 0,
            truncatedPaths: ['A.md'],
            droppedPaths: ['B.md', 'C.md']
        })
    })

    test('never lists a pathless section among truncated or dropped paths', () => {
        const report = summarizeBudget(
            [section({ kind: 'system-prompt', path: null, sentChars: 0, status: 'dropped' })],
            10,
            0
        )
        expect(report.droppedPaths).toEqual([])
    })
})

describe('labels', () => {
    test('every section kind has a sentence-case label', () => {
        const kinds: readonly ContextSectionKind[] = [
            'system-prompt',
            'reviewed-note',
            ...ATTACHMENT_PRIORITY
        ]
        for (const kind of kinds) {
            const label = sectionKindLabel(kind)
            expect(label.length).toBeGreaterThan(0)
            expect(label[0]).toBe(label[0]?.toUpperCase())
        }
    })

    test('every status has a label that names the budget consequence', () => {
        const statuses: readonly ContextSectionStatus[] = ['sent', 'truncated', 'dropped']
        const labels = statuses.map((status) => sectionStatusLabel(status))
        expect(new Set(labels).size).toBe(3)
        expect(sectionStatusLabel('dropped')).toContain('budget')
    })
})
