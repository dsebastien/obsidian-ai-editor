import { MarkdownView } from 'obsidian'
import type { Plugin } from 'obsidian'
import type { PluginSettingsV1 } from '../../domain/settings/settings-schema'
import { resolveActions } from '../../services/actions/action-resolution'
import type { ReviewController } from '../review-controller'
import {
    AI_EDITOR_MENU_SECTION,
    actionMenuIcon,
    actionMenuTitle,
    editorMenuEntries
} from './menu-model'

/**
 * Editor context menu (design doc "Interaction surfaces" §1): right-click on
 * a selection in an editable markdown view offers the dispatchable bound
 * actions (icon by verb class, alphabetical, capped), then "Review
 * selection" and "Ask an editor…". Which items appear is decided by the pure
 * `editorMenuEntries` model over `resolveActions`; this file only builds the
 * state and wires the Obsidian `Menu`.
 */
export function registerEditorMenu(
    plugin: Plugin,
    controller: ReviewController,
    getSettings: () => PluginSettingsV1
): void {
    plugin.registerEvent(
        plugin.app.workspace.on('editor-menu', (menu, editor, info) => {
            // `info` can be any MarkdownFileInfo host (e.g. an embedded
            // editor); dispatch goes through a full MarkdownView only.
            if (!(info instanceof MarkdownView)) {
                return
            }
            const file = info.file
            const entries = editorMenuEntries({
                editable: info.getMode() !== 'preview',
                hasSelection: editor.somethingSelected(),
                reviewable: controller.canReview(info),
                blocked: file === null || !controller.isPluginEnabledFor(file.path),
                actions: resolveActions(getSettings())
            })
            for (const entry of entries) {
                switch (entry.kind) {
                    case 'action': {
                        const action = entry.action
                        menu.addItem((menuItem) => {
                            menuItem
                                .setTitle(actionMenuTitle(action))
                                .setIcon(actionMenuIcon(action.verbClass))
                                .setSection(AI_EDITOR_MENU_SECTION)
                                .onClick(() => {
                                    // Selection-capture contract (design §1):
                                    // the range + hash are read synchronously
                                    // in this callback by `startBoundAction`.
                                    controller.startBoundAction(info, editor, action.bindingId)
                                })
                        })
                        break
                    }
                    case 'review-selection':
                        menu.addItem((menuItem) => {
                            menuItem
                                .setTitle('Review selection')
                                .setIcon('message-circle')
                                .setSection(AI_EDITOR_MENU_SECTION)
                                .onClick(() => {
                                    // Selection-capture contract (design §1):
                                    // the range is read synchronously in this
                                    // callback by `startSelectionReview`.
                                    controller.startSelectionReview(info, editor)
                                })
                        })
                        break
                    case 'ask-editor':
                        menu.addItem((menuItem) => {
                            menuItem
                                .setTitle('Ask an editor…')
                                .setIcon('message-circle-question')
                                .setSection(AI_EDITOR_MENU_SECTION)
                                .onClick(() => {
                                    // Selection + capture-time hash are read
                                    // synchronously in this callback; the
                                    // modal then owns the dispatch.
                                    controller.openAskEditorModal(info, editor)
                                })
                        })
                        break
                }
            }
        })
    )
}
