import { getBuiltInVerb } from '../../domain/actions/verb-registry'
import type { VerbClass } from '../../domain/actions/verb-registry'
import type {
    ActionBinding,
    BehaviorSettings,
    EditorConfig,
    PluginSettingsV1,
    PromptSource
} from '../../domain/settings/settings-schema'
import { isExcluded } from '../context/exclusions'
import type { VaultReader } from '../context/vault-reader.intf'
import { resolveApiBackend } from '../review-service'

/**
 * Action-binding resolution: turns the persisted `settings.actions` entries
 * into dispatchable targets for the editor context menu and the dynamic
 * per-action commands (design doc "Interaction surfaces" §1/§3).
 *
 * One decision point for "can this bound action run right now?" so menus,
 * command gates, and the dispatch glue can never disagree:
 * - Built-in verbs take their label/class/instruction from the verb
 *   registry; custom actions are TRANSFORM-class (they rewrite the
 *   selection with the user's own instruction) and resolve their
 *   instruction from the `customInstruction` prompt source at dispatch
 *   time (`resolveCustomInstruction`).
 * - Editor targets must be enabled, hold the capability the verb class
 *   needs (`review` for review-class verbs, `rewrite` for
 *   transform/generate), and their backend must resolve — mirroring the
 *   participant checks in `startReview`/`startAction` via the same
 *   `resolveApiBackend`.
 * - Panel targets are valid ONLY for review-class verbs (v1 panel dispatch:
 *   the run fans out to EACH member editor with the verb instruction; the
 *   charter/aggregation scorecard is M6). A transform or generate verb
 *   produces exactly one replacement/insertion, so a panel binding is
 *   invalid for it — the settings UI refuses to create one, and resolution
 *   refuses any that predates that rule.
 *
 * An action that cannot dispatch is simply not offered (design rule: no
 * non-functional UI) — `resolveActions` returns only the dispatchable ones.
 */

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

/** One dispatchable bound action. */
export interface ResolvedAction {
    /** The binding entity's id — stable base for the `action-<id>` command. */
    readonly bindingId: string
    /** Built-in verb id, or the custom action's own UUID. */
    readonly actionId: string
    /** Sentence-case display label (menu item, command name, notices). */
    readonly label: string
    readonly verbClass: VerbClass
    readonly kind: 'built-in' | 'custom'
    /**
     * Editors the dispatch targets: exactly one for an editor binding, every
     * member editor for a (review-class) panel binding. Members that cannot
     * dispatch stay in the list — the review pipeline reports them as skips
     * instead of silently shrinking the panel.
     */
    readonly editorIds: readonly string[]
}

export type ActionInvalidReason =
    /** No target bound (the Actions tab's "Not bound"). */
    | 'unbound'
    /** Custom action without a name or without any instruction content. */
    | 'blank-custom'
    /** Transform/generate/custom verb bound to a panel (review-class only). */
    | 'panel-binding-invalid'
    /** The bound editor/panel no longer exists. */
    | 'target-missing'
    /** The bound editor/panel is disabled. */
    | 'target-disabled'
    /** The editor lacks the capability the verb class needs. */
    | 'no-capability'
    /** The editor's backend does not resolve to a usable API backend. */
    | 'backend-unusable'
    /** Panel binding whose members can none of them dispatch. */
    | 'no-dispatchable-member'

export type ActionResolution =
    | { readonly ok: true; readonly action: ResolvedAction }
    | { readonly ok: false; readonly reason: ActionInvalidReason }

/** Human-readable label for an invalid-binding reason (settings tab). */
export function actionInvalidReasonLabel(reason: ActionInvalidReason): string {
    switch (reason) {
        case 'unbound':
            return 'not bound to an editor'
        case 'blank-custom':
            return 'needs a name and an instruction'
        case 'panel-binding-invalid':
            return 'bound to a panel — this action needs a single editor'
        case 'target-missing':
            return 'its editor or panel no longer exists'
        case 'target-disabled':
            return 'its editor or panel is disabled'
        case 'no-capability':
            return 'its editor lacks the needed capability'
        case 'backend-unusable':
            return 'its editor has no usable backend'
        case 'no-dispatchable-member':
            return 'no panel member can run'
    }
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/** Whether an editor can dispatch a verb of the given class right now. */
function editorCanDispatch(
    settings: PluginSettingsV1,
    editor: EditorConfig,
    verbClass: VerbClass
): boolean {
    if (!editor.enabled) {
        return false
    }
    const capability =
        verbClass === 'review' ? editor.capabilities.review : editor.capabilities.rewrite
    return capability && resolveApiBackend(settings, editor).ok
}

/**
 * Resolves one action binding to a dispatchable target, or the typed reason
 * it cannot dispatch. Pure over the settings value — call it fresh wherever
 * staleness matters (menu open, command check, dispatch).
 */
export function resolveActionBinding(
    settings: PluginSettingsV1,
    binding: ActionBinding
): ActionResolution {
    const verb = getBuiltInVerb(binding.actionId)
    const verbClass: VerbClass = verb ? verb.verbClass : 'transform'
    let label: string
    if (verb) {
        label = verb.label
    } else {
        label = binding.customName.trim()
        const hasInstruction =
            binding.customInstruction.text.trim().length > 0 ||
            binding.customInstruction.notePaths.length > 0
        if (label.length === 0 || !hasInstruction) {
            return { ok: false, reason: 'blank-custom' }
        }
    }
    const target = binding.binding
    if (!target) {
        return { ok: false, reason: 'unbound' }
    }

    const resolved = (editorIds: readonly string[]): ActionResolution => ({
        ok: true,
        action: {
            bindingId: binding.id,
            actionId: binding.actionId,
            label,
            verbClass,
            kind: verb ? 'built-in' : 'custom',
            editorIds
        }
    })

    if (target.targetType === 'panel') {
        if (verbClass !== 'review') {
            return { ok: false, reason: 'panel-binding-invalid' }
        }
        const panel = settings.panels.find((candidate) => candidate.id === target.targetId)
        if (!panel) {
            return { ok: false, reason: 'target-missing' }
        }
        if (!panel.enabled) {
            return { ok: false, reason: 'target-disabled' }
        }
        const anyMember = panel.memberEditorIds.some((memberId) => {
            const member = settings.editors.find((editor) => editor.id === memberId)
            return member !== undefined && editorCanDispatch(settings, member, verbClass)
        })
        if (!anyMember) {
            return { ok: false, reason: 'no-dispatchable-member' }
        }
        return resolved(panel.memberEditorIds)
    }

    const editor = settings.editors.find((candidate) => candidate.id === target.targetId)
    if (!editor) {
        return { ok: false, reason: 'target-missing' }
    }
    if (!editor.enabled) {
        return { ok: false, reason: 'target-disabled' }
    }
    const capability =
        verbClass === 'review' ? editor.capabilities.review : editor.capabilities.rewrite
    if (!capability) {
        return { ok: false, reason: 'no-capability' }
    }
    if (!resolveApiBackend(settings, editor).ok) {
        return { ok: false, reason: 'backend-unusable' }
    }
    return resolved([editor.id])
}

/**
 * Every dispatchable bound action, in `settings.actions` order. Menus and
 * the dynamic command registration derive their state from exactly this
 * list, so an action that cannot dispatch never becomes UI.
 */
export function resolveActions(settings: PluginSettingsV1): ResolvedAction[] {
    const actions: ResolvedAction[] = []
    for (const binding of settings.actions) {
        const resolution = resolveActionBinding(settings, binding)
        if (resolution.ok) {
            actions.push(resolution.action)
        }
    }
    return actions
}

/** Resolves a single binding entity by id; null when absent/undispatchable. */
export function resolveActionById(
    settings: PluginSettingsV1,
    bindingId: string
): ResolvedAction | null {
    const binding = settings.actions.find((candidate) => candidate.id === bindingId)
    if (!binding) {
        return null
    }
    const resolution = resolveActionBinding(settings, binding)
    return resolution.ok ? resolution.action : null
}

// ---------------------------------------------------------------------------
// Custom instruction resolution (Business Rules #8 — vault as configuration)
// ---------------------------------------------------------------------------

/**
 * The operation contract caps the instruction payload (`SHORT_TEXT_MAX` in
 * `operations/contract.ts`); referenced notes are truncated to fit.
 */
export const CUSTOM_INSTRUCTION_MAX_CHARS = 10_000

/**
 * Resolves a custom action's instruction prompt source to the instruction
 * string the transform operation carries: the direct text first, then each
 * referenced note inlined as a delimited block, resolved fresh at dispatch
 * time (Business Rules #8). Excluded notes are never read (Business Rules
 * #7); missing notes are skipped silently; duplicates are inlined once. The
 * result is truncated to `CUSTOM_INSTRUCTION_MAX_CHARS` (the operation
 * contract's instruction cap). `followLinks` is not expanded here — the
 * custom-instruction UI does not offer it, and an instruction is a directive,
 * not context.
 */
export async function resolveCustomInstruction(
    source: PromptSource,
    vault: VaultReader,
    behavior: BehaviorSettings
): Promise<string> {
    const segments: string[] = []
    const text = source.text.trim()
    if (text.length > 0) {
        segments.push(text)
    }
    const seen = new Set<string>()
    for (const path of source.notePaths) {
        if (seen.has(path)) {
            continue
        }
        seen.add(path)
        if (isExcluded(path, vault.getNoteMetadata(path), behavior)) {
            continue
        }
        const content = await vault.readNote(path)
        if (content === null) {
            continue
        }
        const safePath = path.replace(/"/g, "'")
        segments.push(`<instruction-note path="${safePath}">\n${content}\n</instruction-note>`)
    }
    const joined = segments.join('\n\n')
    return joined.length > CUSTOM_INSTRUCTION_MAX_CHARS
        ? joined.slice(0, CUSTOM_INSTRUCTION_MAX_CHARS)
        : joined
}
