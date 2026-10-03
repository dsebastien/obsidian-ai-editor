import { SecretComponent, Setting } from 'obsidian'
import type { App } from 'obsidian'
import { readSecret } from '../domain/settings/api-key-secrets'
import type { ApiProviderKind } from '../domain/settings/settings-schema'
import { getSecretStore } from '../services/backends/secret-reader'

/** Provider kinds that cannot be called without a key. */
export function apiKindNeedsKey(kind: ApiProviderKind): boolean {
    return (
        kind === 'anthropic' ||
        kind === 'openai' ||
        kind === 'openrouter' ||
        kind === 'azure-openai'
    )
}

export interface ApiKeySettingOptions {
    readonly desc: string
    /** Current secret name ('' = none). */
    readonly getName: () => string
    readonly setName: (name: string) => void
    /** Whether a legacy plaintext copy still backs this backend. */
    readonly hasLegacyCopy: () => boolean
    /** Shown as a "Clear" button when provided (existing backends). */
    readonly onClear?: () => void
}

/** The status line under the secret picker. */
function statusText(name: string, legacy: boolean): { text: string; missing: boolean } {
    if (name.length === 0) {
        return { text: 'No secret selected.', missing: false }
    }
    if (readSecret(getSecretStore(), name) !== null) {
        return { text: 'Set on this device.', missing: false }
    }
    if (legacy) {
        return { text: 'Will be moved into secret storage on first use.', missing: false }
    }
    return { text: 'Not set on this device — set the secret to use this backend.', missing: true }
}

/**
 * API key row: an Obsidian secret picker. Only the secret NAME is kept in the
 * backend; the value lives in this device's SecretStorage and is never shown.
 */
export function addApiKeySetting(
    app: App,
    containerEl: HTMLElement,
    options: ApiKeySettingOptions
): void {
    const setting = new Setting(containerEl).setName('API key').setDesc(options.desc)
    const status = setting.descEl.createDiv({ cls: 'editor-ai-daemons-consent-line' })
    const paint = (): void => {
        const next = statusText(options.getName(), options.hasLegacyCopy())
        status.setText(next.text)
        status.toggleClass('is-missing', next.missing)
    }
    setting.addComponent((el) =>
        new SecretComponent(app, el).setValue(options.getName()).onChange((name) => {
            options.setName(name)
            paint()
        })
    )
    const onClear = options.onClear
    if (onClear) {
        setting.addButton((button) => {
            button
                .setButtonText('Clear')
                .setTooltip('Empty this secret on this device and remove the plain-text copy')
                .onClick(() => {
                    onClear()
                    paint()
                })
        })
    }
    paint()
}
