import { describe, expect, it } from 'bun:test'
import type { HistoryEntry } from '../domain/history/history-entry'
import {
    applyFilters,
    availableEditors,
    availableKinds,
    groupByDay,
    NO_HISTORY_FILTERS
} from './history-tab'

const NOW = new Date(2026, 7, 2, 15, 0).getTime()
const DAY = 24 * 60 * 60 * 1_000

function entry(overrides: Partial<HistoryEntry>): HistoryEntry {
    return {
        id: Math.random().toString(36).slice(2),
        at: NOW,
        filePath: 'a.md',
        editorId: 'e1',
        editorName: 'Hater',
        kind: 'finding',
        key: '',
        quote: '',
        text: '',
        edits: [],
        label: '',
        ...overrides
    }
}

describe('history tab model (issue #21)', () => {
    it('derives available kinds in display order and editors alphabetically', () => {
        const entries = [
            entry({ kind: 'scorecard', editorName: 'Panel' }),
            entry({ kind: 'finding', editorName: 'Beginner' }),
            entry({ kind: 'finding', editorName: 'Hater' })
        ]
        expect(availableKinds(entries)).toEqual(['finding', 'scorecard'])
        expect(availableEditors(entries)).toEqual(['Beginner', 'Hater', 'Panel'])
    })

    it('empty filters show everything; active filters narrow by kind AND editor', () => {
        const keep = entry({ kind: 'finding', editorName: 'Hater' })
        const other = entry({ kind: 'thread', editorName: 'Beginner' })
        expect(applyFilters([keep, other], NO_HISTORY_FILTERS)).toHaveLength(2)
        const filtered = applyFilters([keep, other], {
            kinds: new Set(['finding']),
            editorNames: new Set(['Hater'])
        })
        expect(filtered).toEqual([keep])
    })

    it('groups by day, newest first, with Today/Yesterday labels', () => {
        const groups = groupByDay(
            [
                entry({ at: NOW }),
                entry({ at: NOW - 60_000 }),
                entry({ at: NOW - DAY }),
                entry({ at: NOW - 3 * DAY })
            ],
            NOW
        )
        expect(groups).toHaveLength(3)
        expect(groups[0]?.label).toBe('Today')
        expect(groups[0]?.entries).toHaveLength(2)
        expect(groups[1]?.label).toBe('Yesterday')
        expect(groups[2]?.label).not.toMatch(/Today|Yesterday/)
    })
})
