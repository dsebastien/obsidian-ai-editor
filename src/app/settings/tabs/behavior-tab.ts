import type { SettingDefinitionItem } from 'obsidian'
import { applyImportPlan } from '../../domain/settings/settings-transfer'
import { ConfirmModal, renderChipList } from '../components'
import { normalizeChipValue } from '../helpers'
import { SetupWizardModal } from '../setup-wizard-modal'
import { ExportSettingsModal, ImportSettingsModal } from '../transfer-modals'
import type { TabContext } from './shared'

/**
 * Behavior page: the setup wizard entry point, run guardrails (size warning,
 * concurrency, context budget), privacy exclusions (folders, tags, frontmatter
 * opt-out — absolute, per Business Rule #7), response/comment defaults, and
 * settings import/export.
 *
 * The wizard lives here rather than on the Backends page because it spans
 * every page (backends, editors, voice, behavior); this is the page that
 * already owns the cross-cutting operations, import/export included.
 *
 * Declarative (issue #35): scalars are `control` definitions addressed by dot
 * path (see `control-bindings.ts`), so Obsidian's settings search finds them.
 * The numeric bounds are stated here AND in `settings-schema.ts` — the control
 * bounds are the affordance (they shape the stepper and reject bad input at
 * the field), the schema is the guarantee (it rejects anything that reaches
 * storage by any other route). Neither makes the other redundant.
 *
 * Two things stay imperative on purpose: the chip lists edit ARRAYS, which no
 * control type persists, and the wizard/transfer/clear-history entries are
 * operations rather than values, so they are `action` rows.
 */
export function behaviorPageItems(ctx: TabContext): SettingDefinitionItem[] {
    return [
        {
            type: 'group',
            heading: 'Setup',
            items: [
                {
                    name: 'Setup wizard',
                    desc:
                        'Walk through a backend, your editors, your voice profile, and when editors run. ' +
                        'Nothing is saved until the last step.',
                    // The wizard can add a backend and flip editor toggles, so
                    // the whole tab re-renders once it commits.
                    action: (): void => {
                        new SetupWizardModal(ctx.app, ctx.facade, ctx.refresh).open()
                    }
                }
            ]
        },
        {
            type: 'group',
            heading: 'Runs',
            items: [
                {
                    name: 'Size warning threshold (words)',
                    desc: 'Reviews of notes above this word count ask for confirmation first.',
                    control: {
                        type: 'number',
                        key: 'behavior.sizeWarningWords',
                        min: 100,
                        max: 1_000_000,
                        step: 1,
                        validate: wholeNumberIn(100, 1_000_000)
                    }
                },
                {
                    name: 'Max concurrent requests',
                    desc: 'How many backend requests may run in parallel.',
                    control: {
                        type: 'number',
                        key: 'behavior.maxConcurrentRequests',
                        min: 1,
                        max: 10,
                        step: 1,
                        validate: wholeNumberIn(1, 10)
                    }
                },
                {
                    name: 'Request timeout (seconds)',
                    desc: "How long a single editor's backend request may run — raise this for slow local models.",
                    control: {
                        type: 'number',
                        key: 'behavior.requestTimeoutSeconds',
                        min: 30,
                        max: 3_600,
                        step: 1,
                        validate: wholeNumberIn(30, 3_600)
                    }
                },
                {
                    name: 'Context budget (characters)',
                    desc:
                        'Total budget per run across the system prompt, the note, and every attached note. ' +
                        'The system prompt and the reviewed note are never truncated; attached notes ' +
                        'are spent in order (prompt notes, wikilinked notes, links followed from prompt ' +
                        'notes, then the reviewed note’s own links) and the last ones are dropped first. ' +
                        'Run “Preview what will be sent” to see exactly what a note costs.',
                    control: {
                        type: 'number',
                        key: 'behavior.contextBudgetChars',
                        min: 1_000,
                        max: 2_000_000,
                        step: 1,
                        validate: wholeNumberIn(1_000, 2_000_000)
                    }
                }
            ]
        },
        {
            type: 'group',
            heading: 'Daemon',
            items: [
                {
                    name: 'About daemon mode',
                    desc:
                        'In daemon mode, editors watch your edits and refresh their recommendations ' +
                        'automatically after you pause. Daemon mode is per note: each note starts ' +
                        'with it off when you open it, and the toggle above the Review button (or ' +
                        'the Toggle daemon mode for the current note command) turns it on for that ' +
                        'note until you close it.',
                    // Explanatory copy, not a setting: keeping it out of search
                    // stops it matching every daemon query ahead of the real
                    // controls right below it.
                    searchable: false
                },
                {
                    name: 'Enable automatically for every note',
                    desc:
                        'Every note starts with daemon mode already on when you open it. The ' +
                        'per-note toggle can still turn individual notes off. Every refresh ' +
                        'calls your configured AI backends — this can increase costs ' +
                        'significantly.',
                    control: { type: 'toggle', key: 'behavior.daemonAlwaysOn' }
                },
                {
                    name: 'Idle delay (seconds)',
                    desc:
                        'How long the note must be quiet before its review refreshes. Typing, ' +
                        'moving the cursor or selecting text restarts the clock; triaging ' +
                        'findings — accepting, dismissing, using the review panel or a ' +
                        'card — does not. Only an actual edit arms a refresh in the ' +
                        'first place.',
                    control: {
                        type: 'number',
                        key: 'behavior.daemonIdleSeconds',
                        min: 1,
                        max: 600,
                        step: 1,
                        validate: wholeNumberIn(1, 600)
                    }
                }
            ]
        },
        {
            type: 'group',
            heading: 'History',
            items: [
                {
                    name: 'Durable history',
                    desc:
                        'Keep the History tab across sessions, per note. History contains quoted ' +
                        'text from your notes, stored in the plugin folder (which may sync). ' +
                        'Off keeps history for the current session only.',
                    control: { type: 'toggle', key: 'behavior.durableHistory' }
                },
                {
                    name: 'Clear history',
                    desc: 'Removes every history entry, in memory and on disk.',
                    // An `action` definition fires on the WHOLE ROW, not on a
                    // button inside it — so the imperative tab's "you must hit
                    // Clear" safeguard did not survive the conversion, and a
                    // stray click anywhere on the row wiped every entry with no
                    // undo. The confirmation restores the deliberate second
                    // gesture (adversarial review, 2026-08-07).
                    action: (): void => {
                        new ConfirmModal(ctx.app, {
                            title: 'Clear history',
                            message:
                                'Remove every review history entry, in memory and on disk? This cannot be undone.',
                            impactLines: [],
                            ctaLabel: 'Clear',
                            onConfirm: () => {
                                ctx.clearHistory?.()
                            }
                        }).open()
                    }
                }
            ]
        },
        {
            type: 'group',
            heading: 'Privacy exclusions',
            items: [
                {
                    name: 'About exclusions',
                    desc: 'Excluded notes are never sent to any backend — not as the review target, not as linked context, not via an explicit wikilink reference.',
                    searchable: false
                },
                {
                    name: 'Excluded folders',
                    desc: 'Notes under these folders never leave the vault.',
                    // Arrays: no control type persists a list, so the existing
                    // chip editor renders into the row. INTO the row: `render`
                    // is documented as rendering the setting row, and the
                    // framework owns everything outside it — an earlier version
                    // built into `group.listEl` and deleted its own row, and the
                    // whole control simply did not appear (reported 2026-08-08).
                    // Staying inside `settingEl` also means the framework tears
                    // the widget down with the row, so re-renders cannot stack
                    // duplicates.
                    render: (setting): void => {
                        setting.settingEl.addClass('editor-ai-daemons-settings-embed')
                        setting.infoEl.remove() // the helper draws its own name + desc
                        renderChipList(setting.settingEl, {
                            name: 'Excluded folders',
                            desc: 'Notes under these folders never leave the vault.',
                            placeholder: 'Folder path, e.g. Private',
                            emptyText: 'No excluded folders.',
                            getValues: () => ctx.facade.getSettings().behavior.excludedFolders,
                            setValues: (next) =>
                                ctx.facade.update((draft) => {
                                    draft.behavior.excludedFolders = next
                                }),
                            normalize: (raw) => normalizeChipValue(raw, 'folder')
                        })
                    }
                },
                {
                    name: 'Excluded tags',
                    desc: 'Notes carrying these tags never leave the vault.',
                    render: (setting): void => {
                        setting.settingEl.addClass('editor-ai-daemons-settings-embed')
                        setting.infoEl.remove() // the helper draws its own name + desc
                        renderChipList(setting.settingEl, {
                            name: 'Excluded tags',
                            desc: 'Notes carrying these tags never leave the vault.',
                            placeholder: 'Tag without #, e.g. private',
                            emptyText: 'No excluded tags.',
                            getValues: () => ctx.facade.getSettings().behavior.excludedTags,
                            setValues: (next) =>
                                ctx.facade.update((draft) => {
                                    draft.behavior.excludedTags = next
                                }),
                            normalize: (raw) => normalizeChipValue(raw, 'tag')
                        })
                    }
                },
                {
                    name: 'Respect frontmatter opt-out',
                    desc: 'Notes with ai_editor: false in their frontmatter are excluded entirely.',
                    control: { type: 'toggle', key: 'behavior.respectFrontmatterOptOut' }
                },
                {
                    name: 'Strip frontmatter',
                    desc: 'Remove frontmatter from the note and from every attached note before sending.',
                    control: { type: 'toggle', key: 'behavior.stripFrontmatter' }
                }
            ]
        },
        {
            type: 'group',
            heading: 'Responses',
            items: [
                {
                    name: 'Response language override',
                    desc: 'Leave empty to answer in each note’s own language.',
                    control: {
                        type: 'text',
                        key: 'behavior.responseLanguageOverride',
                        placeholder: 'e.g. English'
                    }
                },
                {
                    name: 'Default comment editor',
                    desc: 'Editor handling async margin comments unless rerouted per comment.',
                    control: {
                        type: 'dropdown',
                        key: 'behavior.defaultCommentEditorId',
                        // Rebuilt on every render, so an editor added or renamed
                        // on the Editors page shows up here without a reload.
                        options: commentEditorOptions(ctx)
                    }
                },
                {
                    name: 'Margin comment column',
                    // "AI Editor Review" is the side panel's tab title — declared as
                    // vocabulary in eslint.config.ts (0.4.1 forbids inline disables).
                    desc: 'Show margin comments next to the text they are about. Turn this off to keep them in the AI Editor Review panel only. Needs a wide enough pane; with readable line length on, the column uses the empty margin and the text does not move.',
                    control: { type: 'toggle', key: 'behavior.showMarginComments' }
                }
            ]
        },
        {
            type: 'group',
            heading: 'Import & export',
            items: [
                {
                    name: 'About import & export',
                    desc: 'Move your configuration between vaults, or keep a copy in this one. API keys are never included — the vault that imports the file enters its own.',
                    searchable: false
                },
                {
                    name: 'Export settings',
                    desc: 'Write the sections you pick to a JSON file in the vault, or to the clipboard.',
                    action: (): void => {
                        new ExportSettingsModal(ctx.app, () => ctx.facade.getSettings()).open()
                    }
                },
                {
                    name: 'Import settings',
                    desc: 'Add entities from an exported file. You confirm a summary before anything is saved.',
                    action: (): void => {
                        new ImportSettingsModal(ctx.app, {
                            getSettings: () => ctx.facade.getSettings(),
                            commitPlan: async (plan) => {
                                await ctx.facade.update((draft) => {
                                    applyImportPlan(draft, plan)
                                })
                                ctx.refresh()
                            }
                        }).open()
                    }
                }
            ]
        }
    ]
}

/** `''` → None, then every configured editor by id. */
export function commentEditorOptions(ctx: TabContext): Record<string, string> {
    const options: Record<string, string> = { '': 'None' }
    for (const editor of ctx.facade.getSettings().editors) {
        options[editor.id] = editor.name
    }
    return options
}

/**
 * Bounds validator for a numeric control.
 *
 * The imperative tab clamped out-of-range input and fell back to the LAST
 * COMMITTED value; a `control` has neither hook. What it does have is
 * `validate`, which rejects the change and shows the message inline before the
 * value reaches storage — better than the old silent clamp, which changed the
 * user's number without saying so.
 *
 * These controls deliberately declare NO `defaultValue` (adversarial review,
 * 2026-08-07). `defaultValue` is documented as the fallback when the RESOLVER
 * returns undefined/null, which ours never does for a key that resolves — and
 * `settings-definitions.spec.ts` guarantees every declared key resolves. What
 * it bought instead was a silent reset: clear a Context budget deliberately set
 * to its 1,000 minimum and the field would persist the 200,000 schema default,
 * widening a cost guardrail 200x without a word. With no default declared the
 * cleared field fails this validator and is refused inline, which is the right
 * answer whether the framework substitutes 0, NaN, or nothing at all.
 *
 * The same bounds live in `settings-schema.ts`. That is deliberate: this is the
 * affordance, the schema is the guarantee for anything arriving by another
 * route (import, sync, a hand-edited data.json).
 */
function wholeNumberIn(min: number, max: number): (value: number) => string | void {
    return (value: number): string | void => {
        if (!Number.isFinite(value) || !Number.isInteger(value)) {
            return 'Enter a whole number.'
        }
        if (value < min || value > max) {
            return `Enter a whole number between ${min.toLocaleString()} and ${max.toLocaleString()}.`
        }
    }
}
