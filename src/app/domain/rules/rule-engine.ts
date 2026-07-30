import type {
    ActionTarget,
    BindingRule,
    PluginSettingsV1,
    RuleMatch
} from '../settings/settings-schema'
import { anyTagMatches, folderContainsPath, normalizeFolderPath } from './matchers'
import { normalizeNoteTypeId } from './note-type'

/**
 * Binding-rule engine (plan §4b "Note-type awareness"): decides, per note,
 * whether the plugin is switched off entirely and — when it is not — WHO
 * reviews it by default.
 *
 * Pure over settings + note facts, so every surface that must agree (rail,
 * context menus, palette commands, CLI, daemon, the dispatch services) asks
 * the same function and can never diverge. Rules only pick participants; they
 * never start anything (Business Rules #1).
 *
 * ## Evaluation order (decided, not inherited)
 *
 * Two phases, in this order:
 *
 * 1. **Kill switches win globally.** If ANY enabled `disabled`-effect rule
 *    matches, the plugin is off for the note — wherever that rule sits in the
 *    list. A kill switch exists to keep AI away from daily notes and private
 *    folders; letting an unrelated `assign` rule ordered above it silently
 *    re-enable the plugin there would be a footgun with no visible cause.
 * 2. **Among `assign` rules, the FIRST match in list order wins.** The rules
 *    tab exposes explicit move-up/move-down ordering, so list order IS the
 *    user's priority statement. Sorting by "match specificity"
 *    (note-type > frontmatter > tag > folder) was considered and rejected: it
 *    would make the visible order a lie, and the user can already express any
 *    specificity they want by moving a rule up.
 *
 * Assignments are **not accumulated** across matching rules. A rule saying
 * "only the Humanizer touches this folder" has to be able to mean exactly
 * that; unioning it with a broader rule's target would make narrowing
 * impossible to express.
 *
 * ## No match
 *
 * `default` — the caller keeps today's behavior: every enabled review-capable
 * editor participates.
 *
 * ## Unresolved metadata (cold cache)
 *
 * Obsidian's metadata cache resolves asynchronously, so tag / frontmatter /
 * note-type facts can be missing right after startup. Those match types then
 * cannot be evaluated, and the two effects fail in OPPOSITE directions on
 * purpose:
 *
 * - `disabled` rules fail CLOSED (treated as matching). The user asked for the
 *   plugin to stay away from those notes; a warm-up window where the rail
 *   shows up and a review can be dispatched would violate that on exactly the
 *   notes they cared most about. A transient false-positive kill switch costs
 *   nothing — the same trade-off `isExcluded` already makes.
 * - `assign` rules fail OPEN (treated as not matching), because the fallback is
 *   the documented default pool rather than a leak.
 *
 * Folder matching needs no metadata and is evaluated normally in both cases.
 */

// ---------------------------------------------------------------------------
// Facts
// ---------------------------------------------------------------------------

/** Metadata-cache facts a rule needs beyond the path. */
export interface NoteCachedFacts {
    /** Note tags, without `#` (frontmatter + inline, as `NoteMetadata` gives them). */
    readonly tags: readonly string[]
    /** Frontmatter key/value pairs; values are untrusted user data. */
    readonly frontmatter: Readonly<Record<string, unknown>>
    /**
     * Note-type identifiers (see `note-type.ts`). Empty when the note carries
     * no type tag and no OSK registry entry recognizes it.
     */
    readonly noteTypeIds: readonly string[]
}

export interface NoteRuleFacts {
    /** Vault-relative note path. */
    readonly path: string
    /**
     * `null` when Obsidian's metadata cache has not resolved the note (cold
     * cache, missing file) — see the fail rules in the module doc.
     */
    readonly cached: NoteCachedFacts | null
}

// ---------------------------------------------------------------------------
// Outcome
// ---------------------------------------------------------------------------

export type RuleOutcome =
    /** A kill-switch rule matched: no rail, no menu items, no dispatch. */
    | {
          readonly kind: 'disabled'
          readonly ruleId: string
          /** Rule name, or its match expression when unnamed (for messages). */
          readonly ruleLabel: string
      }
    /** The first matching `assign` rule picked the default reviewer. */
    | {
          readonly kind: 'assigned'
          readonly ruleId: string
          readonly ruleLabel: string
          readonly target: ActionTarget
      }
    /** No rule matched: every enabled review-capable editor participates. */
    | { readonly kind: 'default' }

/** Display label for a rule: its name, else its match expression. */
export function ruleLabel(rule: BindingRule): string {
    const name = rule.name.trim()
    return name.length > 0 ? name : `${rule.match.matchType} "${rule.match.value}"`
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

/**
 * Splits a `frontmatter` rule value into the key and the expected value.
 * `type: article` → `{ key: 'type', value: 'article' }`; a value with no colon
 * (`draft`) is a presence check (`value: null`). Only the FIRST colon splits,
 * so `url: https://x` keeps its value intact.
 */
export function parseFrontmatterMatch(raw: string): { key: string; value: string | null } | null {
    const separator = raw.indexOf(':')
    if (separator === -1) {
        const key = raw.trim()
        return key.length === 0 ? null : { key, value: null }
    }
    const key = raw.slice(0, separator).trim()
    const value = raw.slice(separator + 1).trim()
    if (key.length === 0) {
        return null
    }
    return { key, value: value.length === 0 ? null : value }
}

/**
 * Comparable text of a frontmatter scalar, or `null` when the value has no
 * meaningful text form (nested YAML maps, dates, anything exotic). Frontmatter
 * is untrusted user data, so nothing is stringified blindly — an object would
 * compare as `[object Object]`.
 */
function scalarText(value: unknown): string | null {
    if (typeof value === 'string') {
        return value.trim()
    }
    if (typeof value === 'number' && Number.isFinite(value)) {
        return String(value)
    }
    if (typeof value === 'boolean') {
        return String(value)
    }
    return null
}

/**
 * Whether a frontmatter value satisfies the expectation.
 *
 * `expected === null` is a presence check: the key must hold something
 * meaningful — `null`, `undefined`, `false`, blank strings and empty arrays do
 * not count (`ai_editor: false` must not satisfy "has ai_editor"), while a
 * nested map does.
 *
 * Otherwise the value is compared case-insensitively as text; values with no
 * text form never match. Arrays match when any element matches.
 */
export function frontmatterValueMatches(actual: unknown, expected: string | null): boolean {
    if (Array.isArray(actual)) {
        return actual.some((entry) => frontmatterValueMatches(entry, expected))
    }
    const text = scalarText(actual)
    if (expected === null) {
        if (actual === null || actual === undefined || actual === false) {
            return false
        }
        // Non-scalar values (nested maps) carry content even without text.
        return text === null || text.length > 0
    }
    return text !== null && text.toLowerCase() === expected.toLowerCase()
}

/**
 * Whether the note matches a rule's condition. Returns `null` when the match
 * type needs metadata the caller does not have — the caller then applies the
 * effect-specific fail direction (see the module doc).
 */
export function matchesNote(match: RuleMatch, facts: NoteRuleFacts): boolean | null {
    if (match.matchType === 'folder') {
        // A folder rule on the vault root (`/`, the value new rules start
        // with) is a deliberate vault-wide rule, so it matches every note —
        // unlike a blank exclusion, which is a data-entry accident.
        return (
            normalizeFolderPath(match.value).length === 0 ||
            folderContainsPath(match.value, facts.path)
        )
    }
    const cached = facts.cached
    if (cached === null) {
        return null
    }
    switch (match.matchType) {
        case 'tag':
            return anyTagMatches(match.value, cached.tags)
        case 'frontmatter': {
            const parsed = parseFrontmatterMatch(match.value)
            if (parsed === null) {
                return false
            }
            return frontmatterValueMatches(cached.frontmatter[parsed.key], parsed.value)
        }
        case 'osk-note-type': {
            const wanted = normalizeNoteTypeId(match.value)
            return wanted.length > 0 && cached.noteTypeIds.includes(wanted)
        }
    }
}

/**
 * Whether the rule applies to the note, resolving unknown metadata according
 * to the rule's effect: kill switches fail closed, assignments fail open.
 */
function ruleApplies(rule: BindingRule, facts: NoteRuleFacts): boolean {
    const matched = matchesNote(rule.match, facts)
    if (matched !== null) {
        return matched
    }
    return rule.effect === 'disabled'
}

/**
 * Resolves the note's rule outcome. See the module doc for the two-phase order
 * and the cold-cache fail directions.
 *
 * `assign` rules without a target are skipped entirely: they assign nothing, so
 * treating them as a match would silently replace the default pool with an
 * empty one — and the Rules tab already shows them as "no target yet".
 */
export function resolveBindingRules(
    rules: readonly BindingRule[],
    facts: NoteRuleFacts
): RuleOutcome {
    for (const rule of rules) {
        if (!rule.enabled || rule.effect !== 'disabled') {
            continue
        }
        if (ruleApplies(rule, facts)) {
            return { kind: 'disabled', ruleId: rule.id, ruleLabel: ruleLabel(rule) }
        }
    }
    for (const rule of rules) {
        if (!rule.enabled || rule.effect !== 'assign' || rule.defaultTarget === null) {
            continue
        }
        if (ruleApplies(rule, facts)) {
            return {
                kind: 'assigned',
                ruleId: rule.id,
                ruleLabel: ruleLabel(rule),
                target: rule.defaultTarget
            }
        }
    }
    return { kind: 'default' }
}

/**
 * Whether any enabled rule needs metadata-cache facts (tags, frontmatter,
 * note types). Callers use it to skip building those facts — resolving note
 * types in particular means a cross-plugin call — for the common case of a
 * vault with no rules, or only folder rules.
 */
export function rulesNeedCachedFacts(rules: readonly BindingRule[]): boolean {
    return rules.some(
        (rule) =>
            rule.enabled &&
            rule.match.matchType !== 'folder' &&
            (rule.effect === 'disabled' || rule.defaultTarget !== null)
    )
}

/** Whether any enabled rule matches on OSK note types (registry lookup gate). */
export function rulesNeedNoteTypes(rules: readonly BindingRule[]): boolean {
    return rules.some(
        (rule) =>
            rule.enabled &&
            rule.match.matchType === 'osk-note-type' &&
            (rule.effect === 'disabled' || rule.defaultTarget !== null)
    )
}

// ---------------------------------------------------------------------------
// Participant pool
// ---------------------------------------------------------------------------

export type RuleEditorPool =
    /** No assignment: the caller's default pool applies. */
    | { readonly kind: 'default' }
    /**
     * The rule names these editors. They are NAMED participants, so a member
     * that cannot run must be reported as a skip rather than silently dropped.
     */
    | { readonly kind: 'editors'; readonly editorIds: readonly string[] }
    /** The rule's target no longer exists (dangling panel reference). */
    | { readonly kind: 'target-missing'; readonly targetId: string }

/**
 * Turns a rule outcome into the editor pool a review run should use. An editor
 * target names that one editor; a panel target names every member (v1 panel
 * dispatch: each member runs independently — charter aggregation is M6).
 *
 * A panel's own `enabled` flag is deliberately NOT consulted: it governs the
 * panel as an aggregation entity (M6), while a rule naming a panel means "these
 * editors review this note". Each member's own enabled/capability/backend state
 * is checked downstream and reported as a skip.
 */
export function resolveRuleEditorPool(
    settings: PluginSettingsV1,
    outcome: RuleOutcome
): RuleEditorPool {
    if (outcome.kind !== 'assigned') {
        return { kind: 'default' }
    }
    const target = outcome.target
    if (target.targetType === 'editor') {
        return { kind: 'editors', editorIds: [target.targetId] }
    }
    const panel = settings.panels.find((candidate) => candidate.id === target.targetId)
    if (!panel) {
        return { kind: 'target-missing', targetId: target.targetId }
    }
    return { kind: 'editors', editorIds: panel.memberEditorIds }
}
