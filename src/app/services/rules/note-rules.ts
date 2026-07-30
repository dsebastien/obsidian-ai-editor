import {
    resolveBindingRules,
    rulesNeedCachedFacts,
    rulesNeedNoteTypes
} from '../../domain/rules/rule-engine'
import type { NoteRuleFacts, RuleOutcome } from '../../domain/rules/rule-engine'
import type { BindingRule, PluginSettingsV1 } from '../../domain/settings/settings-schema'
import type { NoteMetadata } from '../context/vault-reader.intf'

/**
 * The bridge between the pure binding-rule engine and the vault: gathers a
 * note's facts and answers the two questions every surface asks — "is the
 * plugin switched off for this note?" and "who reviews it by default?".
 *
 * Every gate (rail, menus, palette commands, CLI, daemon) and every dispatch
 * service goes through here, so they can never disagree about a note.
 */

/** The slice of `VaultReader` a rule decision needs (also satisfied by it). */
export interface NoteFactsSource {
    getNoteMetadata(path: string): NoteMetadata | null
    getNoteTypeIds(path: string): readonly string[]
}

const NO_CACHED_FACTS = { tags: [], frontmatter: {}, noteTypeIds: [] } as const

/**
 * Builds the note facts, reading only what the configured rules can actually
 * use:
 * - No rule needs metadata (no rules at all, or folder rules only) → the
 *   metadata cache is not consulted. Empty facts are safe rather than `null`
 *   here: `null` means "unknown", which makes kill switches fail closed, and
 *   there is nothing unknown when every applicable rule matches on the path.
 * - Some rule needs metadata → one `getNoteMetadata` lookup; `null` (cold
 *   cache, missing note) propagates as unknown and the engine applies the
 *   per-effect fail direction.
 * - Only a rule matching on note types triggers `getNoteTypeIds`, which is a
 *   cross-plugin call.
 */
export function noteRuleFacts(
    path: string,
    source: NoteFactsSource,
    rules: readonly BindingRule[]
): NoteRuleFacts {
    if (!rulesNeedCachedFacts(rules)) {
        return { path, cached: NO_CACHED_FACTS }
    }
    const metadata = source.getNoteMetadata(path)
    if (metadata === null) {
        return { path, cached: null }
    }
    return {
        path,
        cached: {
            tags: metadata.tags,
            frontmatter: metadata.frontmatter,
            noteTypeIds: rulesNeedNoteTypes(rules) ? source.getNoteTypeIds(path) : []
        }
    }
}

/** The note's binding-rule outcome; `default` when no rule is configured. */
export function noteRuleOutcome(
    path: string,
    source: NoteFactsSource,
    settings: PluginSettingsV1
): RuleOutcome {
    const rules = settings.rules
    if (rules.length === 0) {
        return { kind: 'default' }
    }
    return resolveBindingRules(rules, noteRuleFacts(path, source, rules))
}

/**
 * Whether a rule switches the plugin off for this note (plan §4b kill switch):
 * no rail, no menu items, no commands, no dispatch. Distinct from a privacy
 * exclusion (`isExcluded`, Business Rules #7), which is about note CONTENT
 * never reaching a backend and leaves the UI in place to say so.
 */
export function isPluginDisabledByRule(
    path: string,
    source: NoteFactsSource,
    settings: PluginSettingsV1
): boolean {
    return noteRuleOutcome(path, source, settings).kind === 'disabled'
}
