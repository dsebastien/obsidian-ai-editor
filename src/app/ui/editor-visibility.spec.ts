import { describe, expect, it } from 'bun:test'
import { disabledEditorIds, panelSectionPlan, withoutDisabledEditors } from './editor-visibility'

describe('disabledEditorIds', () => {
    it('collects only editors that exist and are switched off', () => {
        const disabled = disabledEditorIds([
            { id: 'e-1', enabled: true },
            { id: 'e-2', enabled: false },
            { id: 'e-3', enabled: false }
        ])
        expect([...disabled].sort()).toEqual(['e-2', 'e-3'])
    })

    it('is empty when every editor is enabled', () => {
        expect(disabledEditorIds([{ id: 'e-1', enabled: true }]).size).toBe(0)
    })
})

describe('withoutDisabledEditors', () => {
    const findings = [
        { editorId: 'e-1', label: 'kept' },
        { editorId: 'e-2', label: 'hidden' },
        { editorId: 'e-gone', label: 'deleted-editor kept' }
    ]

    it('hides items of a disabled editor and keeps everything else', () => {
        const visible = withoutDisabledEditors(findings, new Set(['e-2']))
        expect(visible.map((item) => item.editorId)).toEqual(['e-1', 'e-gone'])
    })

    it('keeps items of a DELETED editor: only present-but-disabled hides', () => {
        // 'e-gone' is not in the settings at all, so it can never appear in
        // the disabled set — its findings stay visible (the run still knows
        // what the editor was called).
        const visible = withoutDisabledEditors(findings, disabledEditorIds([]))
        expect(visible).toEqual(findings)
    })

    it('returns the same array when nothing is disabled (cheap no-op)', () => {
        expect(withoutDisabledEditors(findings, new Set())).toBe(findings)
    })

    it('never mutates the source (hide, not purge)', () => {
        const before = [...findings]
        withoutDisabledEditors(findings, new Set(['e-1', 'e-2', 'e-gone']))
        expect(findings).toEqual(before)
    })
})

describe('panelSectionPlan', () => {
    const states = [
        { editorId: 'e-1' },
        { editorId: 'e-2' },
        { editorId: 'e-3' },
        { editorId: 'e-gone' }
    ]

    it('drops disabled sections entirely and counts acknowledged ones', () => {
        const plan = panelSectionPlan(states, new Set(['e-3']), new Set(['e-2']))
        expect(plan.sections.map((state) => state.editorId)).toEqual(['e-1', 'e-gone'])
        expect(plan.acknowledgedCount).toBe(1)
    })

    it('does NOT count a disabled editor as acknowledged, even when it is both', () => {
        // The acknowledged footer offers a "Show" restore — which cannot
        // restore a section the settings toggle hides. Disabled wins.
        const plan = panelSectionPlan(states, new Set(['e-2']), new Set(['e-2']))
        expect(plan.sections.map((state) => state.editorId)).toEqual(['e-1', 'e-3', 'e-gone'])
        expect(plan.acknowledgedCount).toBe(0)
    })

    it('renders every section when nothing is acknowledged or disabled', () => {
        const plan = panelSectionPlan(states, new Set(), new Set())
        expect(plan.sections).toEqual(states)
        expect(plan.acknowledgedCount).toBe(0)
    })
})
