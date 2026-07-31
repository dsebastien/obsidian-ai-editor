import { z } from 'zod'
import { generateId } from '../ids'

/**
 * Persisted plugin settings: schema-versioned, Zod-validated on load.
 *
 * Rules (see Business Rules + review majors #24/#26):
 * - Every entity has a stable UUID; cross-references use IDs, never names.
 * - Unknown/invalid persisted data must never crash the plugin: `loadSettings`
 *   salvages per entity (array elements, behavior fields) rather than
 *   discarding whole sections — and reports what it dropped so callers can
 *   warn instead of silently losing API keys or privacy exclusions.
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
    notePaths: z.array(z.string().max(1_000)).max(50).default([]),
    /**
     * When true, context assembly also inlines the notes LINKED from each
     * note this source references (notePaths + wikilinks in its text):
     * depth 1 only, embeds count, deduped against already-included notes,
     * capped per referenced note, and subject to `contextBudgetChars`.
     * Default off; the root voice profile defaults ON (its motivating case:
     * `[[My Voice Profile]]` linking out to style/identity notes).
     */
    followLinks: z.boolean().default(false)
})
export type PromptSource = z.infer<typeof promptSourceSchema>

// ---------------------------------------------------------------------------
// Backend instances (1-n configured providers / CLI agents)
// ---------------------------------------------------------------------------

export const apiProviderKindSchema = z.enum([
    'anthropic',
    'openai',
    // Dedicated OpenRouter profile: OpenAI-compatible wire format with the
    // base URL, attribution headers, and reasoning passthrough preset so
    // setup is paste-key-and-go. Enum order is the add-backend menu order.
    'openrouter',
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
    /**
     * Ollama + Anthropic: thinking / reasoning mode. Default 'off'
     * everywhere — deliberate UX choice: a local model silently reasoning for
     * minutes with zero visible output is indistinguishable from a hang.
     * Ollama treats any non-'off' value as `think: true`. Anthropic 'on'
     * sends adaptive thinking (`{ type: 'adaptive' }` — the current API mode,
     * Claude 4.6 and newer); 'budget' sends the legacy manual block
     * (`{ type: 'enabled', budget_tokens }`) that only Claude 4.5-and-earlier
     * models still accept — current models reject it with HTTP 400.
     */
    thinking: z.enum(['off', 'on', 'budget']).default('off'),
    /**
     * Anthropic only: thinking token budget, sent only when `thinking` is
     * 'budget' (legacy manual mode). API minimum is 1024; the adapter adds it
     * on top of the output budget and clamps the sum to the 32k output-token
     * ceiling of the legacy models that still accept manual thinking, keeping
     * `budget_tokens < max_tokens` intact for every allowed value.
     */
    thinkingBudgetTokens: z.number().int().min(1_024).max(32_000).default(8_192),
    /**
     * OpenAI + Azure OpenAI: `reasoning_effort` passthrough; OpenRouter:
     * forwarded as `reasoning: { effort }` (its unified reasoning param).
     * 'default' sends nothing (provider default).
     */
    reasoningEffort: z.enum(['default', 'minimal', 'low', 'medium', 'high']).default('default'),
    /**
     * openai-compatible + openrouter (advanced): raw JSON object merged into
     * the request body — flags vary per host/model (Groq, LM Studio,
     * OpenRouter provider routing…), so an escape hatch beats per-host
     * switches. Validated as a JSON object at save time; the adapter
     * re-validates.
     */
    extraBodyJson: z.string().max(20_000).default(''),
    enabled: z.boolean().default(true)
})
export type ApiBackend = z.infer<typeof apiBackendSchema>

/**
 * The two consents a CLI backend needs, recorded as WHAT was consented to
 * rather than as a bare "yes" (Business Rules #9, plan M7).
 *
 * Each field holds the executable path the user agreed to at the moment they
 * agreed, so consent is bound to one exact binary. A path that changes — the
 * user edits it, an import brings a different one, a synced `data.json`
 * merges someone else's — no longer matches, and the backend falls back to
 * "not consented" instead of silently carrying a decision the user made about
 * a different program. That is the whole reason this is a string and not a
 * boolean: `data.json` syncs (Business Rules #12), and a boolean would travel
 * as permission to launch whatever the path happens to say now.
 *
 * `''` means not granted. Never write these directly — `cli-consent.ts` owns
 * every transition, and `hasToolsConsent` additionally requires launch
 * consent, so tool mode can never outlive the permission to start the process
 * at all.
 */
export const cliConsentSchema = z.object({
    /** Path launch consent (step 1) was granted for; '' when not granted. */
    launchPath: z.string().max(1_000).default(''),
    /** Path tool/research consent (step 2) was granted for; '' when not granted. */
    toolsPath: z.string().max(1_000).default('')
})
export type CliConsent = z.infer<typeof cliConsentSchema>

export const cliBackendSchema = z.object({
    id: z.string().min(1),
    family: z.literal('cli'),
    kind: z.enum(['claude-code', 'codex']),
    label: z.string().min(1).max(100),
    /** Explicit executable path — never resolved from PATH implicitly. */
    executablePath: z.string().max(1_000).default(''),
    defaultModel: z.string().max(200).default(''),
    /**
     * Two-step consent record. There is deliberately no `allowTools` boolean
     * beside it: one persisted fact per decision means "tools are on" and "the
     * user consented to tools for this binary" cannot drift apart. Read it
     * through `hasLaunchConsent` / `hasToolsConsent`.
     */
    consent: cliConsentSchema.default({ launchPath: '', toolsPath: '' }),
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
    prompt: promptSourceSchema.default({ text: '', notePaths: [], followLinks: false }),
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
    charter: promptSourceSchema.default({ text: '', notePaths: [], followLinks: false }),
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
    'humanize',
    'continue'
])
export type BuiltInActionId = z.infer<typeof builtInActionIdSchema>

export const actionTargetSchema = z.object({
    targetType: z.enum(['editor', 'panel']),
    targetId: z.string().min(1)
})
export type ActionTarget = z.infer<typeof actionTargetSchema>

/**
 * What a verb does to the note — the execution pipeline it runs through.
 * Built-in verbs carry it in the verb registry; a custom action states it
 * here, because the same instruction text can mean "rewrite this", "write
 * more here" or "tell me what is wrong with this".
 */
export const verbClassSchema = z.enum(['transform', 'generate', 'review'])
export type VerbClass = z.infer<typeof verbClassSchema>

export const actionBindingSchema = z.object({
    id: z.string().min(1),
    /** Built-in verb id, or a UUID for custom actions. */
    actionId: z.string().min(1),
    /** Custom actions carry their own display name + instruction prompt. */
    customName: z.string().max(100).default(''),
    customInstruction: promptSourceSchema.default({ text: '', notePaths: [], followLinks: false }),
    /**
     * Custom actions only (built-ins take their class from the verb
     * registry). Deliberately REQUIRED rather than defaulted: the class
     * decides whether the result replaces the selection, is inserted after
     * it, or comes back as findings, and silently guessing "transform" would
     * make "check this for factual errors" overwrite the checked text. A
     * custom action without a class resolves to `custom-class-missing` and is
     * offered nowhere until the user picks one.
     */
    customVerbClass: verbClassSchema.nullable().default(null),
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
    /**
     * Upper bound for one editor's backend request (connect + full stream),
     * in seconds. Applies to API reviews from any entry point (UI and the
     * `editor-ai-daemons:review` CLI alike). The default is laptop-realistic: slow
     * local models (Ollama on CPU) legitimately stream for many minutes.
     */
    requestTimeoutSeconds: z.number().int().min(30).max(3_600).default(600),
    /** Total context budget per run, in characters (proxy for tokens). */
    contextBudgetChars: z.number().int().min(1_000).max(2_000_000).default(200_000),
    /**
     * Daemon mode (plan §0, decisions locked 2026-07-29): editors watch file
     * edits and automatically re-dispatch a review after the user pauses
     * editing a reviewable note whose text actually changed since its last
     * run. Explicit carve-out to Business Rule #1: enabling this toggle IS
     * the explicit user action authorizing those runs. Default off — every
     * automatic refresh calls the configured backends (cost control).
     */
    daemonMode: z.boolean().default(false),
    /**
     * Seconds of editing inactivity before a daemon refresh dispatches
     * (per-file idle window; every edit restarts it).
     */
    daemonIdleSeconds: z.number().int().min(5).max(600).default(30),
    excludedFolders: z.array(z.string().max(1_000)).max(200).default([]),
    excludedTags: z.array(z.string().max(200)).max(200).default([]),
    /** Frontmatter flag that opts a note out entirely: `ai_editor: false`. */
    respectFrontmatterOptOut: z.boolean().default(true),
    /**
     * Removes the leading frontmatter block from the reviewed note, from every
     * attached note, and from the document text in the request payload
     * (`services/context/context-assembler.ts` for the first two + the budget
     * report, `services/backends/backend-executor.ts` for the payload).
     */
    stripFrontmatter: z.boolean().default(false),
    /**
     * '' → answer in the note's language; otherwise a fixed language, appended
     * as the last block of every composed system prompt including the panel
     * chairperson's (`augmentResponseLanguage` in `services/review-service.ts`).
     */
    responseLanguageOverride: z.string().max(50).default(''),
    /** Editor handling async margin comments by default. */
    defaultCommentEditorId: z.string().default(''),
    /**
     * Whether durable margin comments are rendered in a column next to the
     * text (plan §5.5 / M8). Off puts them in the side panel only — the
     * comments themselves are unaffected, this is purely a view preference.
     * Default on: a parked question the user cannot see next to its span is
     * the feature not working.
     */
    showMarginComments: z.boolean().default(true)
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
    /** Follow-links defaults ON here — see `promptSourceSchema.followLinks`. */
    voiceProfile: promptSourceSchema.default({ text: '', notePaths: [], followLinks: true }),
    behavior: behaviorSettingsSchema.default(behaviorSettingsSchema.parse({})),
    /** True once the starter pack has been seeded (idempotence). */
    starterPackSeeded: z.boolean().default(false),
    /** True once the setup wizard completed or was skipped. */
    onboarded: z.boolean().default(false)
})
export type PluginSettingsV1 = z.infer<typeof pluginSettingsSchema>

export const DEFAULT_PLUGIN_SETTINGS: PluginSettingsV1 = pluginSettingsSchema.parse({})

/** Result of a defensive settings load, including what could not be kept. */
export interface LoadedSettings {
    readonly settings: PluginSettingsV1
    /**
     * Human-readable paths of persisted values that failed validation and
     * were replaced by defaults (`backends[1]`, `behavior.excludedTags`,
     * `rules`, `(all settings)`…). Empty on a clean load. Callers MUST
     * surface a non-empty list to the user: silently defaulting privacy
     * exclusions would fail-open Business Rule #7, and silently defaulting
     * backends destroys API keys on the next save.
     */
    readonly dropped: readonly string[]
    /**
     * Entity paths whose duplicated ids were regenerated (keep-first). Empty
     * on a clean load. Non-empty means the resolved settings differ from
     * disk and the caller must persist AND warn — see
     * `resolveIdCollisions` for why collisions are dangerous.
     */
    readonly regeneratedIds: readonly string[]
}

/** Array sections whose elements can be salvaged individually. */
const ARRAY_SECTION_SCHEMAS: Partial<Record<keyof PluginSettingsV1, z.ZodType>> = {
    backends: backendInstanceSchema,
    editors: editorConfigSchema,
    panels: panelConfigSchema,
    actions: actionBindingSchema,
    rules: bindingRuleSchema
}

/** Result of `resolveIdCollisions`. */
export interface IdCollisionResolution {
    /** Same object as the input when no collision existed. */
    readonly settings: PluginSettingsV1
    /** Paths of entities whose ids were regenerated (`backends[2]`…). */
    readonly regenerated: readonly string[]
}

/**
 * Enforces global id uniqueness across every entity array (keep-first,
 * regenerate later ids). data.json is syncable: a sync-merge conflict can
 * duplicate entities, and every lookup resolves by first match — so with two
 * backends sharing an id, the settings UI can display one while requests
 * route note content and the WRONG API key to the other's endpoint
 * (Business Rules #12). Keep-first makes existing references keep resolving
 * to exactly the entity that first-match lookups already picked; the later
 * duplicate gets a fresh id and becomes independently addressable again.
 * Uniqueness is enforced ACROSS arrays too — cross-kind reuse of an id
 * invites the same display-vs-routing divergence in future lookups.
 */
export function resolveIdCollisions(
    settings: PluginSettingsV1,
    generate: () => string = generateId
): IdCollisionResolution {
    const seen = new Set<string>()
    const regenerated: string[] = []

    const dedupe = <T extends { readonly id: string }>(section: string, items: readonly T[]): T[] =>
        items.map((item, index) => {
            if (!seen.has(item.id)) {
                seen.add(item.id)
                return item
            }
            regenerated.push(`${section}[${index}]`)
            let next = generate()
            while (seen.has(next)) {
                next = generate()
            }
            seen.add(next)
            return { ...item, id: next }
        })

    const backends = dedupe('backends', settings.backends)
    const editors = dedupe('editors', settings.editors)
    const panels = dedupe('panels', settings.panels)
    const actions = dedupe('actions', settings.actions)
    const rules = dedupe('rules', settings.rules)
    if (regenerated.length === 0) {
        return { settings, regenerated }
    }
    return {
        settings: { ...settings, backends, editors, panels, actions, rules },
        regenerated
    }
}

/**
 * Loads persisted settings defensively: parse the whole object; on failure,
 * salvage with entity-level granularity so one corrupt value never wipes its
 * siblings — array sections keep every individually-valid element, and the
 * behavior section keeps every individually-valid field (privacy exclusions
 * must survive an unrelated corrupt scalar — Business Rule #7). Never
 * throws. Unknown future versions are kept as-is data-wise but validated
 * against the current schema (migrations hook in here as versions grow).
 */
export function loadSettingsDetailed(raw: unknown): LoadedSettings {
    const whole = pluginSettingsSchema.safeParse(raw)
    if (whole.success) {
        const resolved = resolveIdCollisions(whole.data)
        return {
            settings: resolved.settings,
            dropped: [],
            regeneratedIds: resolved.regenerated
        }
    }
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
        return {
            settings: DEFAULT_PLUGIN_SETTINGS,
            dropped: ['(all settings)'],
            regeneratedIds: []
        }
    }
    const source = raw as Record<string, unknown>
    const salvaged: Record<string, unknown> = { schemaVersion: SETTINGS_SCHEMA_VERSION }
    const dropped: string[] = []
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
    /** Whether the value is valid as this section within otherwise-default settings. */
    const sectionIsValid = (key: keyof PluginSettingsV1, value: unknown): boolean =>
        pluginSettingsSchema.safeParse({ ...DEFAULT_PLUGIN_SETTINGS, [key]: value }).success

    for (const key of sections) {
        const value = source[key]
        if (sectionIsValid(key, value)) {
            salvaged[key] = value
            continue
        }
        const elementSchema = ARRAY_SECTION_SCHEMAS[key]
        if (elementSchema && Array.isArray(value)) {
            const kept: unknown[] = []
            value.forEach((element, index) => {
                if (elementSchema.safeParse(element).success) {
                    kept.push(element)
                } else {
                    dropped.push(`${key}[${index}]`)
                }
            })
            // Re-check the pruned array (guards e.g. max-length violations).
            if (sectionIsValid(key, kept)) {
                salvaged[key] = kept
            } else {
                dropped.push(key)
            }
            continue
        }
        if (key === 'behavior' && typeof value === 'object' && value !== null) {
            const behaviorSource = value as Record<string, unknown>
            const keptFields: Record<string, unknown> = {}
            for (const field of Object.keys(behaviorSettingsSchema.shape)) {
                const fieldValue = behaviorSource[field]
                const fieldCandidate = {
                    ...DEFAULT_PLUGIN_SETTINGS.behavior,
                    [field]: fieldValue
                }
                if (behaviorSettingsSchema.safeParse(fieldCandidate).success) {
                    keptFields[field] = fieldValue
                } else {
                    dropped.push(`behavior.${field}`)
                }
            }
            if (sectionIsValid('behavior', keptFields)) {
                salvaged['behavior'] = keptFields
            } else {
                dropped.push('behavior')
            }
            continue
        }
        dropped.push(key)
    }
    const final = pluginSettingsSchema.safeParse({ ...DEFAULT_PLUGIN_SETTINGS, ...salvaged })
    if (final.success) {
        const resolved = resolveIdCollisions(final.data)
        return {
            settings: resolved.settings,
            dropped,
            regeneratedIds: resolved.regenerated
        }
    }
    return { settings: DEFAULT_PLUGIN_SETTINGS, dropped: ['(all settings)'], regeneratedIds: [] }
}

/** `loadSettingsDetailed` without the salvage report. */
export function loadSettings(raw: unknown): PluginSettingsV1 {
    return loadSettingsDetailed(raw).settings
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
            issues.push({
                entity,
                entityId,
                missing: target.targetType,
                missingId: target.targetId
            })
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
