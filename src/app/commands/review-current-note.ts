import { MarkdownView, Notice } from 'obsidian'
import type { Plugin } from 'obsidian'
import { createSnapshot } from '../domain/snapshot'
import { log } from '../../utils/log'

/**
 * Skeleton of the "Review current note" command: captures a
 * `DocumentSnapshot` of the active markdown view (whole note, or
 * selection-scoped when a selection exists) and stops there — no backend
 * call, per Business Rule #1 the review loop only ships once it is real.
 * The orchestration connects at the seam marked below.
 */
export function registerReviewCurrentNoteCommand(plugin: Plugin): void {
    plugin.addCommand({
        id: 'review-current-note',
        name: 'Review current note',
        checkCallback: (checking: boolean): boolean => {
            const view = plugin.app.workspace.getActiveViewOfType(MarkdownView)
            if (!view || !view.file) {
                return false
            }
            if (checking) {
                return true
            }
            const editor = view.editor
            const from = editor.posToOffset(editor.getCursor('from'))
            const to = editor.posToOffset(editor.getCursor('to'))
            const snapshot = createSnapshot({
                filePath: view.file.path,
                text: editor.getValue(),
                ...(from !== to ? { selection: { from, to } } : {})
            })
            log(
                `Review requested for ${snapshot.filePath} (snapshot ${snapshot.id}, hash ${snapshot.hash})`,
                'info'
            )
            // ── SEAM (M2): review pipeline ─────────────────────────────────
            // TODO(M2): resolve enabled editors + their backends from plugin
            //   settings; build one RunEditorSpec per editor whose `execute`
            //   bridges services/backends/providers (getProviderAdapter →
            //   buildRequest → transport → parseBufferedResponse) with the
            //   context assembled by services/context (exclusions first).
            // TODO(M2): start the run via services/orchestration
            //   RunController.startRun({ snapshot, editors }) — one active
            //   run per file — and wire Cancel to the persona rail.
            // TODO(M2): project anchored findings into the CM6
            //   findingDecorationsField (setFindingsEffect) and feed the
            //   status-bar counter via AIEditorPlugin.setFindingCount.
            new Notice(
                'AI review is not connected to a backend yet — coming in the next milestone.'
            )
            return true
        }
    })
}
