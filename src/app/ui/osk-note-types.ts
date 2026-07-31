import type { App } from 'obsidian'
import type { OskNoteType, OskNoteTypeMapping } from '../domain/rules/note-type'

/**
 * OPTIONAL adapter for the Obsidian Starter Kit plugin's note-type registry
 * (plan §4b). Deliberately tiny: it reads one list and normalizes it. Every
 * decision made with that list lives in `domain/rules/note-type.ts`, pure and
 * spec-covered.
 *
 * Nothing in AI Editor depends on the Starter Kit being installed. When the
 * plugin is absent, disabled, or exposes a shape this adapter does not
 * recognize, `readOskNoteTypes` returns `[]` and note-type resolution falls
 * back to the `type/<x>` tag convention — the whole feature degrades to "rules
 * match the tag spelling instead of the canonical name".
 *
 * Feature detection + defensive normalization on every field: the Starter Kit's
 * API carries no version guarantee, so a shape change must degrade to `[]`, not
 * throw inside a context-menu build. Ported from `starter-kit.service.ts` in
 * obsidian-kanban-action-planner, minus `recognizeNoteType`: that call is
 * asynchronous and every consumer here is a synchronous decision (see the
 * `note-type.ts` module doc).
 */

/** Community-plugin id of the Obsidian Starter Kit plugin. */
export const STARTER_KIT_PLUGIN_ID = 'obsidian-starter-kit-plugin'

/** The one method this adapter needs from the Starter Kit's API object. */
interface StarterKitApiLike {
    listNoteTypes?: () => unknown
}

/**
 * Unwraps either a raw value or an `ApiResult<T>` envelope (`{ success, data }`)
 * into `T | null` — the Starter Kit uses both shapes across its API surface.
 */
function unwrap(result: unknown): unknown {
    if (result === null || result === undefined) {
        return null
    }
    if (typeof result === 'object' && 'success' in result) {
        const envelope = result as { success: unknown; data?: unknown }
        return envelope.success === true ? (envelope.data ?? null) : null
    }
    return result
}

/** The Starter Kit's API object, or `null` when it is not usable. */
function getStarterKitApi(app: App): StarterKitApiLike | null {
    // `app.plugins` is not part of the public typings; guarded structurally.
    const plugins = (app as unknown as { plugins?: { plugins?: Record<string, unknown> } }).plugins
    const plugin = plugins?.plugins?.[STARTER_KIT_PLUGIN_ID] as { api?: unknown } | undefined
    const api = plugin?.api as StarterKitApiLike | undefined
    return api && typeof api.listNoteTypes === 'function' ? api : null
}

/** Whether the Starter Kit is installed, enabled, and exposing its API. */
export function isStarterKitAvailable(app: App): boolean {
    return getStarterKitApi(app) !== null
}

/**
 * Normalizes one raw registry entry, or `null` when it carries no usable name.
 * A type with no mappings is kept: it simply recognizes nothing.
 */
export function normalizeOskNoteType(raw: unknown): OskNoteType | null {
    if (typeof raw !== 'object' || raw === null) {
        return null
    }
    const source = raw as { name?: unknown; mappings?: unknown }
    if (typeof source.name !== 'string' || source.name.trim().length === 0) {
        return null
    }
    const mappings: OskNoteTypeMapping[] = []
    if (Array.isArray(source.mappings)) {
        for (const entry of source.mappings) {
            if (typeof entry !== 'object' || entry === null) {
                continue
            }
            const mapping = entry as { type?: unknown; value?: unknown; enabled?: unknown }
            if (typeof mapping.type !== 'string' || typeof mapping.value !== 'string') {
                continue
            }
            mappings.push({
                type: mapping.type,
                value: mapping.value,
                // Absent `enabled` counts as enabled: the Starter Kit's own
                // default, and a mapping the user never disabled must keep
                // recognizing its notes.
                enabled: mapping.enabled !== false
            })
        }
    }
    return { name: source.name, mappings }
}

/**
 * The Starter Kit's note types, normalized. `[]` when the plugin is
 * unavailable, its API changed shape, or the call throws — never throws.
 */
export function readOskNoteTypes(app: App): readonly OskNoteType[] {
    const api = getStarterKitApi(app)
    if (!api?.listNoteTypes) {
        return []
    }
    let raw: unknown
    try {
        raw = unwrap(api.listNoteTypes())
    } catch {
        return []
    }
    if (!Array.isArray(raw)) {
        return []
    }
    const types: OskNoteType[] = []
    for (const entry of raw) {
        const noteType = normalizeOskNoteType(entry)
        if (noteType !== null) {
            types.push(noteType)
        }
    }
    return types
}
