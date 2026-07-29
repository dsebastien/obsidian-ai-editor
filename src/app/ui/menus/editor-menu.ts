import { MarkdownView } from 'obsidian'
import type { Editor, Plugin } from 'obsidian'
import type { ReviewController } from '../review-controller'
import { AI_EDITOR_MENU_SECTION, editorMenuItems } from './menu-model'

/**
 * Editor context menu (design doc "Interaction surfaces" §1): right-click on
 * a selection in an editable markdown view offers "Review selection". Which
 * items appear is decided by the pure `editorMenuItems` model; this file only
 * builds the state and wires the Obsidian `Menu`.
 *
 * v1 ships review-class items only — bound action verbs (rephrase, …) wait
 * for the M3 transform operations, and no placeholder items are registered.
 */
export function registerEditorMenu(plugin: Plugin, controller: ReviewController): void {
    plugin.registerEvent(
        plugin.app.workspace.on('editor-menu', (menu, editor, info) => {
            // `info` can be any MarkdownFileInfo host (e.g. an embedded
            // editor); reviews dispatch through a full MarkdownView only.
            if (!(info instanceof MarkdownView)) {
                return
            }
            const items = editorMenuItems({
                editable: info.getMode() !== 'preview',
                hasSelection: editor.somethingSelected(),
                reviewable: controller.canReview(info)
            })
            for (const item of items) {
                switch (item) {
                    case 'review-selection':
                        menu.addItem((menuItem) => {
                            menuItem
                                .setTitle('Review selection')
                                .setIcon('message-circle')
                                .setSection(AI_EDITOR_MENU_SECTION)
                                .onClick(() => {
                                    reviewSelection(controller, info, editor)
                                })
                        })
                        break
                }
            }
        })
    )
}

/**
 * Selection-capture contract (design §1): the selection range is read
 * synchronously in the menu-item callback and rides into the review pipeline
 * as `requestedSelection`; the service re-validates it against the fresh
 * snapshot at run start and falls back to whole-note scope (with a Notice)
 * when it went stale. If the selection collapsed between menu open and click,
 * there is no range to request — the review runs on the whole note.
 */
function reviewSelection(controller: ReviewController, view: MarkdownView, editor: Editor): void {
    const from = editor.posToOffset(editor.getCursor('from'))
    const to = editor.posToOffset(editor.getCursor('to'))
    if (from === to) {
        void controller.startReview(view)
        return
    }
    void controller.startReview(view, false, { from, to })
}
