import { TFile } from 'obsidian'
import type { Plugin } from 'obsidian'
import type { ReviewController } from '../review-controller'
import { AI_EDITOR_MENU_SECTION, fileMenuItems } from './menu-model'

/**
 * File context menu (design doc "Interaction surfaces" §2): a single
 * reviewable markdown note (file explorer, tab header, link) offers "Review
 * note" (opens the file when needed and dispatches the same whole-note review
 * the command uses) and "Open review panel". Which items appear is decided by
 * the pure `fileMenuItems` model; this file only wires the Obsidian `Menu`.
 *
 * `files-menu` (multi-selection batch review) is deliberately NOT registered:
 * deferred post-M4, and no placeholder items are ever shipped. Folders are
 * excluded everywhere — review scope stays explicit per note.
 */
export function registerFileMenu(plugin: Plugin, controller: ReviewController): void {
    plugin.registerEvent(
        plugin.app.workspace.on('file-menu', (menu, file) => {
            const markdownFile = file instanceof TFile && file.extension === 'md'
            const items = fileMenuItems({
                markdownFile,
                reviewable: markdownFile && controller.canReviewPath(file.path)
            })
            for (const item of items) {
                switch (item) {
                    case 'review-note':
                        menu.addItem((menuItem) => {
                            menuItem
                                .setTitle('Review note')
                                .setIcon('message-circle')
                                .setSection(AI_EDITOR_MENU_SECTION)
                                .onClick(() => {
                                    void controller.reviewFile(file.path)
                                })
                        })
                        break
                    case 'open-review-panel':
                        menu.addItem((menuItem) => {
                            menuItem
                                .setTitle('Open review panel')
                                .setIcon('bot')
                                .setSection(AI_EDITOR_MENU_SECTION)
                                .onClick(() => {
                                    void controller.activateSidePanel()
                                })
                        })
                        break
                }
            }
        })
    )
}
