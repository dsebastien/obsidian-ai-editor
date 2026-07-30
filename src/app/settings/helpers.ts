import {
    actionBindingSchema,
    builtInActionIdSchema,
    checkReferentialIntegrity
} from '../domain/settings/settings-schema'
import type {
    ActionTarget,
    ApiProviderKind,
    BackendInstance,
    BackendRef,
    BindingRule,
    BuiltInActionId,
    IntegrityIssue,
    PluginSettingsV1
} from '../domain/settings/settings-schema'

/**
 * Pure helpers behind the settings UI: deletion-impact computation, list
 * reordering, value normalization, and label mapping. No Obsidian imports so
 * everything here is unit-testable under `bun test`.
 */

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

const API_KIND_LABELS: Record<ApiProviderKind, string> = {
    'anthropic': 'Anthropic',
    'openai': 'OpenAI',
    'openrouter': 'OpenRouter',
    'openai-compatible': 'OpenAI-compatible',
    'azure-openai': 'Azure OpenAI',
    'ollama': 'Ollama'
}

/** Display label for an API provider kind. */
export function apiKindLabel(kind: ApiProviderKind): string {
    return API_KIND_LABELS[kind]
}

/** Display label for any backend instance's kind (API or CLI family). */
export function backendKindLabel(backend: BackendInstance): string {
    if (backend.family === 'api') {
        return API_KIND_LABELS[backend.kind]
    }
    return backend.kind === 'claude-code' ? 'Claude Code' : 'Codex'
}

const BUILT_IN_ACTION_LABELS: Record<BuiltInActionId, string> = {
    'rephrase': 'Rephrase',
    'summarize': 'Summarize',
    'critique': 'Critique',
    'say-more': 'Say more',
    'find-evidence': 'Find evidence',
    'identify-assumptions': 'Identify assumptions',
    'simplify': 'Simplify',
    'humanize': 'Humanize',
    'continue': 'Continue'
}

/** Sentence-case display label for a built-in action verb. */
export function builtInActionLabel(id: BuiltInActionId): string {
    return BUILT_IN_ACTION_LABELS[id]
}

/** Whether an action id is one of the built-in verbs (vs a custom UUID). */
export function isBuiltInActionId(actionId: string): actionId is BuiltInActionId {
    return builtInActionIdSchema.safeParse(actionId).success
}

/** Human description of a backend reference for cards and rows. */
export function describeBackendRef(settings: PluginSettingsV1, ref: BackendRef | null): string {
    if (!ref) {
        return 'Inherits the global default backend'
    }
    const backend = settings.backends.find((candidate) => candidate.id === ref.backendId)
    if (!backend) {
        return 'Unknown backend (deleted)'
    }
    return ref.model.length > 0 ? `${backend.label} · ${ref.model}` : backend.label
}

/** One-line summary of a binding rule for list rows. */
export function ruleSummary(settings: PluginSettingsV1, rule: BindingRule): string {
    const match = `${rule.match.matchType} "${rule.match.value}"`
    if (rule.effect === 'disabled') {
        return `${match} → plugin disabled`
    }
    if (!rule.defaultTarget) {
        return `${match} → no target yet`
    }
    if (rule.defaultTarget.targetType === 'editor') {
        const name =
            settings.editors.find((editor) => editor.id === rule.defaultTarget?.targetId)?.name ??
            'unknown editor'
        return `${match} → ${name}`
    }
    const name =
        settings.panels.find((panel) => panel.id === rule.defaultTarget?.targetId)?.name ??
        'unknown panel'
    return `${match} → panel ${name}`
}

// ---------------------------------------------------------------------------
// Action target encoding (dropdown values)
// ---------------------------------------------------------------------------

/** Encodes a target for a `<select>` value: '' | 'editor:<id>' | 'panel:<id>'. */
export function encodeActionTarget(target: ActionTarget | null): string {
    return target ? `${target.targetType}:${target.targetId}` : ''
}

/** Inverse of {@link encodeActionTarget}; malformed values decode to null. */
export function decodeActionTarget(value: string): ActionTarget | null {
    for (const targetType of ['editor', 'panel'] as const) {
        const prefix = `${targetType}:`
        if (value.startsWith(prefix) && value.length > prefix.length) {
            return { targetType, targetId: value.slice(prefix.length) }
        }
    }
    return null
}

// ---------------------------------------------------------------------------
// Deletion impact (referential integrity)
// ---------------------------------------------------------------------------

export type DeletableEntityKind = 'backend' | 'editor' | 'panel'

/** Copy of the settings with one entity removed (references left dangling). */
export function withEntityRemoved(
    settings: PluginSettingsV1,
    kind: DeletableEntityKind,
    id: string
): PluginSettingsV1 {
    if (kind === 'backend') {
        return { ...settings, backends: settings.backends.filter((item) => item.id !== id) }
    }
    if (kind === 'editor') {
        return { ...settings, editors: settings.editors.filter((item) => item.id !== id) }
    }
    return { ...settings, panels: settings.panels.filter((item) => item.id !== id) }
}

const issueKey = (issue: IntegrityIssue): string =>
    `${issue.entity}|${issue.entityId}|${issue.missing}|${issue.missingId}`

/**
 * Integrity issues that deleting the entity would introduce, computed by
 * simulating the removal through {@link checkReferentialIntegrity}.
 * Pre-existing issues are excluded so the dialog only shows new damage.
 */
export function computeDeletionImpact(
    settings: PluginSettingsV1,
    kind: DeletableEntityKind,
    id: string
): IntegrityIssue[] {
    const preexisting = new Set(checkReferentialIntegrity(settings).map(issueKey))
    return checkReferentialIntegrity(withEntityRemoved(settings, kind, id)).filter(
        (issue) => issue.missingId === id && !preexisting.has(issueKey(issue))
    )
}

/**
 * Human-readable impact lines for the delete-confirmation dialog, including
 * cascade effects (a panel emptied by an editor deletion is itself deleted,
 * which unbinds everything pointing at that panel).
 */
export function deletionImpactLines(
    settings: PluginSettingsV1,
    kind: DeletableEntityKind,
    id: string
): string[] {
    const lines: string[] = []
    const push = (line: string): void => {
        if (!lines.includes(line)) {
            lines.push(line)
        }
    }
    for (const issue of computeDeletionImpact(settings, kind, id)) {
        describeIssueInto(settings, issue, push)
    }
    return lines
}

function describeIssueInto(
    settings: PluginSettingsV1,
    issue: IntegrityIssue,
    push: (line: string) => void
): void {
    switch (issue.entity) {
        case 'default-backend':
            push('It is the global default backend; the default will be cleared.')
            return
        case 'editor': {
            const name =
                settings.editors.find((editor) => editor.id === issue.entityId)?.name ??
                'Unknown editor'
            push(`Editor "${name}" will fall back to the global default backend.`)
            return
        }
        case 'panel': {
            const panel = settings.panels.find((candidate) => candidate.id === issue.entityId)
            const name = panel?.name ?? 'Unknown panel'
            if (issue.missing === 'backend') {
                push(`Panel "${name}" will aggregate with the global default backend.`)
                return
            }
            if (panel && panel.memberEditorIds.length <= 1) {
                push(`Panel "${name}" has no other member and will be deleted.`)
                for (const cascade of computeDeletionImpact(settings, 'panel', panel.id)) {
                    describeIssueInto(settings, cascade, push)
                }
                return
            }
            push(`Panel "${name}" will lose this member.`)
            return
        }
        case 'action':
            push(`Action "${actionLabel(settings, issue.entityId)}" will lose its binding.`)
            return
        case 'rule': {
            const rule = settings.rules.find((candidate) => candidate.id === issue.entityId)
            const label = rule
                ? rule.name.length > 0
                    ? rule.name
                    : `${rule.match.matchType}: ${rule.match.value}`
                : 'Unknown rule'
            push(`Rule "${label}" will lose its target and stop assigning anything.`)
            return
        }
        case 'behavior':
            push('It is the default editor for margin comments; that default will be cleared.')
            return
    }
}

function actionLabel(settings: PluginSettingsV1, actionEntityId: string): string {
    const action = settings.actions.find((candidate) => candidate.id === actionEntityId)
    if (!action) {
        return 'Unknown action'
    }
    if (isBuiltInActionId(action.actionId)) {
        return BUILT_IN_ACTION_LABELS[action.actionId]
    }
    return action.customName.length > 0 ? action.customName : 'Custom action'
}

/**
 * Removes an entity and cleans every reference to it so the settings never
 * persist dangling ids. Designed to run inside a facade `update` mutator
 * (mutates in place). Cascades: a panel emptied by an editor deletion is
 * deleted too, and references to that panel are cleared as well.
 */
export function applyEntityDeletion(
    settings: PluginSettingsV1,
    kind: DeletableEntityKind,
    id: string
): void {
    if (kind === 'backend') {
        settings.backends = settings.backends.filter((backend) => backend.id !== id)
        if (settings.defaultBackend?.backendId === id) {
            settings.defaultBackend = null
        }
        for (const editor of settings.editors) {
            if (editor.backend?.backendId === id) {
                editor.backend = null
            }
        }
        for (const panel of settings.panels) {
            if (panel.aggregationBackend?.backendId === id) {
                panel.aggregationBackend = null
            }
        }
        return
    }
    if (kind === 'editor') {
        settings.editors = settings.editors.filter((editor) => editor.id !== id)
        const emptiedPanelIds: string[] = []
        for (const panel of settings.panels) {
            panel.memberEditorIds = panel.memberEditorIds.filter((memberId) => memberId !== id)
            if (panel.memberEditorIds.length === 0) {
                emptiedPanelIds.push(panel.id)
            }
        }
        settings.panels = settings.panels.filter((panel) => !emptiedPanelIds.includes(panel.id))
        clearTargetReferences(settings, 'editor', id)
        for (const panelId of emptiedPanelIds) {
            clearTargetReferences(settings, 'panel', panelId)
        }
        if (settings.behavior.defaultCommentEditorId === id) {
            settings.behavior.defaultCommentEditorId = ''
        }
        return
    }
    settings.panels = settings.panels.filter((panel) => panel.id !== id)
    clearTargetReferences(settings, 'panel', id)
}

function clearTargetReferences(
    settings: PluginSettingsV1,
    targetType: 'editor' | 'panel',
    targetId: string
): void {
    for (const action of settings.actions) {
        if (action.binding?.targetType === targetType && action.binding.targetId === targetId) {
            action.binding = null
        }
    }
    for (const rule of settings.rules) {
        if (
            rule.defaultTarget?.targetType === targetType &&
            rule.defaultTarget.targetId === targetId
        ) {
            rule.defaultTarget = null
        }
    }
}

// ---------------------------------------------------------------------------
// Action bindings
// ---------------------------------------------------------------------------

/**
 * Sets/updates/clears the binding of a built-in verb. Built-in verbs are
 * stored on demand (no entry = unbound) with the verb itself as stable id.
 */
export function setBuiltInActionBinding(
    settings: PluginSettingsV1,
    actionId: BuiltInActionId,
    target: ActionTarget | null
): void {
    if (!target) {
        settings.actions = settings.actions.filter((action) => action.actionId !== actionId)
        return
    }
    const existing = settings.actions.find((action) => action.actionId === actionId)
    if (existing) {
        existing.binding = target
        return
    }
    settings.actions.push(actionBindingSchema.parse({ id: actionId, actionId, binding: target }))
}

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

/** Immutable move of an item within a list; null when the move is a no-op. */
export function moveItem<T>(items: readonly T[], from: number, to: number): T[] | null {
    if (from < 0 || from >= items.length || to < 0 || to >= items.length || from === to) {
        return null
    }
    const next = [...items]
    const moved = next.splice(from, 1)[0]
    if (moved === undefined) {
        return null
    }
    next.splice(to, 0, moved)
    return next
}

/** Parses an integer from user input, clamped to [min, max]; fallback on NaN. */
export function clampInt(raw: string, min: number, max: number, fallback: number): number {
    const parsed = Number.parseInt(raw.trim(), 10)
    if (Number.isNaN(parsed)) {
        return fallback
    }
    return Math.min(max, Math.max(min, parsed))
}

/**
 * Normalizes a chip value: tags lose leading '#', folders lose trailing '/'.
 * Returns '' for values that normalize to nothing (caller should reject).
 */
export function normalizeChipValue(value: string, kind: 'folder' | 'tag'): string {
    let normalized = value.trim()
    if (kind === 'tag') {
        while (normalized.startsWith('#')) {
            normalized = normalized.slice(1)
        }
        return normalized
    }
    while (normalized.length > 1 && normalized.endsWith('/')) {
        normalized = normalized.slice(0, -1)
    }
    return normalized === '/' ? '' : normalized
}

/**
 * True for plain-HTTP endpoints on a remote host: the API key and note
 * content would travel unencrypted. Loopback hosts are fine (Ollama).
 */
export function isInsecureRemoteUrl(url: string): boolean {
    const trimmed = url.trim().toLowerCase()
    if (!trimmed.startsWith('http://')) {
        return false
    }
    const rest = trimmed.slice('http://'.length)
    const hostPort = rest.split('/', 1)[0] ?? ''
    let host: string
    if (hostPort.startsWith('[')) {
        const closing = hostPort.indexOf(']')
        host = closing === -1 ? hostPort.slice(1) : hostPort.slice(1, closing)
    } else {
        host = hostPort.split(':', 1)[0] ?? ''
    }
    return host !== 'localhost' && host !== '127.0.0.1' && host !== '::1' && host !== ''
}
