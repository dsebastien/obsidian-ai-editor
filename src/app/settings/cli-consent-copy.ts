import { launchConsentState, toolsConsentState } from '../domain/settings/cli-consent'
import type { CliBackend } from '../domain/settings/settings-schema'
import { getCliToolAdapter } from '../services/backends/cli'

/**
 * What the two consent dialogs say, as data.
 *
 * The copy lives here rather than inside the modals for the same reason the
 * validation messages live with the validation rule: the words ARE the
 * security decision. A user's consent is only meaningful if they were told
 * what they were agreeing to, so what they were told is spec-pinned — a
 * refactor of the dialog cannot quietly drop the sentence about note content
 * going to a local program, and a future contributor cannot soften "you are
 * responsible for what that program does" without a spec turning red.
 *
 * Two dialogs, deliberately unequal (Business Rules #9, plan M7):
 *
 * 1. Running the tool at all — a program starts on your computer, with your
 *    note on its standard input.
 * 2. Tool/research mode — that program may then read and write files and
 *    reach the network on your behalf. Stronger, separate, off by default,
 *    and revocable without disabling the backend.
 */

export interface ConsentDialogCopy {
    readonly title: string
    /** The plain statement of what is being agreed to. */
    readonly message: string
    /** The specific facts, one per line. */
    readonly lines: readonly string[]
    readonly ctaLabel: string
}

/** Sentence-case display name of the tool a backend runs ("Claude Code"). */
export function cliToolName(backend: CliBackend): string {
    return getCliToolAdapter(backend.kind).displayName
}

/** Whether this tool has anything the plugin could safely grant. */
export function cliToolCanGrantTools(backend: CliBackend): boolean {
    return getCliToolAdapter(backend.kind).capabilities().canGrantTools
}

/**
 * Step 1: permission to launch the program at all.
 *
 * The containment lines are here because they are true and because they are
 * what makes the ask reasonable — but the responsibility sentence comes
 * FIRST, so the dialog cannot be read as "this is sandboxed, so it is fine".
 */
export function launchConsentCopy(backend: CliBackend): ConsentDialogCopy {
    const tool = cliToolName(backend)
    const stale = launchConsentState(backend) === 'stale'
    return {
        title: stale ? `Confirm the new ${tool} executable?` : `Allow ${tool} to run?`,
        message: stale
            ? `The executable path changed since you allowed this backend, so the earlier confirmation no longer applies. Using “${backend.label}” starts the program below on this computer, with the content of your notes on its standard input. You are responsible for what that program does.`
            : `Using “${backend.label}” starts a program on this computer, with the content of your notes on its standard input. You are responsible for what that program does.`,
        lines: [
            `It runs exactly this file: ${backend.executablePath}`,
            'It runs in a temporary folder that is deleted when the run ends — never in your vault, and never in the plugin’s own folder.',
            'It gets a minimal environment: no API keys or tokens belonging to other applications, and no shell.',
            `Session persistence is off, so ${tool} does not save this conversation to disk or make it resumable. That is the flag’s guarantee; it is not a promise that the tool writes nothing at all.`,
            'Nothing runs until you ask for a review or an action, and cancelling stops the whole process tree.',
            'You can withdraw this at any time in the Backends tab.'
        ],
        ctaLabel: stale ? 'Confirm' : 'Allow'
    }
}

/**
 * Step 2: permission for the agent to act.
 *
 * Deliberately not a rewording of step 1. What changes is the agent's reach,
 * so that is the first sentence, and the containment that still applies is
 * listed afterwards rather than used to soften it.
 */
export function toolsConsentCopy(backend: CliBackend): ConsentDialogCopy {
    const tool = cliToolName(backend)
    return {
        title: `Allow ${tool} to use tools?`,
        message: `With tool and research mode on, ${tool} may read and write files and reach the network on your behalf while it works on your note. This is a bigger permission than allowing it to run, and it is off by default.`,
        lines: [
            'It still runs in a temporary folder that is deleted when the run ends, with a minimal environment.',
            `Nothing can answer a prompt in a headless run, so anything ${tool} would normally ask about is refused — unless your own ${tool} settings already pre-approve it. The plugin does not read or override those.`,
            'The plugin cannot see or limit what the tool does with the network.',
            'Turning this off later leaves the backend working, just without tools.'
        ],
        ctaLabel: 'Allow tools'
    }
}

/**
 * Why the tool-mode row is absent for a tool the plugin cannot bound.
 *
 * Codex has no off switch for running commands — it is how it answers — so
 * there is nothing consent could unlock, and a toggle that silently did
 * nothing would be worse than no toggle. Saying so is the honest version.
 */
export function toolsUnavailableCopy(backend: CliBackend): string {
    const tool = cliToolName(backend)
    return `${tool} cannot be granted more than this: running commands is how it answers at all, so there is no setting to switch on. What the plugin does enforce is a read-only sandbox, a temporary working folder, and an environment built from nothing.`
}

/** One line describing a consent state, for the settings row. */
export function launchConsentLine(backend: CliBackend): string {
    switch (launchConsentState(backend)) {
        case 'granted':
            return 'Allowed to run this executable.'
        case 'stale':
            return 'The executable changed since you allowed it — confirm the new one before this backend can run.'
        case 'missing':
            return 'Not allowed to run yet. This backend is skipped until you allow it.'
    }
}

/** One line describing the tool-mode state, for the settings row. */
export function toolsConsentLine(backend: CliBackend): string {
    if (!cliToolCanGrantTools(backend)) {
        return toolsUnavailableCopy(backend)
    }
    switch (toolsConsentState(backend)) {
        case 'granted':
            return 'On — the agent may read and write files and use the network.'
        case 'stale':
            return 'Off. The executable changed, so the earlier tool permission no longer applies.'
        case 'missing':
            return 'Off. The agent answers from the note alone.'
    }
}
