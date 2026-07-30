import type { Plugin } from 'obsidian'
import { SetupWizardModal } from '../settings/setup-wizard-modal'
import type { SettingsFacade } from '../settings/settings-facade'

/**
 * `Run setup wizard` (plan M5). Always available: the wizard is re-runnable by
 * design — it seeds its draft from the current settings, so a second pass is
 * editing rather than starting over, and gating it on `onboarded` would hide
 * the one entry point a user who dismissed it needs.
 */
export function registerSetupCommands(plugin: Plugin, facade: SettingsFacade): void {
    plugin.addCommand({
        id: 'setup-wizard',
        name: 'Run setup wizard',
        callback: (): void => {
            new SetupWizardModal(plugin.app, facade).open()
        }
    })
}
