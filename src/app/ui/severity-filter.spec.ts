import { describe, expect, it } from 'bun:test'
import type { Severity } from '../domain/operations/contract'
import {
    DEFAULT_SEVERITY_FILTER,
    SeverityFilterStore,
    nextSeverityFilterMode,
    passesSeverityFilter,
    severityFilterLabel,
    severityFilterNotice
} from './severity-filter'

const SEVERITIES: readonly Severity[] = ['info', 'suggestion', 'warning']

describe('nextSeverityFilterMode', () => {
    it('cycles all → warnings and suggestions → warnings only → all', () => {
        expect(nextSeverityFilterMode('all')).toBe('warning-and-suggestion')
        expect(nextSeverityFilterMode('warning-and-suggestion')).toBe('warning')
        expect(nextSeverityFilterMode('warning')).toBe('all')
    })
})

describe('passesSeverityFilter', () => {
    it('shows everything under all', () => {
        for (const severity of SEVERITIES) {
            expect(passesSeverityFilter('all', severity)).toBe(true)
        }
    })

    it('hides info under warnings and suggestions', () => {
        expect(passesSeverityFilter('warning-and-suggestion', 'info')).toBe(false)
        expect(passesSeverityFilter('warning-and-suggestion', 'suggestion')).toBe(true)
        expect(passesSeverityFilter('warning-and-suggestion', 'warning')).toBe(true)
    })

    it('keeps only warnings under warnings only', () => {
        expect(passesSeverityFilter('warning', 'info')).toBe(false)
        expect(passesSeverityFilter('warning', 'suggestion')).toBe(false)
        expect(passesSeverityFilter('warning', 'warning')).toBe(true)
    })

    it('never hides a warning in any mode (the filter only narrows noise)', () => {
        expect(
            (['all', 'warning-and-suggestion', 'warning'] as const).every((mode) =>
                passesSeverityFilter(mode, 'warning')
            )
        ).toBe(true)
    })
})

describe('labels', () => {
    it('names what is shown, sentence case', () => {
        expect(severityFilterLabel('all')).toBe('All severities')
        expect(severityFilterLabel('warning-and-suggestion')).toBe('Warnings and suggestions')
        expect(severityFilterLabel('warning')).toBe('Warnings only')
    })

    it('reports the hidden count in the command Notice', () => {
        expect(severityFilterNotice('all', 0)).toBe('Findings: all severities.')
        expect(severityFilterNotice('warning', 3)).toBe('Findings: warnings only — 3 hidden.')
    })
})

describe('SeverityFilterStore', () => {
    it('defaults to all per file', () => {
        const store = new SeverityFilterStore()
        expect(store.get('a.md')).toBe(DEFAULT_SEVERITY_FILTER)
        expect(store.get('a.md')).toBe('all')
    })

    it('cycles one file without touching the others', () => {
        const store = new SeverityFilterStore()
        expect(store.cycle('a.md')).toBe('warning-and-suggestion')
        expect(store.get('a.md')).toBe('warning-and-suggestion')
        expect(store.get('b.md')).toBe('all')
    })

    it('returns to the default after a full cycle', () => {
        const store = new SeverityFilterStore()
        store.cycle('a.md')
        store.cycle('a.md')
        expect(store.cycle('a.md')).toBe('all')
        expect(store.get('a.md')).toBe('all')
    })

    it('clearUnder sweeps a renamed/deleted folder, sparing prefix look-alikes', () => {
        const store = new SeverityFilterStore()
        store.cycle('Notes/A.md')
        store.cycle('Notes/Sub/B.md')
        store.cycle('NotesArchive/C.md')
        store.clearUnder('Notes')
        expect(store.get('Notes/A.md')).toBe('all')
        expect(store.get('Notes/Sub/B.md')).toBe('all')
        expect(store.get('NotesArchive/C.md')).toBe('warning-and-suggestion')
    })

    it('clears one file and all files', () => {
        const store = new SeverityFilterStore()
        store.cycle('a.md')
        store.cycle('b.md')
        store.clear('a.md')
        expect(store.get('a.md')).toBe('all')
        expect(store.get('b.md')).toBe('warning-and-suggestion')
        store.clearAll()
        expect(store.get('b.md')).toBe('all')
    })
})
