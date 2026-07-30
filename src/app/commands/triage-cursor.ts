import type { TriageMemory } from './finding-navigation'

/**
 * Per-file triage cursor state (plan §0 stage D slice 1, design M4 keyboard
 * triage). One cursor per file: the finding the triage commands consider
 * "current". Pure in-memory bookkeeping — the stepping decisions live in
 * `finding-navigation.ts` (`triageStep`/`triageCurrent`); the controller
 * only stores what those functions need.
 *
 * Run identity: each cursor is validated against an opaque `runToken` (the
 * controller passes the `RunHandle` instance). A run replacement gives the
 * file a new token, so `get` with the fresh token evicts the stale cursor —
 * a new run has new finding ids and the old cursor must never leak into it.
 *
 * Lifecycle owned by the caller: `clear` on file delete/rename and on
 * Escape (the explicit "leave triage" gesture), `clearAll` on dispose.
 */
export class TriageCursorStore {
    private readonly byFile = new Map<string, { token: unknown; memory: TriageMemory }>()

    /**
     * The stored cursor for `filePath`, or `null` when none exists or the
     * stored one belongs to a different run (evicted on the spot).
     */
    get(filePath: string, runToken: unknown): TriageMemory | null {
        const entry = this.byFile.get(filePath)
        if (!entry) {
            return null
        }
        if (entry.token !== runToken) {
            this.byFile.delete(filePath)
            return null
        }
        return entry.memory
    }

    set(filePath: string, runToken: unknown, memory: TriageMemory): void {
        this.byFile.set(filePath, { token: runToken, memory })
    }

    /** Whether `filePath` currently carries a cursor (any run). */
    has(filePath: string): boolean {
        return this.byFile.has(filePath)
    }

    clear(filePath: string): void {
        this.byFile.delete(filePath)
    }

    clearAll(): void {
        this.byFile.clear()
    }
}
