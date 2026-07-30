import type { BehaviorSettings, PanelConfig } from '../../domain/settings/settings-schema'
import { resolvePromptSourceText } from '../context/prompt-source-text'
import type { VaultReader } from '../context/vault-reader.intf'

/**
 * A panel's charter, resolved from the vault at dispatch time.
 *
 * ONE charter serves both halves of a panel run (plan M6): it is appended to
 * every member's system prompt as the panel's shared brief
 * (`augmentPanelCharter`), and it is the system prompt of the aggregation call
 * that produces the scorecard. Two fields — "brief for members" and
 * "instructions for the chairperson" — were considered and rejected: the
 * chairperson's mechanics (verdict per member, top fixes, dissent, never speak
 * for a missing member) are dictated by the `aggregate-panel` operation
 * contract and its prompt rules, not by the user, so a second user-facing field
 * would only be a place for the two halves of one panel to disagree about what
 * the panel is for.
 */

/**
 * The operation contract caps instruction-shaped payloads (`SHORT_TEXT_MAX` in
 * `operations/contract.ts`); referenced notes are truncated to fit. Same cap as
 * a custom action's instruction — both are directives, not budgeted context.
 */
export const PANEL_CHARTER_MAX_CHARS = 10_000

/**
 * Resolves a panel's charter prompt source: direct text first, then each
 * referenced note inlined as a `<charter-note>` block, read fresh (Business
 * Rules #8), follow-links honored, exclusions absolute (#7), truncated to
 * `PANEL_CHARTER_MAX_CHARS`.
 *
 * An empty charter is legitimate — a panel is a set of editors plus an
 * aggregation, and running one without a shared brief is a valid
 * configuration. Callers pass the result straight through; the augmentation
 * seams no-op on a blank string.
 */
export async function resolvePanelCharter(
    panel: PanelConfig,
    vault: VaultReader,
    behavior: BehaviorSettings
): Promise<string> {
    return resolvePromptSourceText(panel.charter, vault, behavior, {
        blockTag: 'charter-note',
        maxChars: PANEL_CHARTER_MAX_CHARS
    })
}
