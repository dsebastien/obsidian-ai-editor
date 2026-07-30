import { describe, expect, test } from 'bun:test'
import { editorConfigSchema, pluginSettingsSchema } from '../domain/settings/settings-schema'
import type { ContextPreview } from '../services/context-preview-service'
import type { ContextSection } from '../services/context/context-budget'
import {
    formatChars,
    formatCount,
    previewClipboardText,
    previewEditorChoices,
    previewSummaryLines,
    refusalMessage,
    sectionRows
} from './context-preview-model'

function section(overrides: Partial<ContextSection> = {}): ContextSection {
    return {
        kind: 'prompt-ref',
        label: 'Prompt note',
        path: 'Meta/Persona.md',
        sourceChars: 100,
        sentChars: 100,
        status: 'sent',
        ...overrides
    }
}

function preview(overrides: Partial<ContextPreview> = {}): ContextPreview {
    return {
        editorId: 'editor-1',
        editorName: 'Hater',
        notePath: 'Articles/Draft.md',
        systemPrompt: 'Be harsh.',
        sections: [
            section({ kind: 'system-prompt', label: 'System prompt', path: null }),
            section({ kind: 'reviewed-note', label: 'Reviewed note', path: 'Articles/Draft.md' })
        ],
        budget: {
            budgetChars: 200_000,
            totalChars: 200,
            overBudgetChars: 0,
            truncatedPaths: [],
            droppedPaths: []
        },
        backendLabel: 'Claude (claude-test-1)',
        backendIssue: null,
        ...overrides
    }
}

describe('formatCount / formatChars', () => {
    test('groups in threes with a locale-independent separator', () => {
        expect(formatCount(0)).toBe('0')
        expect(formatCount(999)).toBe('999')
        expect(formatCount(1_000)).toBe('1 000')
        expect(formatCount(200_000)).toBe('200 000')
        expect(formatCount(1_234_567)).toBe('1 234 567')
    })

    test('singularizes exactly one character', () => {
        expect(formatChars(1)).toBe('1 character')
        expect(formatChars(0)).toBe('0 characters')
        expect(formatChars(2_500)).toBe('2 500 characters')
    })
})

describe('previewSummaryLines', () => {
    test('states the total against the budget and the section count', () => {
        const lines = previewSummaryLines(preview())
        expect(lines[0]).toBe('Total: 200 characters of a 200 000 character budget.')
        expect(lines[1]).toBe('Sections: 2.')
        expect(lines.at(-1)).toBe('Backend: Claude (claude-test-1).')
    })

    test('names every truncated and dropped note', () => {
        const lines = previewSummaryLines(
            preview({
                budget: {
                    budgetChars: 1_000,
                    totalChars: 1_000,
                    overBudgetChars: 0,
                    truncatedPaths: ['Big.md'],
                    droppedPaths: ['Late.md', 'Later.md']
                }
            })
        )
        expect(lines.join('\n')).toContain('Truncated to fit: 1 — Big.md.')
        expect(lines.join('\n')).toContain('Dropped, budget exhausted: 2 — Late.md, Later.md.')
    })

    test('says plainly when the request goes out over budget', () => {
        const lines = previewSummaryLines(
            preview({
                budget: {
                    budgetChars: 1_000,
                    totalChars: 1_200,
                    overBudgetChars: 200,
                    truncatedPaths: [],
                    droppedPaths: ['Ref.md']
                }
            })
        )
        const text = lines.join('\n')
        expect(text).toContain('Over budget by 200 characters')
        expect(text).toContain('never truncated')
    })

    test('reports the blocking reason instead of a backend when none resolves', () => {
        const lines = previewSummaryLines(
            preview({ backendLabel: null, backendIssue: 'backend-disabled' })
        )
        expect(lines.at(-1)).toBe('This editor cannot run: its backend is disabled.')
    })

    test('omits the backend line entirely when there is nothing to say', () => {
        const lines = previewSummaryLines(preview({ backendLabel: null, backendIssue: null }))
        expect(lines.some((line) => line.startsWith('Backend'))).toBe(false)
        expect(lines.some((line) => line.includes('cannot run'))).toBe(false)
    })
})

describe('sectionRows', () => {
    test('names a pathless section by its label alone', () => {
        const rows = sectionRows(
            preview({
                sections: [section({ kind: 'system-prompt', label: 'System prompt', path: null })]
            })
        )
        expect(rows[0]).toEqual({
            name: 'System prompt',
            detail: '100 characters',
            status: 'sent'
        })
    })

    test('shows sent-of-source and the consequence for truncated and dropped rows', () => {
        const rows = sectionRows(
            preview({
                sections: [
                    section({ sourceChars: 2_000, sentChars: 800, status: 'truncated' }),
                    section({
                        kind: 'linked-note',
                        label: 'Linked from the reviewed note',
                        path: 'Late.md',
                        sourceChars: 10,
                        sentChars: 0,
                        status: 'dropped'
                    })
                ]
            })
        )
        expect(rows[0]?.detail).toBe('800 characters of 2 000 — Truncated to fit the budget')
        expect(rows[1]).toEqual({
            name: 'Linked from the reviewed note — Late.md',
            detail: '0 characters of 10 — Dropped — budget exhausted',
            status: 'dropped'
        })
    })
})

describe('previewClipboardText', () => {
    test('ends with the verbatim system prompt so a paste reproduces the request', () => {
        const text = previewClipboardText(preview({ systemPrompt: 'LINE 1\nLINE 2' }))
        expect(text).toEndWith('System prompt:\nLINE 1\nLINE 2')
        expect(text).toContain('Editor: Hater')
        expect(text).toContain('Note: Articles/Draft.md')
        expect(text).toContain('- Reviewed note — Articles/Draft.md: 100 characters')
    })
})

describe('previewEditorChoices', () => {
    test('offers the enabled editors in settings order', () => {
        const settings = pluginSettingsSchema.parse({
            editors: [
                editorConfigSchema.parse({ id: 'a', name: 'Hater' }),
                editorConfigSchema.parse({ id: 'b', name: 'Off', enabled: false }),
                editorConfigSchema.parse({ id: 'c', name: 'Humanizer' })
            ]
        })
        expect(previewEditorChoices(settings)).toEqual([
            { id: 'a', name: 'Hater' },
            { id: 'c', name: 'Humanizer' }
        ])
    })

    test('is empty when no editor is enabled', () => {
        const settings = pluginSettingsSchema.parse({
            editors: [editorConfigSchema.parse({ id: 'a', name: 'Off', enabled: false })]
        })
        expect(previewEditorChoices(settings)).toEqual([])
    })
})

describe('refusalMessage', () => {
    test('sends the excluded case to the Behavior tab and the rule case to the Rules tab', () => {
        expect(refusalMessage({ status: 'excluded', notePath: 'Private/D.md' })).toContain(
            'Behavior tab'
        )
        expect(
            refusalMessage({
                status: 'rule-disabled',
                notePath: 'Private/D.md',
                ruleLabel: 'No AI here'
            })
        ).toContain('Rules tab')
    })

    test('names the rule so the user can find it', () => {
        expect(
            refusalMessage({ status: 'rule-disabled', notePath: 'D.md', ruleLabel: 'No AI here' })
        ).toContain('"No AI here"')
    })

    test('distinguishes an unreadable note from a deleted editor', () => {
        expect(refusalMessage({ status: 'note-unreadable', notePath: 'Gone.md' })).toContain(
            'Gone.md'
        )
        expect(refusalMessage({ status: 'editor-missing' })).toContain('no longer exists')
    })
})
