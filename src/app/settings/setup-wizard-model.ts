import type { SetupOutcome, SetupWizardStepId } from '../domain/settings/setup-wizard'
import { SETUP_STEP_COUNT, setupStepIndex } from '../domain/settings/setup-wizard'
import type { BackendHealthResult } from '../services/backends/health-check'

/**
 * Pure copy for the setup wizard. Every sentence a first-time user reads lives
 * here, so the modal stays glue and the wording is spec-covered — the two
 * things this flow MUST say correctly (where API keys are stored, what daemon
 * mode costs) are exactly the kind of sentence that rots when assembled inside
 * a render function.
 */

/** Modal title: the step's own name, so the title bar tracks progress. */
const STEP_TITLES: Record<SetupWizardStepId, string> = {
    welcome: 'Welcome to AI Editor',
    backend: 'Connect an AI backend',
    editors: 'Choose your editors',
    voice: 'Teach the editors your voice',
    mode: 'When should editors run?',
    done: 'You are set up'
}

export function stepTitle(stepId: SetupWizardStepId): string {
    return STEP_TITLES[stepId]
}

/** "Step 2 of 6" — the wizard's only progress indicator. */
export function stepProgressLabel(stepId: SetupWizardStepId): string {
    return `Step ${setupStepIndex(stepId) + 1} of ${SETUP_STEP_COUNT}`
}

/**
 * The welcome step's step count, derived rather than written. The copy said
 * "five short steps" while `SETUP_WIZARD_STEPS` had six and the progress line
 * right beneath it read "Step 1 of 6" — the first sentence a new user reads
 * disagreeing with the indicator next to it. Deriving it means the copy cannot
 * drift from the step list again.
 */
const STEP_COUNT_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight']
const STEP_COUNT_WORD = STEP_COUNT_WORDS[SETUP_STEP_COUNT] ?? String(SETUP_STEP_COUNT)

/** Body paragraphs of a step, in order. */
const STEP_BODIES: Record<SetupWizardStepId, readonly string[]> = {
    welcome: [
        'AI Editor reviews the note you are writing with editors you configure — personas with their own instructions, each reporting findings you accept or dismiss one by one. It also rewrites selections and continues your text, always as a suggestion you approve first.',
        'Nothing is ever sent to an AI backend without an explicit action from you, and nothing is ever written into a note without your confirmation.',
        `This wizard takes ${STEP_COUNT_WORD} short steps. You can leave any of them empty and change everything later in the settings.`
    ],
    backend: [
        'An editor needs a backend to run: a provider, a key, and a model. Pick the provider you have an account with — or Ollama to run models locally, which sends nothing off your machine.',
        'You can skip this step and add a backend later in the Backends tab.'
    ],
    editors: [
        'AI Editor ships with six editors, each looking at a different aspect of your writing. Every enabled editor runs on every review, and each one is a separate request to your backend — so start with two or three and add more once you know which ones earn their keep.',
        'All of them are fully editable in the Editors tab: their instructions are just text.'
    ],
    voice: [
        'A voice profile teaches every editor how you write, so their suggestions sound like you instead of like a style guide. Point at the notes that describe your voice — they are read fresh on every run, so editing a note IS reconfiguring the plugin.',
        'Optional, and easy to add later in the Voice & style tab.'
    ],
    mode: [
        'By default, editors wait to be summoned: they run when you select Review, run an action, or ask an editor a question. Nothing happens while you type.',
        'Daemon mode instead lets editors refresh their findings automatically after you pause editing a note.'
    ],
    done: [
        'Everything here lives in the plugin settings and can be changed at any time. You can re-run this wizard from Behavior → Setup.'
    ]
}

export function stepBody(stepId: SetupWizardStepId): readonly string[] {
    return STEP_BODIES[stepId]
}

/**
 * The key disclosure (Business Rules #12), shown on the welcome step AND next
 * to the key field. Said twice on purpose: once where the user decides whether
 * to trust the plugin at all, once where they actually paste the secret.
 */
export const KEY_STORAGE_DISCLOSURE =
    'API keys you enter are stored in plain text in this plugin’s data.json inside your vault. If your vault is synced or backed up, the keys travel with it. Exported settings never include them.'

/** Cost implication of daemon mode — stated plainly, per Business Rule #1. */
export const DAEMON_COST_WARNING =
    'Every automatic refresh is a paid request to each enabled editor’s backend. On a note you edit for an hour that can be dozens of runs, so daemon mode can cost far more than summoning reviews yourself. It is off by default; local models make it cheap.'

/** Label of the summon/daemon choice, per option. */
export const MODE_CHOICE_LABELS = {
    summon: 'Wait to be summoned (recommended)',
    daemon: 'Daemon mode — refresh automatically after I pause'
} as const

/** Explanation of the note-refs "Follow links" toggle on the voice step. */
export const FOLLOW_LINKS_EXPLANATION =
    'With Follow links on, the notes your voice notes link to are included too (one hop, embeds included). That is the point of a hub note like “My Voice Profile” that links out to your style and identity notes. Excluded notes are never attached, and everything stays within your context budget.'

/** Test-connection button states. */
export const HEALTH_CHECK_RUNNING = 'Testing…'
export const HEALTH_CHECK_BUTTON = 'Test connection'

/**
 * Why the Test connection button cannot run, or null when it can. A model is
 * required because the probe IS a real request: without one it would fail for a
 * reason that has nothing to do with the connection being tested.
 */
export function healthCheckBlock(hasModel: boolean): string | null {
    return hasModel ? null : 'Enter a model to test with.'
}

/** One line reporting a finished health check, prefixed by its verdict. */
export function healthResultLine(result: BackendHealthResult): string {
    switch (result.status) {
        case 'ok':
            return 'Connection works — this backend can run reviews.'
        case 'unusable':
            return `Reached, but not usable. ${result.message}`
        case 'failed':
            return `Failed. ${result.message}`
    }
}

/** CSS state class for the result line, so a failure is not styled as success. */
export function healthResultClass(result: BackendHealthResult): string {
    return `editor-ai-daemons-wizard-health editor-ai-daemons-wizard-health-${result.status}`
}

/** Label of the wizard's forward button. */
export function nextButtonLabel(stepId: SetupWizardStepId): string {
    switch (stepId) {
        case 'welcome':
            return 'Get started'
        case 'done':
            return 'Finish'
        default:
            return 'Next'
    }
}

/**
 * The last step's summary: what was chosen, and — when the result cannot run a
 * review — that fact first. `canReview` comes from `hasReviewCapableEditor`
 * over the settings the wizard is about to write, not from a guess.
 */
export function setupSummaryLines(outcome: SetupOutcome, canReview: boolean): readonly string[] {
    const lines: string[] = []
    if (!canReview) {
        // The cause is inferred from facts the outcome carries, and stops at
        // what those facts actually prove. Deriving it from the editor count
        // alone told a user whose editors all had `review` off — or whose only
        // backend was disabled — to go add a backend, which is the wrong tab.
        lines.push(
            outcome.enabledEditorCount === 0
                ? 'No editor is enabled, so nothing will run yet. Enable one in the Editors tab.'
                : !outcome.hasBackend
                  ? 'No backend configured yet, so nothing will run. Add one in the Backends tab.'
                  : 'Nothing will run yet — check that a backend is enabled and has a model, and that an editor can review, in the Backends and Editors tabs.'
        )
    }
    if (outcome.backendAdded) {
        lines.push(
            outcome.becameDefaultBackend
                ? 'Backend added, and set as the default every editor uses.'
                : 'Backend added. Your existing default backend is unchanged.'
        )
    }
    lines.push(
        outcome.enabledEditorCount === 1
            ? '1 editor enabled.'
            : `${outcome.enabledEditorCount} editors enabled.`
    )
    if (outcome.voiceNoteCount > 0) {
        lines.push(
            outcome.voiceNoteCount === 1
                ? '1 voice profile note will be sent with every run.'
                : `${outcome.voiceNoteCount} voice profile notes will be sent with every run.`
        )
    }
    lines.push(
        outcome.daemonMode
            ? 'Daemon mode on — editors refresh automatically after you pause editing.'
            : 'Editors wait to be summoned.'
    )
    return lines
}

/**
 * Where to go next, shown on the last step. Every pointer names a surface that
 * exists in the app right now — the command palette is the documentation a new
 * user will actually read, so it is named first and by prefix.
 */
export const SETUP_POINTERS: readonly string[] = [
    'Open a note and run the command “AI Editor: Review current note”, or select Review in the rail at the right edge of the editor.',
    'The review panel (“AI Editor: Open review panel”) lists every finding, and its Review button starts a review for the note you are on.',
    'Run “AI Editor: Preview what will be sent” before your first paid review to see exactly what leaves your vault.',
    'Type “AI Editor” in the command palette to see everything the plugin can do.',
    'Every setting, including this wizard, lives in Settings → AI Editor.'
]
