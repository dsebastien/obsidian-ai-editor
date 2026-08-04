import { Modal, Notice, Setting } from 'obsidian'
import type { App } from 'obsidian'
import { generateId } from '../domain/ids'
import {
    advanceSetup,
    applySetupWizard,
    initialSetupDraft,
    nextSetupStep,
    previousSetupStep,
    retreatSetup,
    setupAdvanceBlock,
    setupOutcome
} from '../domain/settings/setup-wizard'
import type { SetupWizardState } from '../domain/settings/setup-wizard'
import { apiBackendSchema, apiProviderKindSchema } from '../domain/settings/settings-schema'
import type { ApiBackend, ApiProviderKind } from '../domain/settings/settings-schema'
import { checkBackendHealth } from '../services/backends/health-check'
import type { BackendHealthResult } from '../services/backends/health-check'
import { hasReviewCapableEditor } from '../services/reviewability'
import { renderNoteRefsEditor } from './components'
import { apiKindLabel, isInsecureRemoteUrl } from './helpers'
import type { SettingsFacade } from './settings-facade'
import {
    DAEMON_COST_WARNING,
    FOLLOW_LINKS_EXPLANATION,
    HEALTH_CHECK_BUTTON,
    HEALTH_CHECK_RUNNING,
    KEY_STORAGE_DISCLOSURE,
    MODE_CHOICE_LABELS,
    SETUP_POINTERS,
    healthCheckBlock,
    healthResultClass,
    healthResultLine,
    nextButtonLabel,
    setupSummaryLines,
    stepBody,
    stepProgressLabel,
    stepTitle
} from './setup-wizard-model'

/**
 * First-run setup wizard (plan M5). Thin glue: the step order, what may be
 * left, and what a finished wizard writes all live in
 * `domain/settings/setup-wizard.ts`; every sentence lives in
 * `setup-wizard-model.ts`.
 *
 * Two behaviors worth stating here because they are this class's job:
 *
 * - NOTHING IS PERSISTED UNTIL Finish. The wizard edits a local draft, so
 *   closing it at any step — Escape, the title-bar X, Cancel — leaves the
 *   settings exactly as they were. The one exception is `onboarded`, which is
 *   set on ANY exit (see `onClose`): `onboarded` means "the wizard has had its
 *   chance", which is what the schema field says it means, and it is what keeps
 *   a user who dismissed the wizard from being asked again on every launch. The
 *   command and the settings button make it re-runnable, so "seen" is never a
 *   one-way door.
 *
 * - KEYBOARD: every control is a real focusable element in tab order, and the
 *   forward button is focused on every step — so the whole flow is Enter,
 *   Enter, Enter for a user who wants the defaults, through native button
 *   activation. A modal-wide Enter binding was considered and rejected: with
 *   the CTA focused it would fire alongside the button's own activation and
 *   advance two steps at once. Escape closes, via Obsidian's modal handling.
 */
export class SetupWizardModal extends Modal {
    private readonly facade: SettingsFacade
    /** Called after a successful Finish — the settings tab re-renders itself. */
    private readonly onFinished: () => void
    private state: SetupWizardState
    private health: BackendHealthResult | null = null
    private healthRunning = false
    /** Set by Finish, so `onClose` knows the settings were already written. */
    private committed = false

    constructor(app: App, facade: SettingsFacade, onFinished: () => void = () => {}) {
        super(app)
        this.facade = facade
        this.onFinished = onFinished
        this.state = { stepId: 'welcome', draft: initialSetupDraft(facade.getSettings()) }
    }

    override onOpen(): void {
        this.modalEl.addClass('editor-ai-daemons-modal')
        this.modalEl.addClass('editor-ai-daemons-wizard')
        this.render()
    }

    /**
     * Records that the wizard has been offered, unless Finish already wrote it.
     * Failure is silent on purpose: being re-offered the wizard is a much
     * smaller problem than a Notice on top of a dialog the user just dismissed.
     */
    override onClose(): void {
        this.contentEl.empty()
        if (!this.committed && !this.facade.getSettings().onboarded) {
            void this.facade
                .update((draft) => {
                    draft.onboarded = true
                })
                .catch(() => undefined)
        }
    }

    // -- Navigation -----------------------------------------------------------

    private goNext(): void {
        if (this.state.stepId === 'done') {
            void this.finish()
            return
        }
        const block = setupAdvanceBlock(this.state)
        if (block !== null) {
            new Notice(block.message)
            return
        }
        const next = advanceSetup(this.state)
        if (next === this.state) {
            return
        }
        this.state = next
        this.render()
    }

    private goBack(): void {
        const previous = retreatSetup(this.state)
        if (previous === this.state) {
            return
        }
        this.state = previous
        this.render()
    }

    /**
     * The single settings write of the whole flow.
     *
     * `applySetupWizard` is a pure whole-value function (that is what makes it
     * spec-pinnable), while the facade takes an Immer mutator — so the applied
     * value is assigned key by key onto the draft. Everything the wizard did
     * not touch comes back identical, which the domain spec pins.
     */
    private async finish(): Promise<void> {
        const applied = applySetupWizard(this.facade.getSettings(), this.state.draft)
        try {
            await this.facade.update((settings) => {
                Object.assign(settings, applied)
            })
        } catch {
            new Notice('AI Editor: could not save the setup. Nothing was changed.')
            return
        }
        this.committed = true
        this.close()
        this.onFinished()
        new Notice('AI Editor is set up.')
    }

    // -- Rendering ------------------------------------------------------------

    private render(): void {
        const { contentEl } = this
        contentEl.empty()
        const stepId = this.state.stepId
        this.setTitle(stepTitle(stepId))

        contentEl.createDiv({
            cls: 'editor-ai-daemons-wizard-progress',
            text: stepProgressLabel(stepId)
        })
        for (const paragraph of stepBody(stepId)) {
            contentEl.createEl('p', { text: paragraph })
        }

        switch (stepId) {
            case 'welcome':
                this.renderWelcome(contentEl)
                break
            case 'backend':
                this.renderBackendStep(contentEl)
                break
            case 'editors':
                this.renderEditorsStep(contentEl)
                break
            case 'voice':
                this.renderVoiceStep(contentEl)
                break
            case 'mode':
                this.renderModeStep(contentEl)
                break
            case 'done':
                this.renderDoneStep(contentEl)
                break
        }

        this.renderNavigation(contentEl)
    }

    private renderWelcome(contentEl: HTMLElement): void {
        const callout = contentEl.createDiv({ cls: 'editor-ai-daemons-settings-callout' })
        callout.createEl('strong', { text: 'Where your API keys are stored' })
        callout.createDiv({ text: KEY_STORAGE_DISCLOSURE })
    }

    // -- Step 2: backend ------------------------------------------------------

    private renderBackendStep(contentEl: HTMLElement): void {
        const draft = this.state.draft.backend
        new Setting(contentEl)
            .setName('Provider')
            .setDesc('Skip this step by leaving it on “None”.')
            .addDropdown((dropdown) => {
                dropdown.addOption('', 'None — skip for now')
                for (const kind of apiProviderKindSchema.options) {
                    dropdown.addOption(kind, apiKindLabel(kind))
                }
                dropdown.setValue(draft?.kind ?? '')
                dropdown.onChange((value) => {
                    const parsed = apiProviderKindSchema.safeParse(value)
                    // Switching provider replaces the draft rather than
                    // carrying fields over: a base URL or deployment from
                    // another provider is never right for the new one, and a
                    // silently inherited value is worse than an empty field.
                    this.setBackendDraft(parsed.success ? this.newBackend(parsed.data) : null)
                })
            })
        if (draft === null) {
            return
        }

        new Setting(contentEl)
            .setName('Label')
            .setDesc('How this backend appears in dropdowns.')
            .addText((text) => {
                text.setValue(draft.label)
                text.onChange((value) => {
                    this.patchBackend({ label: value })
                })
            })

        new Setting(contentEl)
            .setName('API key')
            .setDesc(KEY_STORAGE_DISCLOSURE)
            .addText((text) => {
                text.inputEl.type = 'password'
                text.inputEl.setAttribute('autocomplete', 'new-password')
                text.setValue(draft.apiKey)
                text.onChange((value) => {
                    this.patchBackend({ apiKey: value })
                })
            })

        const needsBaseUrl =
            draft.kind === 'openai-compatible' ||
            draft.kind === 'azure-openai' ||
            draft.kind === 'ollama'
        if (needsBaseUrl) {
            new Setting(contentEl)
                .setName('Base URL')
                .setDesc('Endpoint the requests go to.')
                .addText((text) => {
                    text.setPlaceholder(
                        draft.kind === 'ollama' ? 'http://localhost:11434' : 'https://…'
                    )
                    text.setValue(draft.baseUrl)
                    text.onChange((value) => {
                        this.patchBackend({ baseUrl: value })
                        insecureWarning.toggle(isInsecureRemoteUrl(value))
                    })
                })
            const insecureWarning = contentEl.createDiv({
                cls: 'editor-ai-daemons-modal-warning',
                text: 'This endpoint uses unencrypted HTTP to a remote host — the API key and note content would travel in clear text.'
            })
            insecureWarning.toggle(isInsecureRemoteUrl(draft.baseUrl))
        }

        if (draft.kind === 'azure-openai') {
            new Setting(contentEl)
                .setName('Deployment')
                .setDesc('Azure OpenAI deployment name.')
                .addText((text) => {
                    text.setValue(draft.azureDeployment)
                    text.onChange((value) => {
                        this.patchBackend({ azureDeployment: value })
                    })
                })
        }

        new Setting(contentEl)
            .setName('Model')
            .setDesc('The model every editor uses unless it overrides it.')
            .addText((text) => {
                text.setValue(draft.defaultModel)
                text.onChange((value) => {
                    this.patchBackend({ defaultModel: value })
                })
            })

        this.renderHealthCheck(contentEl)
        contentEl.createEl('p', {
            cls: 'editor-ai-daemons-wizard-aside',
            text: 'Thinking modes, reasoning effort and per-host request flags live in the Backends tab — the defaults are fine to start with.'
        })
    }

    /**
     * The Test connection control. One real request, reported in three states
     * (works / reached but unusable / failed) so "the key is right but this
     * model cannot produce structured output" is not mistaken for a network
     * problem. Its own result element is repainted in place rather than through
     * `render()`, so the field the user just typed into keeps focus.
     *
     * The backend is read from the state AT CLICK TIME, never captured at
     * render time: field edits deliberately skip the re-render (focus), so they
     * produce a new draft object this closure would otherwise not see — the
     * button would then test the model as it read one keystroke ago.
     */
    private renderHealthCheck(contentEl: HTMLElement): void {
        const setting = new Setting(contentEl)
            .setName('Test connection')
            .setDesc('Sends one small request to check the key, the endpoint and the model.')
        const resultEl = contentEl.createDiv()
        const paint = (): void => {
            resultEl.empty()
            resultEl.className = ''
            if (this.healthRunning) {
                resultEl.className = 'editor-ai-daemons-wizard-health'
                resultEl.setText('Testing the connection…')
                return
            }
            if (this.health === null) {
                return
            }
            resultEl.className = healthResultClass(this.health)
            resultEl.setText(healthResultLine(this.health))
        }
        setting.addButton((button) => {
            button.setButtonText(this.healthRunning ? HEALTH_CHECK_RUNNING : HEALTH_CHECK_BUTTON)
            button.setDisabled(this.healthRunning)
            button.onClick(() => {
                const backend = this.state.draft.backend
                if (backend === null) {
                    return
                }
                const model = backend.defaultModel.trim()
                const block = healthCheckBlock(model.length > 0)
                if (block !== null) {
                    new Notice(block)
                    return
                }
                // Same rule that gates Next: a request built from an invalid
                // configuration would report a failure the configuration
                // already explains for free.
                const validation = setupAdvanceBlock(this.state)
                if (validation !== null) {
                    new Notice(validation.message)
                    return
                }
                const testedId = backend.id
                this.healthRunning = true
                this.health = null
                button.setDisabled(true)
                button.setButtonText(HEALTH_CHECK_RUNNING)
                paint()
                void checkBackendHealth({
                    backend,
                    model,
                    fetchImpl: window.fetch.bind(window)
                }).then((result) => {
                    this.healthRunning = false
                    // Keyed on the backend's id, not on object identity: every
                    // keystroke replaces the draft object, and a verdict about
                    // the backend the user is still editing is still about the
                    // right backend. A provider switch (new id) or a step change
                    // discards it — that verdict is about something else.
                    if (
                        this.state.stepId !== 'backend' ||
                        this.state.draft.backend?.id !== testedId
                    ) {
                        return
                    }
                    this.health = result
                    button.setDisabled(false)
                    button.setButtonText(HEALTH_CHECK_BUTTON)
                    paint()
                })
            })
        })
        paint()
    }

    private newBackend(kind: ApiProviderKind): ApiBackend {
        return apiBackendSchema.parse({
            id: generateId(),
            family: 'api',
            kind,
            label: apiKindLabel(kind),
            ...(kind === 'ollama' ? { baseUrl: 'http://localhost:11434' } : {})
        })
    }

    private setBackendDraft(backend: ApiBackend | null): void {
        this.state = { ...this.state, draft: { ...this.state.draft, backend } }
        // A different backend invalidates any previous verdict about it.
        this.health = null
        this.render()
    }

    /** Field edits never re-render: text inputs must keep their focus. */
    private patchBackend(patch: Partial<ApiBackend>): void {
        const current = this.state.draft.backend
        if (current === null) {
            return
        }
        this.state = {
            ...this.state,
            draft: { ...this.state.draft, backend: { ...current, ...patch } }
        }
    }

    // -- Step 3: editors ------------------------------------------------------

    private renderEditorsStep(contentEl: HTMLElement): void {
        const choices = this.state.draft.editors
        if (choices.length === 0) {
            contentEl.createEl('p', {
                cls: 'editor-ai-daemons-empty-state',
                text: 'No editors are configured yet. You can create them in the Editors tab.'
            })
            return
        }
        for (const choice of choices) {
            new Setting(contentEl).setName(choice.name).addToggle((toggle) => {
                toggle.setValue(choice.enabled)
                toggle.onChange((value) => {
                    this.state = {
                        ...this.state,
                        draft: {
                            ...this.state.draft,
                            editors: this.state.draft.editors.map((candidate) =>
                                candidate.id === choice.id
                                    ? { ...candidate, enabled: value }
                                    : candidate
                            )
                        }
                    }
                })
            })
        }
    }

    // -- Step 4: voice profile ------------------------------------------------

    private renderVoiceStep(contentEl: HTMLElement): void {
        renderNoteRefsEditor(contentEl, {
            app: this.app,
            name: 'Voice profile notes',
            desc: 'Sent with every run, in this order.',
            getPaths: () => this.state.draft.voiceNotePaths,
            setPaths: (paths) => {
                this.state = {
                    ...this.state,
                    draft: { ...this.state.draft, voiceNotePaths: paths }
                }
            },
            followLinks: {
                get: () => this.state.draft.voiceFollowLinks,
                set: (value) => {
                    this.state = {
                        ...this.state,
                        draft: { ...this.state.draft, voiceFollowLinks: value }
                    }
                }
            }
        })
        contentEl.createEl('p', {
            cls: 'editor-ai-daemons-wizard-aside',
            text: FOLLOW_LINKS_EXPLANATION
        })
    }

    // -- Step 5: summon vs daemon --------------------------------------------

    private renderModeStep(contentEl: HTMLElement): void {
        new Setting(contentEl).setName('When editors run').addDropdown((dropdown) => {
            dropdown.addOption('summon', MODE_CHOICE_LABELS.summon)
            dropdown.addOption('daemon', MODE_CHOICE_LABELS.daemon)
            dropdown.setValue(this.state.draft.daemonMode ? 'daemon' : 'summon')
            dropdown.onChange((value) => {
                this.state = {
                    ...this.state,
                    draft: { ...this.state.draft, daemonMode: value === 'daemon' }
                }
                // The cost warning is only shown for the option that costs:
                // re-render so it appears and disappears with the choice.
                this.render()
            })
        })
        if (this.state.draft.daemonMode) {
            const warning = contentEl.createDiv({ cls: 'editor-ai-daemons-modal-warning' })
            warning.setText(DAEMON_COST_WARNING)
        }
    }

    // -- Step 6: done ---------------------------------------------------------

    private renderDoneStep(contentEl: HTMLElement): void {
        const settings = this.facade.getSettings()
        const draft = this.state.draft
        const outcome = setupOutcome(settings, draft)
        // Asked of the settings the wizard is ABOUT to write, through the same
        // predicate every dispatch surface uses — so "nothing will run yet" is
        // the truth rather than an approximation of it.
        const canReview = hasReviewCapableEditor(applySetupWizard(settings, draft))
        const summary = contentEl.createEl('ul', { cls: 'editor-ai-daemons-confirm-lines' })
        for (const line of setupSummaryLines(outcome, canReview)) {
            summary.createEl('li', { text: line })
        }
        contentEl.createEl('p', {
            cls: 'editor-ai-daemons-wizard-aside',
            text: 'Where to go from here:'
        })
        const pointers = contentEl.createEl('ul', { cls: 'editor-ai-daemons-confirm-lines' })
        for (const pointer of SETUP_POINTERS) {
            pointers.createEl('li', { text: pointer })
        }
    }

    // -- Footer ---------------------------------------------------------------

    private renderNavigation(contentEl: HTMLElement): void {
        const stepId = this.state.stepId
        // Explicitly classed rather than styled as the last `.setting-item`:
        // `:last-of-type` matches by tag name, and the wizard's steps mix
        // divs freely, so a step ending in any other div would lose the
        // separator that sets the buttons apart from the step's content.
        const setting = new Setting(contentEl).setClass('editor-ai-daemons-wizard-nav')
        if (previousSetupStep(stepId) !== null) {
            setting.addButton((button) => {
                button.setButtonText('Back').onClick(() => this.goBack())
            })
        }
        setting.addButton((button) => {
            button.setButtonText('Cancel').onClick(() => this.close())
        })
        setting.addButton((button) => {
            button
                .setButtonText(nextButtonLabel(stepId))
                .setCta()
                .onClick(() => this.goNext())
            // Focused synchronously (the element is already attached) so the
            // flow is Enter-Enter-Enter for a user who wants the defaults, with
            // no timer to outlive the dialog.
            button.buttonEl.focus()
        })
        if (nextSetupStep(stepId) !== null) {
            contentEl.createEl('p', {
                cls: 'editor-ai-daemons-wizard-aside',
                text: 'Nothing is saved until the last step.'
            })
        }
    }
}
