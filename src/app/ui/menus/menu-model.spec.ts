import { describe, expect, it } from 'bun:test'
import {
    ACTION_MENU_CAP,
    actionMenuIcon,
    actionMenuTitle,
    editorMenuEntries,
    fileMenuItems
} from './menu-model'
import type { BoundActionView, EditorMenuState, FileMenuState } from './menu-model'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function action(overrides: Partial<BoundActionView> = {}): BoundActionView {
    return {
        bindingId: 'humanize',
        label: 'Humanize',
        verbClass: 'transform',
        panelName: null,
        ...overrides
    }
}

function editorState(overrides: Partial<EditorMenuState> = {}): EditorMenuState {
    return {
        editable: true,
        hasSelection: true,
        reviewable: true,
        blocked: false,
        actions: [],
        ...overrides
    }
}

function fileState(overrides: Partial<FileMenuState> = {}): FileMenuState {
    return { markdownFile: true, reviewable: true, ...overrides }
}

function entryIds(state: EditorMenuState): string[] {
    return editorMenuEntries(state).map((entry) =>
        entry.kind === 'action' ? `action:${entry.action.bindingId}` : entry.kind
    )
}

// ---------------------------------------------------------------------------
// editorMenuEntries
// ---------------------------------------------------------------------------

describe('editorMenuEntries', () => {
    it('offers review selection and ask editor for a reviewable selection in an editable view', () => {
        expect(entryIds(editorState())).toEqual(['review-selection', 'ask-editor'])
    })

    it('lists bound actions first, alphabetical by label, before the review items', () => {
        const state = editorState({
            actions: [
                action({ bindingId: 'summarize', label: 'Summarize' }),
                action({ bindingId: 'critique', label: 'Critique', verbClass: 'review' }),
                action({ bindingId: 'humanize', label: 'Humanize' })
            ]
        })
        expect(entryIds(state)).toEqual([
            'action:critique',
            'action:humanize',
            'action:summarize',
            'review-selection',
            'ask-editor'
        ])
    })

    it('caps the bound actions at ACTION_MENU_CAP', () => {
        const actions = Array.from({ length: ACTION_MENU_CAP + 5 }, (_, index) =>
            action({
                bindingId: `binding-${index}`,
                label: `Action ${String(index).padStart(2, '0')}`
            })
        )
        const entries = editorMenuEntries(editorState({ actions }))
        expect(entries.filter((entry) => entry.kind === 'action')).toHaveLength(ACTION_MENU_CAP)
    })

    it('offers bound actions on a non-reviewable note the plugin still operates on', () => {
        // A vault whose editors are all rewrite-only: reviewable is false,
        // yet transform actions dispatch — the review items alone are hidden.
        const state = editorState({ reviewable: false, actions: [action()] })
        expect(entryIds(state)).toEqual(['action:humanize'])
    })

    it('offers nothing at all on a blocked note (exclusion or rule kill switch)', () => {
        const excluded = editorState({ blocked: true, reviewable: false, actions: [action()] })
        expect(entryIds(excluded)).toEqual([])
        // Even with a caller that wrongly still reports the note reviewable.
        const inconsistent = editorState({ blocked: true, reviewable: true, actions: [action()] })
        expect(entryIds(inconsistent)).toEqual([])
    })

    it('offers nothing without a selection', () => {
        expect(entryIds(editorState({ hasSelection: false, actions: [action()] }))).toEqual([])
    })

    it('offers nothing in a non-editable (reading) view', () => {
        expect(entryIds(editorState({ editable: false, actions: [action()] }))).toEqual([])
    })

    it('offers nothing when every gate fails at once', () => {
        expect(
            entryIds(
                editorState({
                    editable: false,
                    hasSelection: false,
                    reviewable: false,
                    blocked: true
                })
            )
        ).toEqual([])
    })
})

// ---------------------------------------------------------------------------
// actionMenuIcon
// ---------------------------------------------------------------------------

describe('actionMenuIcon', () => {
    it('maps each verb class to its design §1 icon', () => {
        expect(actionMenuIcon('transform')).toBe('check')
        expect(actionMenuIcon('generate')).toBe('wand-2')
        expect(actionMenuIcon('review')).toBe('message-circle')
    })
})

// ---------------------------------------------------------------------------
// fileMenuItems
// ---------------------------------------------------------------------------

describe('fileMenuItems', () => {
    it('offers review note and open review panel for a reviewable markdown file', () => {
        expect(fileMenuItems(fileState())).toEqual(['review-note', 'open-review-panel'])
    })

    it('offers nothing for a non-markdown target (folder, image, pdf)', () => {
        expect(fileMenuItems(fileState({ markdownFile: false }))).toEqual([])
    })

    it('offers nothing when the note is not reviewable', () => {
        expect(fileMenuItems(fileState({ reviewable: false }))).toEqual([])
    })

    it('offers nothing for a non-markdown non-reviewable target', () => {
        expect(fileMenuItems({ markdownFile: false, reviewable: false })).toEqual([])
    })
})

// ---------------------------------------------------------------------------
// actionMenuTitle
// ---------------------------------------------------------------------------

describe('actionMenuTitle', () => {
    it('names the panel a verb convenes — one click there is one request per member', () => {
        expect(
            actionMenuTitle(
                action({ label: 'Critique', verbClass: 'review', panelName: 'Pre-publish Review' })
            )
        ).toBe('Critique (panel: Pre-publish Review)')
    })

    it('leaves an editor-bound verb as the bare label', () => {
        expect(actionMenuTitle(action({ label: 'Humanize' }))).toBe('Humanize')
    })

    it('does not let the marker reorder the menu — sorting is by the bare label', () => {
        // 'Critique' bound to a panel must still sit between 'Astonish' and
        // 'Humanize', not under whatever '(panel: …)' sorts as.
        const entries = editorMenuEntries(
            editorState({
                actions: [
                    action({ bindingId: 'h', label: 'Humanize' }),
                    action({
                        bindingId: 'c',
                        label: 'Critique',
                        verbClass: 'review',
                        panelName: 'Zzz Panel'
                    }),
                    action({ bindingId: 'a', label: 'Astonish' })
                ]
            })
        )
        expect(
            entries
                .filter((entry) => entry.kind === 'action')
                .map((entry) => (entry.kind === 'action' ? entry.action.bindingId : ''))
        ).toEqual(['a', 'c', 'h'])
    })
})
