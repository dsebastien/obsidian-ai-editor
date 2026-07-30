import type { VerbClass } from '../domain/actions/verb-registry'
import { resolveRuleEditorPool } from '../domain/rules/rule-engine'
import type { RuleOutcome } from '../domain/rules/rule-engine'
import type {
    EditorConfig,
    PanelConfig,
    PluginSettingsV1
} from '../domain/settings/settings-schema'
import { resolveActionById, resolveBoundActionVerb } from './actions/action-resolution'
import { ExcludedTargetError } from './context/context-assembler'
import type { ContextBudgetReport, ContextSection } from './context/context-budget'
import { isExcluded } from './context/exclusions'
import type { VaultReader } from './context/vault-reader.intf'
import { resolvePanelCharter } from './panels/panel-charter'
import { buildEditorPrompt, resolveApiBackend } from './review-service'
import type { SkipReason } from './review-service'
import { noteRuleOutcome } from './rules/note-rules'

/**
 * "What will be sent" — the plugin's trust surface (plan M5, review major
 * #8/#14).
 *
 * This resolves the SAME prompt a dispatch would, through the SAME
 * `buildEditorPrompt`, and returns it with the budget report for display. It
 * sends nothing and touches no run: the only network-adjacent thing here is
 * the absence of a request.
 *
 * Honesty rules this module exists to keep:
 * - Nothing is re-derived. The system prompt shown IS the string a run hands
 *   the provider adapter, byte for byte — including the instruction a bound
 *   action appends, resolved through the same `resolveBoundActionVerb` the
 *   dispatch uses.
 * - An action's instruction is accounted, not hidden. A custom action inlines
 *   its referenced vault notes into the instruction (up to
 *   `CUSTOM_INSTRUCTION_MAX_CHARS`), which is vault content leaving the vault:
 *   a preview that omitted it would understate the request by up to 10 000
 *   characters. Review-class instructions ride the system prompt; transform and
 *   generate instructions ride the operation payload, and the preview says
 *   which, because "it is in the prompt" and "it is in the request" are
 *   different answers.
 * - Refusals are shown, not hidden. A privacy-excluded note (Business Rules
 *   #7) and a note a binding rule switches off (plan §4b) return their own
 *   status, because "nothing would be sent" is the most important thing a
 *   preview can say and the two have different fixes.
 * - The backend is named when it resolves and the blocking reason when it does
 *   not: a prompt the user approves but that no backend can carry is still a
 *   run that will not happen.
 */

/** The instruction a bound action adds to the request, when one is previewed. */
export interface PreviewInstruction {
    /** The action's display label. */
    readonly label: string
    readonly verbClass: VerbClass
    /** The resolved instruction, referenced notes already inlined. */
    readonly text: string
    /**
     * Whether it is part of `systemPrompt` (review-class verbs augment the
     * prompt) or travels in the operation payload (transform / generate).
     */
    readonly inSystemPrompt: boolean
}

/** The panel brief this run would carry, when the editor runs as a member. */
export interface PreviewPanelCharter {
    readonly panelName: string
    /** Resolved charter text, referenced notes already inlined. */
    readonly text: string
}

export interface ContextPreview {
    readonly editorId: string
    readonly editorName: string
    readonly notePath: string
    /** Null when previewing a plain review (no bound action selected). */
    readonly instruction: PreviewInstruction | null
    /**
     * The panel charter appended to the system prompt, or `null` for a solo
     * run. Resolved exactly as the dispatch resolves it — a charter inlines
     * whole vault notes, so a preview that omitted it would under-report what
     * leaves the vault by up to `PANEL_CHARTER_MAX_CHARS`.
     */
    readonly panelCharter: PreviewPanelCharter | null
    /** Exactly what the backend receives as its system prompt. */
    readonly systemPrompt: string
    /** Every accounted section, in send order (dropped ones included). */
    readonly sections: readonly ContextSection[]
    readonly budget: ContextBudgetReport
    /**
     * `<label> (<model>)` for the backend this editor would run on, or `null`
     * when it cannot run — `backendIssue` then says why.
     */
    readonly backendLabel: string | null
    readonly backendIssue: SkipReason | null
}

export type ContextPreviewResult =
    | { readonly status: 'ready'; readonly preview: ContextPreview }
    /** Business Rules #7 — nothing about this note ever leaves the vault. */
    | { readonly status: 'excluded'; readonly notePath: string }
    /** Plan §4b kill switch — AI Editor does not operate on this note. */
    | {
          readonly status: 'rule-disabled'
          readonly notePath: string
          readonly ruleLabel: string
      }
    /** The note is gone or unreadable; there is no text to preview against. */
    | { readonly status: 'note-unreadable'; readonly notePath: string }
    /**
     * The selected action no longer resolves — deleted, class cleared, or every
     * note its instruction references missing or excluded. The dispatch refuses
     * in exactly those cases, so the preview refuses too rather than showing a
     * request that would never go out.
     */
    | { readonly status: 'action-unavailable'; readonly label: string }
    /**
     * The editor was deleted while the preview was open. `previewEditorContext`
     * never returns this — it takes an editor VALUE — but the modal's resolver
     * looks the editor up per render so it always shows the CURRENT persona,
     * and that lookup can come back empty.
     */
    | { readonly status: 'editor-missing' }

export interface PreviewContextInput {
    /**
     * The editor to preview. Passed as a VALUE, not an id, so the editor
     * settings dialog can preview its unsaved DRAFT — previewing the persona
     * you are currently writing is the point of the button there.
     */
    readonly editor: EditorConfig
    readonly settings: PluginSettingsV1
    readonly vault: VaultReader
    readonly notePath: string
    /**
     * The note's text. Callers with a live editor buffer pass it (unsaved
     * edits are what a run would send); callers without one pass `undefined`
     * and the vault state is read here.
     */
    readonly noteText?: string
    /**
     * Binding id of a bound action to preview alongside the note, or undefined
     * for a plain review. Resolved here — not passed as text — so the preview
     * runs the same resolution the dispatch runs.
     */
    readonly actionBindingId?: string
}

/**
 * Builds the preview for one editor against one note. Never throws for the
 * expected refusals — they are statuses.
 */
export async function previewEditorContext(
    input: PreviewContextInput
): Promise<ContextPreviewResult> {
    const { editor, settings, vault, notePath } = input

    // Same order as every dispatch path: exclusion, then the kill switch.
    if (isExcluded(notePath, vault.getNoteMetadata(notePath), settings.behavior)) {
        return { status: 'excluded', notePath }
    }
    const ruleOutcome = noteRuleOutcome(notePath, vault, settings)
    if (ruleOutcome.kind === 'disabled') {
        return { status: 'rule-disabled', notePath, ruleLabel: ruleOutcome.ruleLabel }
    }

    const noteText = input.noteText ?? (await vault.readNote(notePath))
    if (noteText === null) {
        return { status: 'note-unreadable', notePath }
    }

    let instruction: PreviewInstruction | null = null
    let requestedPanelId: string | null = null
    if (input.actionBindingId !== undefined) {
        const resolved = resolveActionById(settings, input.actionBindingId)
        const verb =
            resolved === null ? null : await resolveBoundActionVerb(settings, vault, resolved)
        if (resolved === null || verb === null) {
            return { status: 'action-unavailable', label: resolved?.label ?? 'This action' }
        }
        requestedPanelId = resolved.panelId
        instruction = {
            label: verb.label,
            verbClass: verb.verbClass,
            text: verb.instruction,
            inSystemPrompt: verb.verbClass === 'review'
        }
    }

    // Same precedence as `startReview` → `resolveReviewParticipants`: the
    // action's own panel, else the panel a binding rule assigns.
    const panel = previewPanel(settings, ruleOutcome, requestedPanelId)
    const panelCharter: PreviewPanelCharter | null = panel
        ? {
              panelName: panel.name,
              text: await resolvePanelCharter(panel, vault, settings.behavior)
          }
        : null

    let built
    try {
        built = await buildEditorPrompt({
            editor,
            settings,
            vault,
            notePath,
            noteText,
            // Mirrors the dispatch split: a review-class verb's instruction is
            // appended to the system prompt (`RunInstruction` → `startReview`),
            // a transform/generate verb's rides the operation payload.
            instructionText:
                instruction !== null && instruction.inSystemPrompt ? instruction.text : undefined,
            ...(panelCharter === null
                ? {}
                : {
                      panelCharter: {
                          panelName: panelCharter.panelName,
                          text: panelCharter.text
                      }
                  })
        })
    } catch (cause) {
        // Defense in depth: the upfront check already covered the target.
        if (cause instanceof ExcludedTargetError) {
            return { status: 'excluded', notePath: cause.notePath }
        }
        throw cause
    }

    const resolution = resolveApiBackend(settings, editor)
    return {
        status: 'ready',
        preview: {
            editorId: editor.id,
            editorName: editor.name,
            notePath,
            instruction,
            panelCharter,
            systemPrompt: built.systemPrompt,
            sections: built.context.sections,
            budget: built.context.budget,
            backendLabel: resolution.ok
                ? `${resolution.backend.label} (${resolution.model})`
                : null,
            backendIssue: resolution.ok ? null : resolution.reason
        }
    }
}

/**
 * The panel whose charter this preview must account for: an explicitly
 * requested one (a panel-bound action carries `panelId`) first, else the panel
 * a binding rule assigns to this note. Same precedence — and the same
 * enabled/exists checks — as the dispatch path, because the preview's whole
 * job is to be the dispatch minus the request.
 */
function previewPanel(
    settings: PluginSettingsV1,
    ruleOutcome: RuleOutcome,
    requestedPanelId: string | null
): PanelConfig | null {
    const panelId =
        requestedPanelId ??
        ((): string | null => {
            const pool = resolveRuleEditorPool(settings, ruleOutcome)
            return pool.kind === 'editors' ? pool.panelId : null
        })()
    if (panelId === null) {
        return null
    }
    const panel = settings.panels.find((candidate) => candidate.id === panelId)
    return panel && panel.enabled ? panel : null
}
