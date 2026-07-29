import { z } from 'zod'

/**
 * Persisted plugin settings: schema-versioned, Zod-validated on load.
 *
 * Rules (see Business Rules + review majors #24/#26):
 * - Every entity has a stable UUID; cross-references use IDs, never names.
 * - Unknown/invalid persisted data must never crash the plugin: `loadSettings`
 *   falls back to defaults per-section rather than discarding everything.
 * - API keys live inside `data.json` — documented prominently in README and
 *   the Backends tab; never logged.
 */

export const SETTINGS_SCHEMA_VERSION = 1

// ---------------------------------------------------------------------------
// Prompt sources: direct text and/or ordered vault note references
// ---------------------------------------------------------------------------

export const promptSourceSchema = z.object({
    text: z.string().max(100_000).default(''),
    /** Vault-relative note paths, resolved fresh at run time, in order. */
    notePaths: z.array(z.string().max(1_000)).max(50).default([])
})
export type PromptSource = z.infer<typeof promptSourceSchema>

// ---------------------------------------------------------------------------
// Backend instances (1-n configured providers / CLI agents)
// ---------------------------------------------------------------------------

export const apiProviderKindSchema = z.enum([
    'anthropic',
    'openai',
    'openai-compatible',
    'azure-openai',
    'ollama'
])
export type ApiProviderKind = z.infer<typeof apiProviderKindSchema>

export const apiBackendSchema = z.object({
    id: z.string().min(1),
    family: z.literal('api'),
    kind: apiProviderKindSchema,
    /** User-facing label ("Work OpenRouter", "Local Ollama"). */
    label: z.string().min(1).max(100),
    apiKey: z.string().max(500).default(''),
    /** Required for openai-compatible/azure-openai/ollama; optional overrides elsewhere. */
    baseUrl: z.string().max(1_000).default(''),
    /** Azure only: deployment name + api-version. */
    azureDeployment: z.string().max(200).default(''),
    azureApiVersion: z.string().max(50).default(''),
    defaultModel: z.string().max(200).default(''),
    enabled: z.boolean().default(true)
})
export type ApiBackend = z.infer<typeof apiBackendSchema>

export const cliBackendSchema = z.object({
    id: z.string().min(1),
    family: z.literal('cli'),
    kind: z.enum(['claude-code', 'codex']),
    label: z.string().min(1).max(100),
    /** Explicit executable path — never resolved from PATH implicitly. */
    executablePath: z.string().max(1_000).default(''),
    defaultModel: z.string().max(200).default(''),
    /** Tool/research mode requires separate explicit consent (security boundary). */
    allowTools: z.boolean().default(false),
    timeoutSeconds: z.number().int().min(10).max(3_600).default(300),
    enabled: z.boolean().default(false)
})
export type CliBackend = z.infer<typeof cliBackendSchema>

export const backendInstanceSchema = z.discriminatedUnion('family', [
    apiBackendSchema,
    cliBackendSchema
])
export type BackendInstance = z.infer<typeof backendInstanceSchema>

/** A backend selection: a configured instance + optional model override. */
export const backendRefSchema = z.object({
    backendId: z.string().min(1),
    model: z.string().max(200).default('')
})
export type BackendRef = z.infer<typeof backendRefSchema>

// ---------------------------------------------------------------------------
// Editors (AI personas)
// ---------------------------------------------------------------------------

export const editorConfigSchema = z.object({
    id: z.string().min(1),
    name: z.string().min(1).max(100),
    /** CSS color for rail dot / highlights (Obsidian CSS vars allowed). */
    color: z.string().max(100).default('var(--color-accent)'),
    prompt: promptSourceSchema.default({ text: '', notePaths: [] }),
    /** null → inherit the global default backend. */
    backend: backendRefSchema.nullable().default(null),
    includeLinkedNotes: z.boolean().default(false),
    maxLinkedNotes: z.number().int().min(1).max(20).default(5),
    injectVoiceProfile: z.boolean().default(true),
    capabilities: z
        .object({
            review: z.boolean().default(true),
            rewrite: z.boolean().default(true),
            research: z.boolean().default(false)
        })
        .default({ review: true, rewrite: true, research: false }),
    /** Learning memory: where accept/reject distillations live. */
    memory: z.enum(['off', 'settings', 'note']).default('off'),
    memoryNotePath: z.string().max(1_000).default(''),
    memoryText: z.string().max(50_000).default(''),
    enabled: z.boolean().default(true)
})
export type EditorConfig = z.infer<typeof editorConfigSchema>

// ---------------------------------------------------------------------------
// Panels (1-n member editors + aggregation)
// ---------------------------------------------------------------------------

export const panelConfigSchema = z.object({
    id: z.string().min(1),
    name: z.string().min(1).max(100),
    color: z.string().max(100).default('var(--color-accent)'),
    memberEditorIds: z.array(z.string().min(1)).min(1).max(20),
    charter: promptSourceSchema.default({ text: '', notePaths: [] }),
    aggregationBackend: backendRefSchema.nullable().default(null),
    enabled: z.boolean().default(true)
})
export type PanelConfig = z.infer<typeof panelConfigSchema>

// ---------------------------------------------------------------------------
// Actions (verbs bound to an editor or panel)
// ---------------------------------------------------------------------------

export const builtInActionIdSchema = z.enum([
    'rephrase',
    'summarize',
    'critique',
    'say-more',
    'find-evidence',
    'identify-assumptions',
    'simplify',
    'continue'
])
export type BuiltInActionId = z.infer<typeof builtInActionIdSchema>

export const actionTargetSchema = z.object({
    targetType: z.enum(['editor', 'panel']),
    targetId: z.string().min(1)
})
export type ActionTarget = z.infer<typeof actionTargetSchema>

export const actionBindingSchema = z.object({
    id: z.string().min(1),
    /** Built-in verb id, or a UUID for custom actions. */
    actionId: z.string().min(1),
    /** Custom actions carry their own display name + instruction prompt. */
    customName: z.string().max(100).default(''),
    customInstruction: promptSourceSchema.default({ text: '', notePaths: [] }),
    binding: actionTargetSchema.nullable().default(null)
})
export type ActionBinding = z.infer<typeof actionBindingSchema>

// ---------------------------------------------------------------------------
// Binding rules (note-type awareness) & exclusions
// ---------------------------------------------------------------------------

export const ruleMatchSchema = z.object({
    matchType: z.enum(['folder', 'tag', 'frontmatter', 'osk-note-type']),
    /** Folder path prefix, tag (no #), `key: value` pair, or OSK type name. */
    value: z.string().min(1).max(500)
})
export type RuleMatch = z.infer<typeof ruleMatchSchema>

export const bindingRuleSchema = z.object({
    id: z.string().min(1),
    name: z.string().max(100).default(''),
    match: ruleMatchSchema,
    /** 'disabled' turns the whole plugin UI off for matching notes. */
    effect: z.enum(['assign', 'disabled']),
    defaultTarget: actionTargetSchema.nullable().default(null),
    enabled: z.boolean().default(true)
})
export type BindingRule = z.infer<typeof bindingRuleSchema>

// ---------------------------------------------------------------------------
// Behavior & privacy
// ---------------------------------------------------------------------------

export const behaviorSettingsSchema = z.object({
    /** Word count above which Review asks for confirmation. */
    sizeWarningWords: z.number().int().min(100).max(1_000_000).default(8_000),
    maxConcurrentRequests: z.number().int().min(1).max(10).default(3),
    /** Total context budget per run, in characters (proxy for tokens). */
    contextBudgetChars: z.number().int().min(1_000).max(2_000_000).default(200_000),
    excludedFolders: z.array(z.string().max(1_000)).max(200).default([]),
    excludedTags: z.array(z.string().max(200)).max(200).default([]),
    /** Frontmatter flag that opts a note out entirely: `ai_editor: false`. */
    respectFrontmatterOptOut: z.boolean().default(true),
    stripFrontmatter: z.boolean().default(false),
    /** '' → answer in the note's language; otherwise a fixed language. */
    responseLanguageOverride: z.string().max(50).default(''),
    /** Editor handling async margin comments by default. */
    defaultCommentEditorId: z.string().default('')
})
export type BehaviorSettings = z.infer<typeof behaviorSettingsSchema>

// ---------------------------------------------------------------------------
// Root settings
// ---------------------------------------------------------------------------

export const pluginSettingsSchema = z.object({
    schemaVersion: z.number().int().min(1).default(SETTINGS_SCHEMA_VERSION),
    backends: z.array(backendInstanceSchema).max(50).default([]),
    /** Global default backend for editors/panels set to inherit. */
    defaultBackend: backendRefSchema.nullable().default(null),
    editors: z.array(editorConfigSchema).max(200).default([]),
    panels: z.array(panelConfigSchema).max(50).default([]),
    actions: z.array(actionBindingSchema).max(200).default([]),
    rules: z.array(bindingRuleSchema).max(200).default([]),
    voiceProfile: promptSourceSchema.default({ text: '', notePaths: [] }),
    behavior: behaviorSettingsSchema.default(behaviorSettingsSchema.parse({})),
    /** True once the starter pack has been seeded (idempotence). */
    starterPackSeeded: z.boolean().default(false),
    /** True once the setup wizard completed or was skipped. */
    onboarded: z.boolean().default(false)
})
export type PluginSettingsV1 = z.infer<typeof pluginSettingsSchema>

export const DEFAULT_PLUGIN_SETTINGS: PluginSettingsV1 = pluginSettingsSchema.parse({})

/**
 * Loads persisted settings defensively: parse the whole object; on failure,
 * salvage section by section so one corrupt entity never wipes the rest.
 * Unknown future versions are kept as-is data-wise but validated against the
 * current schema (migrations hook in here as versions grow).
 */
export function loadSettings(raw: unknown): PluginSettingsV1 {
    const whole = pluginSettingsSchema.safeParse(raw)
    if (whole.success) {
        return whole.data
    }
    if (typeof raw !== 'object' || raw === null) {
        return DEFAULT_PLUGIN_SETTINGS
    }
    const source = raw as Record<string, unknown>
    const salvaged: Record<string, unknown> = { schemaVersion: SETTINGS_SCHEMA_VERSION }
    const sections: readonly (keyof PluginSettingsV1)[] = [
        'backends',
        'defaultBackend',
        'editors',
        'panels',
        'actions',
        'rules',
        'voiceProfile',
        'behavior',
        'starterPackSeeded',
        'onboarded'
    ]
    for (const key of sections) {
        const candidate = { ...DEFAULT_PLUGIN_SETTINGS, [key]: source[key] }
        if (pluginSettingsSchema.safeParse(candidate).success) {
            salvaged[key] = source[key]
        }
    }
    return pluginSettingsSchema.parse({ ...DEFAULT_PLUGIN_SETTINGS, ...salvaged })
}

/**
 * Referential integrity: entities referencing missing IDs, reported so the
 * settings UI can warn and offer fixes (never silently dropped).
 */
export interface IntegrityIssue {
    readonly entity: 'editor' | 'panel' | 'action' | 'rule' | 'default-backend' | 'behavior'
    readonly entityId: string
    readonly missing: 'backend' | 'editor' | 'panel'
    readonly missingId: string
}

export function checkReferentialIntegrity(settings: PluginSettingsV1): IntegrityIssue[] {
    const backendIds = new Set(settings.backends.map((backend) => backend.id))
    const editorIds = new Set(settings.editors.map((editor) => editor.id))
    const panelIds = new Set(settings.panels.map((panel) => panel.id))
    const issues: IntegrityIssue[] = []

    const checkTarget = (
        entity: IntegrityIssue['entity'],
        entityId: string,
        target: { targetType: 'editor' | 'panel'; targetId: string } | null
    ): void => {
        if (!target) {
            return
        }
        const pool = target.targetType === 'editor' ? editorIds : panelIds
        if (!pool.has(target.targetId)) {
            issues.push({ entity, entityId, missing: target.targetType, missingId: target.targetId })
        }
    }

    if (settings.defaultBackend && !backendIds.has(settings.defaultBackend.backendId)) {
        issues.push({
            entity: 'default-backend',
            entityId: 'default',
            missing: 'backend',
            missingId: settings.defaultBackend.backendId
        })
    }
    for (const editor of settings.editors) {
        if (editor.backend && !backendIds.has(editor.backend.backendId)) {
            issues.push({
                entity: 'editor',
                entityId: editor.id,
                missing: 'backend',
                missingId: editor.backend.backendId
            })
        }
    }
    for (const panel of settings.panels) {
        for (const memberId of panel.memberEditorIds) {
            if (!editorIds.has(memberId)) {
                issues.push({
                    entity: 'panel',
                    entityId: panel.id,
                    missing: 'editor',
                    missingId: memberId
                })
            }
        }
        if (panel.aggregationBackend && !backendIds.has(panel.aggregationBackend.backendId)) {
            issues.push({
                entity: 'panel',
                entityId: panel.id,
                missing: 'backend',
                missingId: panel.aggregationBackend.backendId
            })
        }
    }
    for (const action of settings.actions) {
        checkTarget('action', action.id, action.binding)
    }
    for (const rule of settings.rules) {
        checkTarget('rule', rule.id, rule.defaultTarget)
    }
    if (
        settings.behavior.defaultCommentEditorId.length > 0 &&
        !editorIds.has(settings.behavior.defaultCommentEditorId)
    ) {
        issues.push({
            entity: 'behavior',
            entityId: 'defaultCommentEditor',
            missing: 'editor',
            missingId: settings.behavior.defaultCommentEditorId
        })
    }
    return issues
}
