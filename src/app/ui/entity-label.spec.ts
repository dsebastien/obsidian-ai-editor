import { describe, expect, it, test } from 'bun:test'
import {
    actionDisplayLabel,
    ENTITY_GLYPHS,
    entityName,
    memberSectionName,
    entityOptionText,
    PANEL_MARKER
} from './entity-label'

describe('entityName', () => {
    it('marks a panel in the name itself, so the distinction survives in an accessible name', () => {
        expect(entityName('panel', 'Pre-publish review')).toBe('Pre-publish review (panel)')
    })

    it('leaves an editor unmarked — the marker only stands out while it is rare', () => {
        expect(entityName('editor', 'Concision Editor')).toBe('Concision Editor')
    })
})

describe('entityOptionText', () => {
    it('carries BOTH signals for a panel: the ring glyph and the word', () => {
        const text = entityOptionText('panel', 'Pre-publish review')
        expect(text).toBe('◎ Pre-publish review (panel)')
        expect(text).toContain(PANEL_MARKER)
    })

    it('gives an editor the solid glyph and nothing else', () => {
        expect(entityOptionText('editor', 'Humanizer')).toBe('● Humanizer')
    })

    it('uses distinct glyphs — a list scanned visually must not read as one kind', () => {
        expect(ENTITY_GLYPHS.editor).not.toBe(ENTITY_GLYPHS.panel)
    })
})

describe('actionDisplayLabel', () => {
    it('names the panel a verb convenes, because that is the cost the user is choosing', () => {
        expect(actionDisplayLabel('Critique', 'Pre-publish review')).toBe(
            'Critique (panel: Pre-publish review)'
        )
    })

    it('leaves an editor-bound action alone — naming one editor restates the verb', () => {
        expect(actionDisplayLabel('Critique', null)).toBe('Critique')
    })
})

describe('memberSectionName', () => {
    test('names a solo editor — the commonest case, previously unnamed', () => {
        expect(memberSectionName('Concision Editor', null)).toBe('Concision Editor')
        expect(memberSectionName('Concision Editor', '')).toBe('Concision Editor')
    })

    test('keeps the editor identity inside its panel', () => {
        expect(memberSectionName('Hater', 'Pre-publish review')).toBe(
            'Hater — member of Pre-publish review (panel)'
        )
    })
})
