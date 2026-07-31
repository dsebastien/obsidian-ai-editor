import { Modal, Notice, Setting } from 'obsidian'
import type { App, DropdownComponent } from 'obsidian'
import type { PluginSettingsV1 } from '../domain/settings/settings-schema'
import { entityOptionText } from '../ui/entity-label'
import { backendKindLabel, encodeActionTarget, moveItem } from './helpers'
import { NotePathSuggest } from './note-path-suggest'

/**
 * Shared DOM building blocks for the settings tab and its modals.
 * Everything renders with `createEl`/`createDiv` (never `innerHTML`) and
 * takes colors from Obsidian CSS variables so themes keep working.
 */

// ---------------------------------------------------------------------------
// Confirmation modal (window.confirm is forbidden — see AGENTS.md)
// ---------------------------------------------------------------------------

export interface ConfirmModalOptions {
    title: string
    message: string
    /** Referential-impact bullet lines shown under the message. */
    impactLines: readonly string[]
    ctaLabel: string
    onConfirm: () => void
}

/** Themed confirmation dialog with a warning-styled call to action. */
export class ConfirmModal extends Modal {
    private readonly options: ConfirmModalOptions

    constructor(app: App, options: ConfirmModalOptions) {
        super(app)
        this.options = options
    }

    override onOpen(): void {
        this.setTitle(this.options.title)
        this.modalEl.addClass('editor-ai-daemons-modal')
        const { contentEl } = this
        contentEl.createEl('p', { text: this.options.message })
        if (this.options.impactLines.length > 0) {
            const list = contentEl.createEl('ul', { cls: 'editor-ai-daemons-confirm-lines' })
            for (const line of this.options.impactLines) {
                list.createEl('li', { text: line })
            }
        }
        new Setting(contentEl)
            .addButton((button) => {
                button.setButtonText('Cancel').onClick(() => this.close())
            })
            .addButton((button) => {
                button
                    .setButtonText(this.options.ctaLabel)
                    .setWarning()
                    .onClick(() => {
                        this.close()
                        this.options.onConfirm()
                    })
            })
    }

    override onClose(): void {
        this.contentEl.empty()
    }
}

// ---------------------------------------------------------------------------
// Color dots (editors = solid, panels = ringed — Business Rule #11)
// ---------------------------------------------------------------------------

/** Renders the identity dot: solid fill for editors, hollow ring for panels. */
export function renderColorDot(
    parent: HTMLElement | DocumentFragment,
    color: string,
    variant: 'editor' | 'panel'
): HTMLElement {
    const dot = parent.createSpan({ cls: 'editor-ai-daemons-color-dot' })
    if (variant === 'panel') {
        dot.addClass('editor-ai-daemons-color-dot--ring')
        dot.style.borderColor = color
    } else {
        dot.style.backgroundColor = color
    }
    return dot
}

/**
 * Theme-variable colors paired with a human label: the label is what screen
 * readers announce, so the raw CSS token never reaches assistive technology.
 */
const COLOR_PRESETS: readonly { readonly value: string; readonly label: string }[] = [
    { value: 'var(--color-red)', label: 'red' },
    { value: 'var(--color-orange)', label: 'orange' },
    { value: 'var(--color-yellow)', label: 'yellow' },
    { value: 'var(--color-green)', label: 'green' },
    { value: 'var(--color-cyan)', label: 'cyan' },
    { value: 'var(--color-blue)', label: 'blue' },
    { value: 'var(--color-purple)', label: 'purple' },
    { value: 'var(--color-pink)', label: 'pink' }
]

export interface ColorFieldOptions {
    label: string
    variant: 'editor' | 'panel'
    get(): string
    set(color: string): void
}

/**
 * Color picker row: Obsidian palette presets (theme-variable strings, so the
 * dot follows the theme) plus a native color input for custom hex values.
 */
export function renderColorField(containerEl: HTMLElement, options: ColorFieldOptions): void {
    const setting = new Setting(containerEl)
        .setName(options.label)
        .setDesc('Pick a theme preset or a custom color.')
    const row = setting.controlEl.createDiv({ cls: 'editor-ai-daemons-swatch-row' })

    // `render()` rebuilds the row, destroying the button that was clicked —
    // so the swatch that ends up selected takes the focus back. Without it a
    // keyboard user is dropped to the document after picking a colour.
    let takeFocus = false
    const render = (): void => {
        row.empty()
        const current = options.get()
        let selectedEl: HTMLElement | null = null
        for (const preset of COLOR_PRESETS) {
            const isSelected = preset.value === current
            const swatch = row.createEl('button', {
                cls: 'editor-ai-daemons-swatch',
                attr: {
                    'aria-label': `Use ${preset.label}`,
                    'type': 'button',
                    // Which colour is chosen was said by a border tint and
                    // nothing else: invisible to assistive tech, and one more
                    // hue on a control that is already nothing but hue.
                    // `aria-pressed` states it; the check glyph shows it.
                    'aria-pressed': String(isSelected)
                }
            })
            swatch.style.backgroundColor = preset.value
            if (isSelected) {
                swatch.addClass('is-selected')
                // Deliberately a glyph and not another colour: this button's
                // background is a user-chosen hue, not a theme surface, so no
                // theme variable can be relied on to contrast with it. The
                // stylesheet gives the mark a halo that works over any of them.
                const check = swatch.createSpan({
                    cls: 'editor-ai-daemons-swatch-check',
                    text: '✓'
                })
                check.setAttribute('aria-hidden', 'true')
                selectedEl = swatch
            }
            swatch.addEventListener('click', (event) => {
                event.preventDefault()
                takeFocus = true
                options.set(preset.value)
                render()
            })
        }
        if (takeFocus) {
            takeFocus = false
            selectedEl?.focus()
        }
        const custom = row.createEl('input', {
            cls: 'editor-ai-daemons-swatch-custom',
            type: 'color',
            attr: { 'aria-label': 'Custom color' }
        })
        if (/^#[0-9a-fA-F]{6}$/.test(current)) {
            custom.value = current
        }
        // 'change' (not 'input') so re-rendering never closes a live picker.
        custom.addEventListener('change', () => {
            options.set(custom.value)
            render()
        })
    }
    render()
}

// ---------------------------------------------------------------------------
// Dropdown population
// ---------------------------------------------------------------------------

export interface TargetDropdownConfig {
    noneLabel: string
    includePanels: boolean
}

/**
 * Fills a dropdown with editors and (optionally) panels as binding targets.
 * Panels are visually marked (own optgroup + ring glyph) so both entity
 * kinds stay distinguishable, per Business Rule #11.
 */
export function populateTargetDropdown(
    dropdown: DropdownComponent,
    settings: PluginSettingsV1,
    config: TargetDropdownConfig
): void {
    dropdown.addOption('', config.noneLabel)
    if (settings.editors.length > 0) {
        const group = dropdown.selectEl.createEl('optgroup', { attr: { label: 'Editors' } })
        for (const editor of settings.editors) {
            group.createEl('option', {
                text: entityOptionText('editor', editor.name),
                attr: {
                    value: encodeActionTarget({ targetType: 'editor', targetId: editor.id })
                }
            })
        }
    }
    if (config.includePanels && settings.panels.length > 0) {
        const group = dropdown.selectEl.createEl('optgroup', { attr: { label: 'Panels' } })
        for (const panel of settings.panels) {
            group.createEl('option', {
                text: entityOptionText('panel', panel.name),
                attr: {
                    value: encodeActionTarget({ targetType: 'panel', targetId: panel.id })
                }
            })
        }
    }
}

/** Fills a dropdown with configured backend instances (value = backend id). */
export function populateBackendDropdown(
    dropdown: DropdownComponent,
    settings: PluginSettingsV1,
    noneLabel: string
): void {
    dropdown.addOption('', noneLabel)
    for (const backend of settings.backends) {
        dropdown.addOption(backend.id, `${backend.label} (${backendKindLabel(backend)})`)
    }
}

// ---------------------------------------------------------------------------
// Prompt textarea (text half of every prompt source)
// ---------------------------------------------------------------------------

export interface PromptTextAreaOptions {
    name: string
    desc: string
    placeholder: string
    get(): string
    set(value: string): void
}

/** Full-width textarea row for prompt text (persona, charter, voice…). */
export function renderPromptTextArea(
    containerEl: HTMLElement,
    options: PromptTextAreaOptions
): void {
    new Setting(containerEl)
        .setName(options.name)
        .setDesc(options.desc)
        .setClass('ai-editor-settings-textarea')
        .addTextArea((textArea) => {
            textArea.setPlaceholder(options.placeholder)
            textArea.setValue(options.get())
            textArea.onChange((value) => {
                options.set(value)
            })
        })
}

// ---------------------------------------------------------------------------
// Ordered note-reference list (prompt-source note refs)
// ---------------------------------------------------------------------------

export interface NoteRefsEditorOptions {
    /** App handle for the vault-backed note autocomplete. */
    app: App
    name: string
    desc: string
    getPaths(): readonly string[]
    setPaths(paths: string[]): void | Promise<void>
    /**
     * When provided, renders a 'Follow links' toggle under the list wired to
     * `PromptSource.followLinks` (also include the notes the referenced
     * notes link to — one level).
     */
    followLinks?: {
        get(): boolean
        set(value: boolean): void | Promise<void>
    }
}

/**
 * Ordered list of vault note paths with add/remove/reorder. The add field
 * carries an `AbstractInputSuggest`-based note autocomplete (picking a
 * suggestion adds the note directly); free-typed paths still work for
 * notes that do not exist yet.
 */
export function renderNoteRefsEditor(
    containerEl: HTMLElement,
    options: NoteRefsEditorOptions
): void {
    const wrapper = containerEl.createDiv()

    const render = (): void => {
        wrapper.empty()
        const paths = [...options.getPaths()]
        const apply = (next: string[]): void => {
            void Promise.resolve(options.setPaths(next)).then(render)
        }

        new Setting(wrapper)
            .setName(options.name)
            .setDesc(options.desc)
            .setClass('editor-ai-daemons-note-refs-header')
        if (paths.length === 0) {
            wrapper.createEl('p', {
                cls: 'editor-ai-daemons-empty-state',
                text: 'No notes referenced yet.'
            })
        }
        paths.forEach((path, index) => {
            const row = new Setting(wrapper).setName(path)
            row.setClass('editor-ai-daemons-note-ref-row')
            row.addExtraButton((button) => {
                button
                    .setIcon('arrow-up')
                    .setTooltip('Move up')
                    .setDisabled(index === 0)
                    .onClick(() => {
                        const next = moveItem(paths, index, index - 1)
                        if (next) {
                            apply(next)
                        }
                    })
            })
            row.addExtraButton((button) => {
                button
                    .setIcon('arrow-down')
                    .setTooltip('Move down')
                    .setDisabled(index === paths.length - 1)
                    .onClick(() => {
                        const next = moveItem(paths, index, index + 1)
                        if (next) {
                            apply(next)
                        }
                    })
            })
            row.addExtraButton((button) => {
                button
                    .setIcon('trash')
                    .setTooltip('Remove')
                    .onClick(() => {
                        apply(paths.filter((_, itemIndex) => itemIndex !== index))
                    })
            })
        })

        let pending = ''
        const add = (raw: string): void => {
            const trimmed = raw.trim()
            if (trimmed.length === 0 || paths.includes(trimmed)) {
                return
            }
            apply([...paths, trimmed])
        }
        const submit = (): void => {
            add(pending)
        }
        new Setting(wrapper)
            .setClass('editor-ai-daemons-note-ref-add')
            .addText((text) => {
                text.setPlaceholder('Search notes, or type a path')
                text.onChange((value) => {
                    pending = value
                })
                text.inputEl.addEventListener('keydown', (event) => {
                    if (event.key === 'Enter') {
                        event.preventDefault()
                        submit()
                    }
                })
                // Picking a suggestion adds the note directly; typing a path
                // that matches nothing still works via Enter / "Add note".
                new NotePathSuggest(options.app, text.inputEl, {
                    onPick: add,
                    excludePaths: () => new Set(options.getPaths())
                })
            })
            .addButton((button) => {
                button.setButtonText('Add note').onClick(submit)
            })

        const followLinks = options.followLinks
        if (followLinks) {
            new Setting(wrapper)
                .setName('Follow links')
                .setDesc(
                    'Also include the notes these notes link to (one level). Linked notes count against the context budget.'
                )
                .addToggle((toggle) => {
                    toggle.setValue(followLinks.get())
                    toggle.onChange((value) => {
                        void Promise.resolve(followLinks.set(value))
                    })
                })
        }
    }
    render()
}

// ---------------------------------------------------------------------------
// Chip lists (excluded folders / tags)
// ---------------------------------------------------------------------------

export interface ChipListOptions {
    name: string
    desc: string
    placeholder: string
    emptyText: string
    getValues(): readonly string[]
    setValues(next: string[]): void | Promise<void>
    normalize(raw: string): string
}

/** Chip-style editable string list (used for excluded folders and tags). */
export function renderChipList(containerEl: HTMLElement, options: ChipListOptions): void {
    const wrapper = containerEl.createDiv()

    const render = (): void => {
        wrapper.empty()
        const values = [...options.getValues()]
        const apply = (next: string[]): void => {
            void Promise.resolve(options.setValues(next))
                .then(render)
                .catch(() => {
                    // The facade rejects schema-invalid values (e.g. an
                    // over-long entry): keep the previous list and tell the
                    // user instead of persisting data the load path would wipe.
                    new Notice('AI Editor: value rejected — failed to save settings.')
                    render()
                })
        }

        let pending = ''
        const submit = (): void => {
            const normalized = options.normalize(pending)
            if (normalized.length === 0 || values.includes(normalized)) {
                return
            }
            apply([...values, normalized])
        }
        new Setting(wrapper)
            .setName(options.name)
            .setDesc(options.desc)
            .addText((text) => {
                text.setPlaceholder(options.placeholder)
                text.onChange((value) => {
                    pending = value
                })
                text.inputEl.addEventListener('keydown', (event) => {
                    if (event.key === 'Enter') {
                        event.preventDefault()
                        submit()
                    }
                })
            })
            .addButton((button) => {
                button.setButtonText('Add').onClick(submit)
            })

        const list = wrapper.createDiv({ cls: 'editor-ai-daemons-chip-list' })
        if (values.length === 0) {
            list.createSpan({ cls: 'editor-ai-daemons-chip-empty', text: options.emptyText })
        }
        values.forEach((value, index) => {
            const chip = list.createSpan({ cls: 'editor-ai-daemons-chip' })
            chip.createSpan({ text: value })
            const remove = chip.createEl('button', {
                cls: 'editor-ai-daemons-chip-remove',
                text: '✕',
                attr: { 'aria-label': `Remove ${value}`, 'type': 'button' }
            })
            remove.addEventListener('click', () => {
                apply(values.filter((_, itemIndex) => itemIndex !== index))
            })
        })
    }
    render()
}
