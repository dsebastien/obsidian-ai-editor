import { renderNoteRefsEditor, renderPromptTextArea } from '../components'
import { commit } from './shared'
import type { TabContext } from './shared'

/**
 * Voice & style tab: the global voice profile (text and/or ordered vault
 * note refs) injected into every editor run unless the editor opts out.
 * Note refs resolve fresh at run time — editing the note IS reconfiguring.
 */
export function renderVoiceTab(containerEl: HTMLElement, ctx: TabContext): void {
    const settings = ctx.facade.getSettings()

    containerEl.createEl('p', {
        cls: 'ai-editor-tab-intro',
        text: 'The voice profile teaches every editor how you write. It is prepended to each run unless an editor disables “Inject voice profile”.'
    })

    renderPromptTextArea(containerEl, {
        name: 'Voice profile',
        desc: 'Direct description of your voice, style rules, banned words…',
        placeholder: 'Short sentences. No hedging. Never use “delve”…',
        get: () => settings.voiceProfile.text,
        set: (value) => {
            commit(ctx, (draft) => {
                draft.voiceProfile.text = value
            })
        }
    })

    renderNoteRefsEditor(containerEl, {
        app: ctx.app,
        name: 'Voice profile notes',
        desc: 'Vault notes appended in order at run time (e.g. My Voice Profile). Editing those notes immediately affects every subsequent run.',
        getPaths: () => ctx.facade.getSettings().voiceProfile.notePaths,
        setPaths: (paths) =>
            ctx.facade.update((draft) => {
                draft.voiceProfile.notePaths = paths
            })
    })
}
