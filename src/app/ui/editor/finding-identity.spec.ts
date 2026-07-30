import { describe, expect, test } from 'bun:test'

import { FINDING_EDGE_STYLE_COUNT, findingEdgeIndex, findingMarkTitle } from './finding-identity'

describe('findingMarkTitle', () => {
    test('leads with the editor and names the severity', () => {
        expect(
            findingMarkTitle({
                editorName: 'Concision Editor',
                panelName: null,
                severity: 'warning',
                stale: false
            })
        ).toBe('Concision Editor — warning')
    })

    test('marks a panel member the way every other surface marks one', () => {
        expect(
            findingMarkTitle({
                editorName: 'Hater',
                panelName: 'Pre-publish review',
                severity: 'suggestion',
                stale: false
            })
        ).toBe('Hater — suggestion · member of Pre-publish review (panel)')
    })

    test('an empty panel name is not a panel', () => {
        expect(
            findingMarkTitle({
                editorName: 'Hater',
                panelName: '',
                severity: 'info',
                stale: false
            })
        ).toBe('Hater — info')
    })

    test('says stale in words, not only in the dimmed look', () => {
        const title = findingMarkTitle({
            editorName: 'Fact Checker',
            panelName: null,
            severity: 'info',
            stale: true
        })
        expect(title).toContain('stale')
        expect(title).toContain('the text changed')
    })
})

describe('findingEdgeIndex', () => {
    test('is the editor position while there are styles left', () => {
        expect(findingEdgeIndex(0)).toBe(0)
        expect(findingEdgeIndex(1)).toBe(1)
        expect(findingEdgeIndex(FINDING_EDGE_STYLE_COUNT - 1)).toBe(FINDING_EDGE_STYLE_COUNT - 1)
    })

    test('wraps rather than falling off the end', () => {
        expect(findingEdgeIndex(FINDING_EDGE_STYLE_COUNT)).toBe(0)
        expect(findingEdgeIndex(FINDING_EDGE_STYLE_COUNT + 2)).toBe(2)
    })

    test('an editor that is no longer in settings still gets a slot', () => {
        expect(findingEdgeIndex(-1)).toBe(0)
        expect(findingEdgeIndex(Number.NaN)).toBe(0)
    })
})
