import { Modal, Notice, Setting } from 'obsidian'
import type { App } from 'obsidian'
import { validateCliBackend } from '../../domain/settings/backend-validation'
import {
    consentForPath,
    grantLaunchConsent,
    grantToolsConsent,
    hasLaunchConsent,
    hasToolsConsent,
    revokeLaunchConsent,
    revokeToolsConsent
} from '../../domain/settings/cli-consent'
import { cliBackendSchema } from '../../domain/settings/settings-schema'
import type { CliBackend } from '../../domain/settings/settings-schema'
import { generateId } from '../../domain/ids'
import {
    currentCliPlatform,
    detectCliExecutables,
    detectionSummary,
    nodeExecutableProbe,
    nodeHomeDirectory
} from '../../services/backends/cli'
import { checkBackendHealth } from '../../services/backends/health-check'
import type { BackendHealthResult } from '../../services/backends/health-check'
import {
    cliToolCanGrantTools,
    launchConsentCopy,
    launchConsentLine,
    toolsConsentCopy,
    toolsConsentLine
} from '../cli-consent-copy'
import { ConfirmModal } from '../components'
import { backendKindLabel } from '../helpers'
import { healthResultClass, healthResultLine } from '../setup-wizard-model'
import { commit } from './shared'
import type { TabContext } from './shared'

/**
 * Create/edit dialog for one CLI backend (Claude Code, Codex).
 *
 * Separate from `BackendModal` on purpose: an API backend is configured by
 * naming an endpoint and a key, a CLI backend by naming a PROGRAM and then
 * agreeing, twice, to what running it means. The two dialogs share no field
 * except the label, and merging them would put the consent machinery on a
 * screen where it does not belong.
 *
 * The dialog works on a local draft; nothing is persisted until Save. Consent
 * granted here rides on the draft and is re-derived against the saved path by
 * `validateCliBackend`, so a user who allows a path and then edits it cannot
 * save consent for a program they were never shown.
 *
 * Test connection is gated by launch consent, because it IS a launch — the
 * probe runs the real tool through the real boundary. Offering a "just
 * checking" path around consent would make the consent decorative.
 */
export class CliBackendModal extends Modal {
    private readonly ctx: TabContext
    private readonly isNew: boolean
    private draft: CliBackend
    private health: BackendHealthResult | null = null
    private healthRunning = false
    /** Detection outcome to show under the path field, if any. */
    private detectLine = ''
    /** Other usable paths detection found, offered as alternatives. */
    private detectAlternatives: readonly string[] = []

    constructor(app: App, ctx: TabContext, existing: CliBackend | null, kind: CliBackend['kind']) {
        super(app)
        this.ctx = ctx
        this.isNew = existing === null
        this.draft = existing
            ? structuredClone(existing)
            : cliBackendSchema.parse({
                  id: generateId(),
                  family: 'cli',
                  kind,
                  label: kind === 'claude-code' ? 'Claude Code' : 'Codex'
              })
    }

    override onOpen(): void {
        const label = backendKindLabel(this.draft)
        this.setTitle(this.isNew ? `Add ${label} backend` : `Edit ${label} backend`)
        this.modalEl.addClass('editor-ai-daemons-modal')
        this.renderContent()
    }

    override onClose(): void {
        this.contentEl.empty()
    }

    /** Applies a change and re-renders, so consent rows always match the path. */
    private update(mutate: (draft: CliBackend) => void): void {
        const next = structuredClone(this.draft)
        mutate(next)
        this.draft = next
        this.renderContent()
    }

    private renderContent(): void {
        const { contentEl } = this
        contentEl.empty()

        const callout = contentEl.createDiv({ cls: 'editor-ai-daemons-settings-callout' })
        callout.createEl('strong', { text: 'This backend runs a program on your computer' })
        callout.createDiv({
            text: 'Your note is sent to it on standard input. It runs with no shell, in a temporary folder outside your vault, with a minimal environment — and only when you ask for a review or an action.'
        })

        new Setting(contentEl)
            .setName('Tool')
            .setDesc(
                'Fixed once the backend exists: the tool decides the invocation, the output protocol and what consent can grant. Add a second backend to use the other one.'
            )
            .addText((text) => {
                text.setValue(backendKindLabel(this.draft))
                text.setDisabled(true)
            })

        new Setting(contentEl)
            .setName('Label')
            .setDesc('How this backend appears in dropdowns.')
            .addText((text) => {
                text.setValue(this.draft.label)
                text.onChange((value) => {
                    this.draft.label = value
                })
            })

        this.renderExecutableField(contentEl)

        new Setting(contentEl)
            .setName('Default model')
            .setDesc('Optional. Leave empty to let the tool pick its own current default.')
            .addText((text) => {
                text.setPlaceholder('Tool default')
                text.setValue(this.draft.defaultModel)
                text.onChange((value) => {
                    this.draft.defaultModel = value
                })
            })

        new Setting(contentEl)
            .setName('Timeout')
            .setDesc(
                'Seconds one run may take before the tool and everything it started are stopped. Agents are slower than a chat completion.'
            )
            .addText((text) => {
                text.inputEl.type = 'number'
                text.inputEl.min = '10'
                text.inputEl.max = '3600'
                text.setValue(String(this.draft.timeoutSeconds))
                text.inputEl.addEventListener('change', () => {
                    const parsed = Number.parseInt(text.inputEl.value, 10)
                    const next = Number.isFinite(parsed)
                        ? Math.min(3_600, Math.max(10, parsed))
                        : this.draft.timeoutSeconds
                    this.draft.timeoutSeconds = next
                    text.setValue(String(next))
                })
            })

        new Setting(contentEl).setName('Permissions').setHeading()
        this.renderLaunchConsentRow(contentEl)
        this.renderToolsConsentRow(contentEl)

        new Setting(contentEl).setName('Check').setHeading()
        this.renderHealthCheck(contentEl)

        new Setting(contentEl)
            .addButton((button) => {
                button.setButtonText('Cancel').onClick(() => this.close())
            })
            .addButton((button) => {
                button
                    .setButtonText(this.isNew ? 'Add backend' : 'Save')
                    .setCta()
                    .onClick(() => this.save())
            })
    }

    /**
     * Executable path, plus Detect.
     *
     * Editing the path drops any consent recorded for the previous one
     * immediately, so the rows below never claim permission for a binary that
     * is no longer in the field.
     */
    private renderExecutableField(contentEl: HTMLElement): void {
        const setting = new Setting(contentEl)
            .setName('Executable')
            .setDesc(
                'Full path to the tool’s program. A bare name or a relative path is refused: it would be resolved through PATH or the working directory, neither of which is safe to trust.'
            )
        setting.addText((text) => {
            text.setPlaceholder('/usr/local/bin/claude')
            text.setValue(this.draft.executablePath)
            text.inputEl.addClass('editor-ai-daemons-wide-input')
            text.inputEl.addEventListener('change', () => {
                const value = text.inputEl.value
                this.update((draft) => {
                    draft.executablePath = value
                    draft.consent = consentForPath(draft.consent, value)
                })
            })
        })
        setting.addButton((button) => {
            button
                .setButtonText('Detect')
                .setTooltip('Look in common install locations. Nothing is run.')
                .onClick(() => {
                    const platform = currentCliPlatform()
                    const result = detectCliExecutables({
                        kind: this.draft.kind,
                        platform,
                        home: nodeHomeDirectory(),
                        probe: nodeExecutableProbe
                    })
                    // Recorded before the re-render, which rebuilds this whole
                    // dialog from `this` — so the outcome has to live on the
                    // instance, not in a local closure over dead DOM.
                    this.detectLine = detectionSummary({ result, platform, kind: this.draft.kind })
                    this.detectAlternatives = result.found
                        .slice(1)
                        .map((candidate) => candidate.path)
                    const first = result.found[0]
                    this.update((draft) => {
                        if (first !== undefined) {
                            draft.executablePath = first.path
                            draft.consent = consentForPath(draft.consent, first.path)
                        }
                    })
                })
        })
        if (this.detectLine.length > 0) {
            const hint = contentEl.createDiv({
                cls: 'editor-ai-daemons-modal-hint',
                text: this.detectLine
            })
            if (this.detectAlternatives.length > 0) {
                const list = hint.createEl('ul', { cls: 'editor-ai-daemons-confirm-lines' })
                for (const path of this.detectAlternatives) {
                    list.createEl('li', { text: path })
                }
            }
        }
    }

    private renderLaunchConsentRow(contentEl: HTMLElement): void {
        const granted = hasLaunchConsent(this.draft)
        const setting = new Setting(contentEl)
            .setName('Allowed to run')
            .setDesc(launchConsentLine(this.draft))
        setting.addButton((button) => {
            if (granted) {
                button
                    .setButtonText('Withdraw')
                    .setWarning()
                    .onClick(() => {
                        this.update((draft) => {
                            draft.consent = revokeLaunchConsent()
                            // A backend nobody has allowed must not stay
                            // enabled: `enabled` without consent is exactly the
                            // state the resolution gate refuses, and leaving it
                            // would show a running-looking backend that skips.
                            draft.enabled = false
                        })
                    })
                return
            }
            button
                .setButtonText('Allow…')
                .setCta()
                .onClick(() => {
                    this.askLaunchConsent(() => undefined)
                })
        })
    }

    private renderToolsConsentRow(contentEl: HTMLElement): void {
        const setting = new Setting(contentEl)
            .setName('Tool and research mode')
            .setDesc(toolsConsentLine(this.draft))
        if (!cliToolCanGrantTools(this.draft)) {
            return
        }
        const granted = hasToolsConsent(this.draft)
        setting.addButton((button) => {
            if (granted) {
                button
                    .setButtonText('Turn off')
                    .setWarning()
                    .onClick(() => {
                        // Revoking tools never touches the backend itself.
                        this.update((draft) => {
                            draft.consent = revokeToolsConsent(draft)
                        })
                    })
                return
            }
            button.setButtonText('Allow tools…').onClick(() => {
                if (!hasLaunchConsent(this.draft)) {
                    new Notice('Allow this backend to run first.')
                    return
                }
                const copy = toolsConsentCopy(this.draft)
                new ConfirmModal(this.app, {
                    title: copy.title,
                    message: copy.message,
                    impactLines: copy.lines,
                    ctaLabel: copy.ctaLabel,
                    onConfirm: () => {
                        this.update((draft) => {
                            draft.consent = grantToolsConsent(draft)
                        })
                    }
                }).open()
            })
        })
    }

    /**
     * Asks for launch consent, then runs `onGranted`.
     *
     * The one entry point for step 1 inside this dialog, so the wording and
     * the recording cannot diverge between the Allow button and Test.
     */
    private askLaunchConsent(onGranted: () => void): void {
        const validation = validateCliBackend({
            draft: this.draft,
            platform: currentCliPlatform(),
            probe: nodeExecutableProbe
        })
        if (!validation.ok) {
            // Never ask about a path that is not a runnable program: the answer
            // would be consent to something that cannot exist.
            new Notice(validation.message)
            return
        }
        const copy = launchConsentCopy(validation.backend)
        new ConfirmModal(this.app, {
            title: copy.title,
            message: copy.message,
            impactLines: copy.lines,
            ctaLabel: copy.ctaLabel,
            onConfirm: () => {
                this.update((draft) => {
                    draft.consent = grantLaunchConsent(draft)
                })
                onGranted()
            }
        }).open()
    }

    /**
     * Test connection: one real run through the whole boundary.
     *
     * It needs launch consent because it launches, and it needs a saveable
     * configuration because a probe built from an invalid one would report a
     * failure the configuration already explains for free.
     */
    private renderHealthCheck(contentEl: HTMLElement): void {
        const setting = new Setting(contentEl)
            .setName('Test connection')
            .setDesc(
                'Runs one trivial review through the real path: the same executable, the same temporary folder, the same environment and timeout.'
            )
        const resultEl = contentEl.createDiv()
        if (this.health !== null) {
            resultEl.className = healthResultClass(this.health)
            resultEl.setText(healthResultLine(this.health))
        }
        setting.addButton((button) => {
            button.setButtonText(this.healthRunning ? 'Testing…' : 'Test connection')
            button.setDisabled(this.healthRunning)
            button.onClick(() => {
                const validation = validateCliBackend({
                    draft: this.draft,
                    platform: currentCliPlatform(),
                    probe: nodeExecutableProbe
                })
                if (!validation.ok) {
                    new Notice(validation.message)
                    return
                }
                if (!hasLaunchConsent(validation.backend)) {
                    this.askLaunchConsent(() => {
                        new Notice('Allowed. Select Test connection again to run it.')
                    })
                    return
                }
                const testedPath = validation.backend.executablePath
                this.healthRunning = true
                this.health = null
                this.renderContent()
                void checkBackendHealth({
                    backend: validation.backend,
                    model: validation.backend.defaultModel
                }).then((result) => {
                    // Nothing captured from the render that started the probe
                    // is touched here. A CLI check runs for up to two minutes,
                    // and editing the path, selecting Detect or changing tool
                    // consent all re-render the dialog in the meantime — the
                    // button and the result element from back then are
                    // detached, so painting them would leave the LIVE button
                    // disabled and saying ‘Testing…’ forever.
                    this.healthRunning = false
                    // A verdict is about the executable that was tested. If the
                    // field moved on while the tool ran, it is about something
                    // else and is discarded rather than shown.
                    this.health = this.draft.executablePath.trim() === testedPath ? result : null
                    this.renderContent()
                })
            })
        })
    }

    private save(): void {
        const validation = validateCliBackend({
            draft: this.draft,
            platform: currentCliPlatform(),
            probe: nodeExecutableProbe
        })
        if (!validation.ok) {
            new Notice(validation.message)
            return
        }
        const backend = validation.backend
        commit(
            this.ctx,
            (draft) => {
                const index = draft.backends.findIndex((candidate) => candidate.id === backend.id)
                if (index >= 0) {
                    draft.backends[index] = backend
                } else {
                    draft.backends.push(backend)
                }
            },
            { refresh: true }
        )
        this.close()
    }
}
