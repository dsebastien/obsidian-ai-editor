/**
 * Counts consecutive daemon refreshes in which EVERY editor failed and says
 * when the unattended loop must stop (issue #23). Pure — the
 * `DaemonController` feeds it settled run states and acts on the verdict.
 *
 * Plugin-wide rather than per file: the failure mode that matters here (dead
 * key, exhausted quota) is backend-wide, and an unattended loop that keeps
 * billing a broken backend must stop wherever it fires. Any refresh with at
 * least one successful editor resets the streak — partial value delivered is
 * a working loop. A refresh with only `cancelled` editors is the user (or a
 * summon replacing the run) acting, not the backend failing: it neither
 * counts nor resets.
 */

/** Consecutive fully-failed refreshes that switch daemon mode off. */
export const DAEMON_DISABLE_AFTER = 3

export interface RefreshEditorOutcome {
    readonly status: string
}

export type RefreshVerdict = 'continue' | 'disable'

export class DaemonFailureTracker {
    private streak = 0

    /** Records one settled daemon-dispatched refresh. */
    record(states: readonly RefreshEditorOutcome[]): RefreshVerdict {
        if (states.length === 0) {
            return 'continue'
        }
        if (states.some((state) => state.status === 'done')) {
            this.streak = 0
            return 'continue'
        }
        if (!states.some((state) => state.status === 'error')) {
            return 'continue' // all cancelled: the user acted, not the backend
        }
        this.streak += 1
        if (this.streak < DAEMON_DISABLE_AFTER) {
            return 'continue'
        }
        this.streak = 0
        return 'disable'
    }

    /** The mode was toggled (either way): the streak starts over. */
    reset(): void {
        this.streak = 0
    }
}
