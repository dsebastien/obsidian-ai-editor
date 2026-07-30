import type { Verdict } from '../domain/operations/contract'

/**
 * Human labels for the wire verdict vocabulary.
 *
 * The wire tokens (`publish` / `needs-work` / `kill`) mirror the vault panels'
 * scorecards and are what the prompts instruct models to emit — but as a pill
 * next to an editor's name, "Publish" reads like an action button and "Kill" is
 * needlessly harsh, so the display says what the verdict MEANS for this note.
 *
 * Shared on purpose: an editor's verdict and a panel's recommendation are the
 * same vocabulary, and two relabelings would eventually disagree about what
 * `kill` is called.
 */
export function verdictLabel(verdict: Verdict): string {
    switch (verdict) {
        case 'publish':
            return 'All good'
        case 'needs-work':
            return 'Needs work'
        case 'kill':
            return 'Not ready'
    }
}
