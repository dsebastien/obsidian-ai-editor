import type { z } from 'zod'
import { generateId } from '../ids'
import {
    SETTINGS_SCHEMA_VERSION,
    actionBindingSchema,
    backendInstanceSchema,
    bindingRuleSchema,
    builtInActionIdSchema,
    editorConfigSchema,
    panelConfigSchema,
    promptSourceSchema
} from './settings-schema'
import type {
    ActionBinding,
    ActionTarget,
    BackendInstance,
    BackendRef,
    BindingRule,
    EditorConfig,
    PanelConfig,
    PluginSettingsV1,
    PromptSource
} from './settings-schema'

/**
 * Settings transfer: export a chosen subset of the configuration to a JSON
 * document, and import one back with validation, id regeneration, and a plan
 * the user confirms before anything is written (plan M5).
 *
 * Three rules this module exists to enforce:
 *
 * 1. **API keys never leave the vault.** Exported API backends carry an empty
 *    `apiKey`, and an import clears it too — even when the file being imported
 *    has one (a hand-written file, or a copied `data.json`). Both directions
 *    matter: a shared export must not leak a key, and importing someone else's
 *    file must not silently start billing their account. The only other field
 *    that could carry a secret is the advanced `extraBodyJson` escape hatch;
 *    it travels as-is because it is functional request configuration, and
 *    blanking it would break the backend it configures.
 * 2. **Imports add, they never overwrite.** Every imported entity gets a fresh
 *    id, so importing a file twice produces two independent sets instead of
 *    half-merging them onto whatever happened to share an id. References
 *    INSIDE the import are remapped to the new ids; a reference to something
 *    outside it is kept only when that id exists in the current settings
 *    (the re-import case: importing panels back into the vault their member
 *    editors still live in), and otherwise cleared with an adjustment note.
 *    `voiceProfile` is the one exception — a single value cannot be "added",
 *    so it replaces, and the confirmation says so.
 * 3. **Nothing is silent.** Every entity that could not be kept is a typed
 *    rejection, and every reference that had to be cleared is a typed
 *    adjustment. The caller shows both, with the counts, and only then commits
 *    `applyImportPlan`.
 */

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

/** The settings sections a user can transfer, in export/summary order. */
export const TRANSFER_SECTIONS = [
    'backends',
    'editors',
    'panels',
    'actions',
    'rules',
    'voiceProfile'
] as const
export type TransferSection = (typeof TRANSFER_SECTIONS)[number]

/** Which sections a transfer covers (export selection). */
export type TransferSelection = Readonly<Record<TransferSection, boolean>>

/** Everything selected — the default an export dialog opens with. */
export const ALL_SECTIONS: TransferSelection = {
    backends: true,
    editors: true,
    panels: true,
    actions: true,
    rules: true,
    voiceProfile: true
}

const SECTION_LABELS: Record<TransferSection, { one: string; many: string }> = {
    backends: { one: 'backend', many: 'backends' },
    editors: { one: 'editor', many: 'editors' },
    panels: { one: 'panel', many: 'panels' },
    actions: { one: 'action', many: 'actions' },
    rules: { one: 'rule', many: 'rules' },
    voiceProfile: { one: 'voice profile', many: 'voice profile' }
}

/** "3 editors" / "1 panel" — the vocabulary of every transfer summary. */
export function sectionCountLabel(section: TransferSection, count: number): string {
    const labels = SECTION_LABELS[section]
    return `${count} ${count === 1 ? labels.one : labels.many}`
}

/**
 * Per-section entity caps, mirroring `pluginSettingsSchema`. Enforced during
 * planning rather than at save time: the facade rejects a schema-invalid
 * update wholesale, so an oversized import would fail with "could not save"
 * instead of telling the user which entities did not fit. A spec pins these
 * numbers against the schema itself.
 */
const SECTION_MAX: Record<Exclude<TransferSection, 'voiceProfile'>, number> = {
    backends: 50,
    editors: 200,
    panels: 50,
    actions: 200,
    rules: 200
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

/** Marker written into every export so a file can identify itself. */
export const EXPORT_FORMAT = 'ai-editor-settings'

/**
 * The exported document. Unselected sections are ABSENT rather than empty:
 * "I did not export editors" and "I exported zero editors" import the same
 * way, and absence makes the file say what it is at a glance.
 */
export interface SettingsExportDocument {
    readonly format: typeof EXPORT_FORMAT
    readonly schemaVersion: number
    readonly backends?: readonly BackendInstance[]
    readonly editors?: readonly EditorConfig[]
    readonly panels?: readonly PanelConfig[]
    readonly actions?: readonly ActionBinding[]
    readonly rules?: readonly BindingRule[]
    readonly voiceProfile?: PromptSource
}

/**
 * Builds the export document for the selected sections. API keys are stripped
 * here, at the only place that produces an export, so no caller can forget.
 */
export function exportSettings(
    settings: PluginSettingsV1,
    selection: TransferSelection
): SettingsExportDocument {
    return {
        format: EXPORT_FORMAT,
        schemaVersion: SETTINGS_SCHEMA_VERSION,
        ...(selection.backends ? { backends: settings.backends.map(withoutApiKey) } : {}),
        ...(selection.editors ? { editors: settings.editors } : {}),
        ...(selection.panels ? { panels: settings.panels } : {}),
        ...(selection.actions ? { actions: settings.actions } : {}),
        ...(selection.rules ? { rules: settings.rules } : {}),
        ...(selection.voiceProfile ? { voiceProfile: settings.voiceProfile } : {})
    }
}

/** Serialized export, ready to write to a file or the clipboard. */
export function exportSettingsJson(
    settings: PluginSettingsV1,
    selection: TransferSelection
): string {
    return `${JSON.stringify(exportSettings(settings, selection), null, 2)}\n`
}

function withoutApiKey(backend: BackendInstance): BackendInstance {
    return backend.family === 'api' ? { ...backend, apiKey: '' } : backend
}

/** How many entities each selected section contributes, in section order. */
export function exportCounts(
    settings: PluginSettingsV1,
    selection: TransferSelection
): readonly { readonly section: TransferSection; readonly count: number }[] {
    const counts: { section: TransferSection; count: number }[] = []
    for (const section of TRANSFER_SECTIONS) {
        if (!selection[section]) {
            continue
        }
        counts.push({
            section,
            count: section === 'voiceProfile' ? 1 : settings[section].length
        })
    }
    return counts
}

// ---------------------------------------------------------------------------
// Import: result types
// ---------------------------------------------------------------------------

export type ImportRejectReason =
    /** Failed its own schema — a hand-edited or foreign entity. */
    | 'invalid'
    /** A panel none of whose member editors exist here or in the import. */
    | 'no-member-editor'
    /** A built-in verb binding when that verb is already bound here. */
    | 'already-bound'
    /** The section is at its maximum size; later entities do not fit. */
    | 'section-full'

export interface ImportRejection {
    readonly section: TransferSection
    /** Index within the imported section, for "editors[2]"-style reporting. */
    readonly index: number
    /** Best-effort name read from the raw entity ('' when unreadable). */
    readonly label: string
    readonly reason: ImportRejectReason
}

export type ImportAdjustment =
    /** An API key was dropped; the backend needs one re-entered to run. */
    | { readonly kind: 'api-key-cleared'; readonly label: string }
    /** A backend reference pointed outside the import: inherit the default. */
    | { readonly kind: 'backend-cleared'; readonly label: string }
    /** An action/rule target pointed outside the import: left unbound. */
    | { readonly kind: 'target-cleared'; readonly label: string }
    /** A panel lost members that exist neither here nor in the import. */
    | { readonly kind: 'members-dropped'; readonly label: string; readonly count: number }
    /** The imported voice profile replaces the configured one. */
    | { readonly kind: 'voice-profile-replaced' }

export interface SettingsImportPlan {
    /** Entities to append, already id-regenerated and cross-remapped. */
    readonly additions: {
        readonly backends: readonly BackendInstance[]
        readonly editors: readonly EditorConfig[]
        readonly panels: readonly PanelConfig[]
        readonly actions: readonly ActionBinding[]
        readonly rules: readonly BindingRule[]
    }
    /** Non-null when the import carries a voice profile (it REPLACES). */
    readonly voiceProfile: PromptSource | null
    /** What will be added, in section order; only non-empty sections. */
    readonly counts: readonly { readonly section: TransferSection; readonly count: number }[]
    readonly rejected: readonly ImportRejection[]
    readonly adjustments: readonly ImportAdjustment[]
}

export type SettingsImport =
    | { readonly ok: true; readonly plan: SettingsImportPlan }
    | { readonly ok: false; readonly error: ImportError }

export type ImportError =
    /** Not parseable as JSON at all. */
    | 'not-json'
    /** Valid JSON, but not an object (an array, a number, null…). */
    | 'not-an-object'
    /** An object without a single recognizable settings section. */
    | 'no-sections'

/** Whether a plan would change anything if applied. */
export function importPlanIsEmpty(plan: SettingsImportPlan): boolean {
    return plan.counts.length === 0 && plan.voiceProfile === null
}

// ---------------------------------------------------------------------------
// Import: planning
// ---------------------------------------------------------------------------

/** `planImport` over raw file/clipboard text. */
export function planImportFromJson(
    text: string,
    current: PluginSettingsV1,
    generate: () => string = generateId
): SettingsImport {
    let raw: unknown
    try {
        raw = JSON.parse(text)
    } catch {
        return { ok: false, error: 'not-json' }
    }
    return planImport(raw, current, generate)
}

/**
 * Validates an import document against the settings schemas with per-entity
 * salvage and returns the plan: what would be added (with fresh ids and
 * remapped references), what was rejected, what had to be adjusted.
 *
 * The `format` marker is NOT required — a plugin `data.json` copied from
 * another vault is a legitimate import source, and it has no marker. Any
 * object carrying at least one recognizable section is accepted; an object
 * carrying none is the error, because that is the case where the user picked
 * the wrong file.
 *
 * Pure: `generate` is injected so specs can pin the remapping, and nothing is
 * written — `applyImportPlan` does that, after the user confirms.
 */
export function planImport(
    raw: unknown,
    current: PluginSettingsV1,
    generate: () => string = generateId
): SettingsImport {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
        return { ok: false, error: 'not-an-object' }
    }
    const source = raw as Record<string, unknown>
    if (!TRANSFER_SECTIONS.some((section) => source[section] !== undefined)) {
        return { ok: false, error: 'no-sections' }
    }

    const rejected: ImportRejection[] = []
    const adjustments: ImportAdjustment[] = []

    // -- Salvage each section element by element ------------------------------
    const backends = salvage('backends', source, backendInstanceSchema, rejected)
    const editors = salvage('editors', source, editorConfigSchema, rejected)
    const panels = salvage('panels', source, panelConfigSchema, rejected)
    const actions = salvage('actions', source, actionBindingSchema, rejected)
    const rules = salvage('rules', source, bindingRuleSchema, rejected)

    // -- Fresh ids, and the maps every reference is rewritten through ---------
    const taken = new Set<string>([
        ...current.backends.map((entity) => entity.id),
        ...current.editors.map((entity) => entity.id),
        ...current.panels.map((entity) => entity.id),
        ...current.actions.map((entity) => entity.id),
        ...current.rules.map((entity) => entity.id)
    ])
    const freshId = (preferred?: string): string => {
        if (preferred !== undefined && preferred.length > 0 && !taken.has(preferred)) {
            taken.add(preferred)
            return preferred
        }
        let next = generate()
        while (taken.has(next)) {
            next = generate()
        }
        taken.add(next)
        return next
    }
    const backendIds = new Map<string, string>()
    const editorIds = new Map<string, string>()
    const panelIds = new Map<string, string>()

    const newBackends = backends.map((backend) => {
        const id = freshId()
        backendIds.set(backend.id, id)
        if (backend.family === 'api' && backend.apiKey.length > 0) {
            adjustments.push({ kind: 'api-key-cleared', label: backend.label })
        }
        return { ...withoutApiKey(backend), id }
    })
    const newEditors = editors.map((editor) => {
        const id = freshId()
        editorIds.set(editor.id, id)
        return { ...editor, id }
    })

    /** A reference id after remapping: mapped, kept if it exists here, else null. */
    const remap = (
        map: ReadonlyMap<string, string>,
        existing: ReadonlySet<string>,
        id: string
    ): string | null => map.get(id) ?? (existing.has(id) ? id : null)

    const currentBackendIds = new Set(current.backends.map((entity) => entity.id))
    const currentEditorIds = new Set(current.editors.map((entity) => entity.id))
    const currentPanelIds = new Set(current.panels.map((entity) => entity.id))

    const remapBackendRef = (ref: BackendRef | null, label: string): BackendRef | null => {
        if (!ref) {
            return null
        }
        const backendId = remap(backendIds, currentBackendIds, ref.backendId)
        if (backendId === null) {
            adjustments.push({ kind: 'backend-cleared', label })
            return null
        }
        return { ...ref, backendId }
    }

    const remappedEditors: EditorConfig[] = newEditors.map((editor) => ({
        ...editor,
        backend: remapBackendRef(editor.backend, editor.name)
    }))

    const remappedPanels: PanelConfig[] = []
    panels.forEach((panel, index) => {
        const members = panel.memberEditorIds
            .map((memberId) => remap(editorIds, currentEditorIds, memberId))
            .filter((memberId): memberId is string => memberId !== null)
        const dropped = panel.memberEditorIds.length - members.length
        if (members.length === 0) {
            // The schema requires at least one member, and a panel with none
            // is not a panel — reject rather than invent a member.
            rejected.push({
                section: 'panels',
                index,
                label: panel.name,
                reason: 'no-member-editor'
            })
            return
        }
        if (dropped > 0) {
            adjustments.push({ kind: 'members-dropped', label: panel.name, count: dropped })
        }
        const id = freshId()
        panelIds.set(panel.id, id)
        remappedPanels.push({
            ...panel,
            id,
            memberEditorIds: members,
            aggregationBackend: remapBackendRef(panel.aggregationBackend, panel.name)
        })
    })

    const remapTarget = (target: ActionTarget | null, label: string): ActionTarget | null => {
        if (!target) {
            return null
        }
        const targetId =
            target.targetType === 'editor'
                ? remap(editorIds, currentEditorIds, target.targetId)
                : remap(panelIds, currentPanelIds, target.targetId)
        if (targetId === null) {
            adjustments.push({ kind: 'target-cleared', label })
            return null
        }
        return { ...target, targetId }
    }

    const boundBuiltIns = new Set(
        current.actions
            .filter((action) => builtInActionIdSchema.safeParse(action.actionId).success)
            .map((action) => action.actionId)
    )
    const remappedActions: ActionBinding[] = []
    actions.forEach((action, index) => {
        const builtIn = builtInActionIdSchema.safeParse(action.actionId).success
        const label = builtIn ? action.actionId : action.customName
        if (builtIn && boundBuiltIns.has(action.actionId)) {
            // Two bindings for one verb would give the verb two menu entries
            // and make every lookup depend on array order.
            rejected.push({ section: 'actions', index, label, reason: 'already-bound' })
            return
        }
        if (builtIn) {
            boundBuiltIns.add(action.actionId)
        }
        // A built-in binding keeps the verb as its entity id (the convention
        // `setBuiltInActionBinding` writes); a custom action's id IS its
        // action id, so both halves get the same fresh value.
        const id = builtIn ? freshId(action.actionId) : freshId()
        remappedActions.push({
            ...action,
            id,
            actionId: builtIn ? action.actionId : id,
            binding: remapTarget(action.binding, label)
        })
    })

    const remappedRules: BindingRule[] = rules.map((rule) => {
        const label =
            rule.name.length > 0 ? rule.name : `${rule.match.matchType}: ${rule.match.value}`
        return {
            ...rule,
            id: freshId(),
            defaultTarget: remapTarget(rule.defaultTarget, label)
        }
    })

    // -- Section caps: report what does not fit instead of failing the save ---
    const additions = {
        backends: capSection('backends', newBackends, current.backends.length, rejected),
        editors: capSection('editors', remappedEditors, current.editors.length, rejected),
        panels: capSection('panels', remappedPanels, current.panels.length, rejected),
        actions: capSection('actions', remappedActions, current.actions.length, rejected),
        rules: capSection('rules', remappedRules, current.rules.length, rejected)
    }

    // -- Voice profile: a single value, so it replaces ------------------------
    let voiceProfile: PromptSource | null = null
    if (source['voiceProfile'] !== undefined) {
        const parsed = promptSourceSchema.safeParse(source['voiceProfile'])
        if (parsed.success) {
            voiceProfile = parsed.data
            adjustments.push({ kind: 'voice-profile-replaced' })
        } else {
            rejected.push({
                section: 'voiceProfile',
                index: 0,
                label: '',
                reason: 'invalid'
            })
        }
    }

    const counts: { section: TransferSection; count: number }[] = []
    for (const section of TRANSFER_SECTIONS) {
        const count =
            section === 'voiceProfile' ? (voiceProfile === null ? 0 : 1) : additions[section].length
        if (count > 0) {
            counts.push({ section, count })
        }
    }

    return {
        ok: true,
        plan: { additions, voiceProfile, counts, rejected, adjustments }
    }
}

/** Parses one section's elements individually; failures become rejections. */
function salvage<T>(
    section: Exclude<TransferSection, 'voiceProfile'>,
    source: Record<string, unknown>,
    schema: z.ZodType<T>,
    rejected: ImportRejection[]
): T[] {
    const raw = source[section]
    if (raw === undefined) {
        return []
    }
    if (!Array.isArray(raw)) {
        rejected.push({ section, index: 0, label: '', reason: 'invalid' })
        return []
    }
    const kept: T[] = []
    raw.forEach((element, index) => {
        const parsed = schema.safeParse(element)
        if (parsed.success) {
            kept.push(parsed.data)
            return
        }
        rejected.push({ section, index, label: rawLabel(element), reason: 'invalid' })
    })
    return kept
}

/** Best-effort display name for an entity that failed validation. */
function rawLabel(element: unknown): string {
    if (typeof element !== 'object' || element === null) {
        return ''
    }
    const record = element as Record<string, unknown>
    for (const key of ['name', 'label', 'customName', 'actionId', 'id']) {
        const value = record[key]
        if (typeof value === 'string' && value.length > 0) {
            return value
        }
    }
    return ''
}

/** Trims a section to its schema maximum, rejecting the overflow. */
function capSection<T extends { readonly id: string }>(
    section: Exclude<TransferSection, 'voiceProfile'>,
    entities: readonly T[],
    existingCount: number,
    rejected: ImportRejection[]
): T[] {
    const room = Math.max(0, SECTION_MAX[section] - existingCount)
    if (entities.length <= room) {
        return [...entities]
    }
    entities.slice(room).forEach((entity, offset) => {
        rejected.push({
            section,
            index: room + offset,
            label: entityLabel(entity),
            reason: 'section-full'
        })
    })
    return entities.slice(0, room)
}

function entityLabel(entity: { readonly id: string }): string {
    const record = entity as unknown as Record<string, unknown>
    for (const key of ['name', 'label', 'customName', 'actionId']) {
        const value = record[key]
        if (typeof value === 'string' && value.length > 0) {
            return value
        }
    }
    return entity.id
}

// ---------------------------------------------------------------------------
// Import: application
// ---------------------------------------------------------------------------

/**
 * Applies a confirmed plan. Designed to run inside a facade `update` mutator
 * (mutates the draft in place). Append-only, except `voiceProfile`, which the
 * plan states explicitly and the confirmation announces.
 */
export function applyImportPlan(settings: PluginSettingsV1, plan: SettingsImportPlan): void {
    settings.backends = [...settings.backends, ...plan.additions.backends]
    settings.editors = [...settings.editors, ...plan.additions.editors]
    settings.panels = [...settings.panels, ...plan.additions.panels]
    settings.actions = [...settings.actions, ...plan.additions.actions]
    settings.rules = [...settings.rules, ...plan.additions.rules]
    if (plan.voiceProfile !== null) {
        settings.voiceProfile = plan.voiceProfile
    }
}
