import type { SettingDefinitionItem } from 'obsidian'
import { renderNoteRefsEditor } from '../components'
import type { TabContext } from './shared'

/**
 * Voice & style page: the global voice profile (text and/or ordered vault
 * note refs) injected into every editor run unless the editor opts out.
 * Note refs resolve fresh at run time — editing the note IS reconfiguring.
 *
 * Declarative (issue #35): the two scalars — the profile text and the
 * follow-links flag — are `control` definitions addressed by dot path (see
 * `control-bindings.ts`), so Obsidian's settings search finds them.
 *
 * One thing stays imperative on purpose: the note refs are an ARRAY the user
 * adds to, removes from and reorders, which no control type persists, so the
 * existing ordered note-ref editor renders into the row. Its optional
 * `followLinks` toggle is deliberately NOT used here — the flag is a plain
 * scalar, and declaring it makes it searchable instead of burying it inside
 * bespoke DOM.
 */
export function voicePageItems(ctx: TabContext): SettingDefinitionItem[] {
    return [
        {
            type: 'group',
            heading: 'Voice profile',
            items: [
                {
                    name: 'About the voice profile',
                    desc: 'The voice profile teaches every editor how you write. It is prepended to each run unless an editor disables “Inject voice profile”.',
                    // Explanatory copy, not a setting: keeping it out of search
                    // stops it matching every voice query ahead of the real
                    // controls right below it.
                    searchable: false
                },
                {
                    name: 'Voice profile',
                    desc: 'Direct description of your voice, style rules, banned words…',
                    control: {
                        type: 'textarea',
                        key: 'voiceProfile.text',
                        placeholder: 'Short sentences. No hedging. Never use “delve”…'
                    }
                },
                {
                    name: 'Voice profile notes',
                    desc: 'Vault notes appended in order at run time (e.g. My Voice Profile). Editing those notes immediately affects every subsequent run.',
                    // Arrays: no control type persists an ordered list, so the
                    // existing note-ref editor renders into the row. INTO the
                    // row: `render` renders the setting row, and the framework
                    // owns everything outside it — building into `group.listEl`
                    // and deleting the row made this control vanish entirely,
                    // leaving the voice profile notes unconfigurable (reported
                    // 2026-08-08).
                    render: (setting): void => {
                        setting.settingEl.addClass('editor-ai-daemons-settings-embed')
                        setting.infoEl.remove() // the helper draws its own name + desc
                        renderNoteRefsEditor(setting.settingEl, {
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
                },
                {
                    name: 'Follow links',
                    desc: 'Also include the notes these notes link to (one level). Linked notes count against the context budget.',
                    control: { type: 'toggle', key: 'voiceProfile.followLinks' }
                }
            ]
        }
    ]
}
