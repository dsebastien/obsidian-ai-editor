import { validateApiBackend } from './backend-validation'
import type { ApiBackend, PluginSettingsV1 } from './settings-schema'

/**
 * The setup wizard as a pure state machine plus one pure "apply" (plan M5, the
 * last remaining M5 item).
 *
 * Everything the wizard DECIDES lives here so it can be spec-pinned without a
 * vault: which steps exist, in what order, when a step may be left, and what a
 * finished wizard does to the settings. `settings/setup-wizard-model.ts` owns
 * every string the user reads; `settings/setup-wizard-modal.ts` is glue.
 *
 * Two rules shape the whole design:
 *
 * 1. NOTHING IS WRITTEN UNTIL THE END. The wizard accumulates a draft and
 *    `applySetupWizard` turns it into one settings update. Cancelling at any
 *    step therefore cannot leave a half-configured plugin — there is no
 *    sequence of partial writes to be interrupted in the first place. The
 *    alternative (commit per step) would need every step to be independently
 *    valid, which the backend step is not: a label with no model is a backend
 *    that exists and cannot run.
 *
 * 2. A STEP MAY BE LEFT EMPTY, BUT NOT HALF-FILLED. Every step except the
 *    backend is optional by nature (which editors, which voice notes, which
 *    mode all have defaults). The backend step is optional too — it can be
 *    skipped outright — but it refuses to advance with an incomplete backend,
 *    because that is the one input where "some of it" is worse than none.
 */

export const SETUP_WIZARD_STEPS = [
    'welcome',
    'backend',
    'editors',
    'voice',
    'mode',
    'done'
] as const
export type SetupWizardStepId = (typeof SETUP_WIZARD_STEPS)[number]

/** One offered editor and whether the user wants it on. */
export interface SetupEditorChoice {
    readonly id: string
    readonly name: string
    readonly enabled: boolean
}

export interface SetupWizardDraft {
    /**
     * The backend being configured, or null when the step was skipped. Held as
     * a full `ApiBackend` (id included) so the wizard and the Backends tab
     * validate the same value with the same rule.
     */
    readonly backend: ApiBackend | null
    /**
     * The editors the wizard OFFERED, with the user's choice. Carrying the
     * offer — not just the chosen ids — is what keeps `applySetupWizard` from
     * disabling editors the wizard never showed (a second run in a vault whose
     * editor list has grown since).
     */
    readonly editors: readonly SetupEditorChoice[]
    readonly voiceNotePaths: readonly string[]
    readonly voiceFollowLinks: boolean
    /** false = summon only (default), true = daemon mode. */
    readonly daemonMode: boolean
}

export interface SetupWizardState {
    readonly stepId: SetupWizardStepId
    readonly draft: SetupWizardDraft
}

/** Why a step refuses to advance. `null` = it may be left. */
export type SetupAdvanceBlock = {
    readonly code: 'backend-incomplete' | 'backend-model-required'
    readonly message: string
}

/** Step index (0-based) — drives the "Step n of m" line and Back availability. */
export function setupStepIndex(stepId: SetupWizardStepId): number {
    return SETUP_WIZARD_STEPS.indexOf(stepId)
}

export const SETUP_STEP_COUNT = SETUP_WIZARD_STEPS.length

/**
 * The draft a wizard opens with: the current settings, so re-running it is
 * editing rather than starting over. The backend starts null — the wizard adds
 * a backend, it never edits an existing one (that is the Backends tab's job,
 * and silently rewriting a configured backend from a first-run flow would be a
 * surprise).
 */
export function initialSetupDraft(settings: PluginSettingsV1): SetupWizardDraft {
    return {
        backend: null,
        editors: settings.editors.map((editor) => ({
            id: editor.id,
            name: editor.name,
            enabled: editor.enabled
        })),
        voiceNotePaths: [...settings.voiceProfile.notePaths],
        voiceFollowLinks: settings.voiceProfile.followLinks,
        daemonMode: settings.behavior.daemonMode
    }
}

/**
 * Whether the current step blocks Next, and why.
 *
 * Only the backend step ever blocks, and only when it has been touched: an
 * untouched backend (null draft) means "skip this", which is allowed — a user
 * who wants to look around before pasting a key must not be trapped on step 2.
 */
export function setupAdvanceBlock(state: SetupWizardState): SetupAdvanceBlock | null {
    if (state.stepId !== 'backend' || state.draft.backend === null) {
        return null
    }
    const validation = validateApiBackend(state.draft.backend)
    if (!validation.ok) {
        return { code: 'backend-incomplete', message: validation.message }
    }
    if (validation.backend.defaultModel.trim().length === 0) {
        // The Backends tab legitimately saves a model-less backend — a user may
        // set the model per editor. The WIZARD may not: it wires what it adds
        // as the global default, so a model-less backend here is the exact
        // "a label with no model is a backend that exists and cannot run" case
        // this step exists to refuse, and it would make every editor that
        // inherits the default resolve `no-model-configured`.
        return {
            code: 'backend-model-required',
            message: 'Enter the model this backend should use — without one, nothing can run.'
        }
    }
    return null
}

/** The next step id, or null on the last one (where the CTA finishes instead). */
export function nextSetupStep(stepId: SetupWizardStepId): SetupWizardStepId | null {
    return SETUP_WIZARD_STEPS[setupStepIndex(stepId) + 1] ?? null
}

/** The previous step id, or null on the first one (no Back). */
export function previousSetupStep(stepId: SetupWizardStepId): SetupWizardStepId | null {
    const index = setupStepIndex(stepId)
    return index <= 0 ? null : (SETUP_WIZARD_STEPS[index - 1] ?? null)
}

/**
 * Advances the state, or returns it unchanged when the step blocks (callers
 * surface `setupAdvanceBlock`'s message). Returning the same state rather than
 * throwing keeps the caller a one-liner: the wizard's Next handler asks for
 * the block first and only reports it.
 */
export function advanceSetup(state: SetupWizardState): SetupWizardState {
    if (setupAdvanceBlock(state) !== null) {
        return state
    }
    const next = nextSetupStep(state.stepId)
    return next === null ? state : { ...state, stepId: next }
}

/** Steps back; a no-op on the first step. */
export function retreatSetup(state: SetupWizardState): SetupWizardState {
    const previous = previousSetupStep(state.stepId)
    return previous === null ? state : { ...state, stepId: previous }
}

/**
 * What a finished wizard changes. Everything the draft touches, and nothing
 * else — a settings value the wizard never asked about comes out identical.
 *
 * Decisions worth keeping:
 * - A configured backend becomes the GLOBAL DEFAULT when there is none yet.
 *   Editors inherit their backend, so a wizard that added a backend without
 *   wiring it as the default would leave the user with a configured backend
 *   that nothing uses — the exact "it says it's set up but nothing runs" state
 *   the wizard exists to prevent. An existing default is never hijacked: a
 *   re-run must not repoint a working setup.
 * - `onboarded` is set here, so completing the wizard and never seeing it
 *   again are the same fact. (Skipping sets it too — see the modal.)
 * - Editor enablement is applied only to editors the wizard offered.
 */
export function applySetupWizard(
    settings: PluginSettingsV1,
    draft: SetupWizardDraft
): PluginSettingsV1 {
    const choiceById = new Map(draft.editors.map((choice) => [choice.id, choice.enabled]))
    // The validated value, not the draft. `setupAdvanceBlock` normalized a COPY
    // and threw it away, so a pasted base URL kept the whitespace it arrived
    // with — `http://localhost:11434 ` reaches the adapter, which only strips a
    // trailing slash, and `new URL()` then throws on every request from a
    // backend whose settings field looks correct. Validating here means the
    // wizard and the Backends tab persist byte-identical configurations.
    // An invalid backend cannot reach Finish (the step refuses to advance), so
    // treating one as "no backend" is a defensive branch, not a silent drop.
    const validated = draft.backend === null ? null : validateApiBackend(draft.backend)
    const backend = validated !== null && validated.ok ? validated.backend : null
    const backends = backend === null ? settings.backends : [...settings.backends, backend]
    const defaultBackend =
        backend !== null && settings.defaultBackend === null
            ? { backendId: backend.id, model: '' }
            : settings.defaultBackend
    return {
        ...settings,
        backends,
        defaultBackend,
        editors: settings.editors.map((editor) => {
            const enabled = choiceById.get(editor.id)
            return enabled === undefined || enabled === editor.enabled
                ? editor
                : { ...editor, enabled }
        }),
        voiceProfile: {
            ...settings.voiceProfile,
            notePaths: [...draft.voiceNotePaths],
            followLinks: draft.voiceFollowLinks
        },
        behavior: { ...settings.behavior, daemonMode: draft.daemonMode },
        onboarded: true
    }
}

/**
 * What the wizard is about to do, as countable facts (the last step reads
 * them). Deliberately does NOT include "can this actually run a review": that
 * question is answered by `hasReviewCapableEditor` over the APPLIED settings,
 * which knows about disabled backends, dangling references, missing models and
 * per-editor overrides. Re-deriving an approximation of it here is how a
 * "you're all set" screen starts lying.
 */
export interface SetupOutcome {
    readonly backendAdded: boolean
    readonly becameDefaultBackend: boolean
    /**
     * Whether ANY backend would exist afterwards — the one the wizard adds or
     * one that was already configured. A countable fact, not a verdict: it is
     * what lets the summary point at the right tab when nothing will run,
     * instead of inferring the cause from the editor count and blaming the
     * Backends tab for a problem that lives in the Editors tab.
     */
    readonly hasBackend: boolean
    readonly enabledEditorCount: number
    readonly voiceNoteCount: number
    readonly daemonMode: boolean
}

/** Summarizes a draft against the settings it would be applied to. */
export function setupOutcome(settings: PluginSettingsV1, draft: SetupWizardDraft): SetupOutcome {
    const backendAdded = draft.backend !== null
    return {
        backendAdded,
        becameDefaultBackend: backendAdded && settings.defaultBackend === null,
        hasBackend: backendAdded || settings.backends.length > 0,
        enabledEditorCount: draft.editors.filter((choice) => choice.enabled).length,
        voiceNoteCount: draft.voiceNotePaths.length,
        daemonMode: draft.daemonMode
    }
}
