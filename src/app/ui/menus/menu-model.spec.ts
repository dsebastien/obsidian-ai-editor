import { describe, expect, it } from 'bun:test'
import { editorMenuItems, fileMenuItems } from './menu-model'
import type { EditorMenuState, FileMenuState } from './menu-model'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function editorState(overrides: Partial<EditorMenuState> = {}): EditorMenuState {
    return { editable: true, hasSelection: true, reviewable: true, ...overrides }
}

function fileState(overrides: Partial<FileMenuState> = {}): FileMenuState {
    return { markdownFile: true, reviewable: true, ...overrides }
}

// ---------------------------------------------------------------------------
// editorMenuItems
// ---------------------------------------------------------------------------

describe('editorMenuItems', () => {
    it('offers review selection for a reviewable selection in an editable view', () => {
        expect(editorMenuItems(editorState())).toEqual(['review-selection'])
    })

    it('offers nothing without a selection', () => {
        expect(editorMenuItems(editorState({ hasSelection: false }))).toEqual([])
    })

    it('offers nothing in a non-editable (reading) view', () => {
        expect(editorMenuItems(editorState({ editable: false }))).toEqual([])
    })

    it('offers nothing when the note is not reviewable', () => {
        expect(editorMenuItems(editorState({ reviewable: false }))).toEqual([])
    })

    it('offers nothing when every gate fails at once', () => {
        expect(
            editorMenuItems({ editable: false, hasSelection: false, reviewable: false })
        ).toEqual([])
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
