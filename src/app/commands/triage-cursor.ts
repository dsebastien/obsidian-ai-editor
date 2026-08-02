import { deleteKeysUnder } from '../domain/path-scope'
import type { TriageMemory } from './finding-navigation'

/**
 * Per-file triage cursor state (Architecture.md § Triage surfaces, design M4 keyboard
 * triage). One cursor per file: the finding the triage commands consider
 * "current". Pure in-memory bookkeeping — the stepping decisions live in
 * `finding-navigation.ts` (`triageStep`/`triageCurrent`); the controller
 * only stores what those functions need.
 *
 * Run identity: each cursor carries an opaque `runToken` (the controller
 * passes the `RunHandle` instance). A run replacement gives the file a new
 * token; `get` with the fresh token RE-BINDS the cursor to it rather than
 * evicting (issue #19): carryover keeps finding ids alive across runs, so a
 * mid-triage refresh must not reset the user's position. When the cursor's
 * finding did NOT survive, nothing leaks — `triageCurrent` matches by id
 * against the live target set and reports no current, and `triageStep` falls
 * back to the recorded offset, exactly the degradation an evicted cursor
 * produced.
 *
 * Lifecycle owned by the caller: `clear` on file delete/rename and on
 * Escape (the explicit "leave triage" gesture), `clearAll` on dispose.
 */
export class TriageCursorStore {
    private readonly byFile = new Map<string, { token: unknown; memory: TriageMemory }>()

    /**
     * The stored cursor for `filePath`, or `null` when none exists. A cursor
     * recorded under a previous run is re-bound to `runToken` (see above).
     */
    get(filePath: string, runToken: unknown): TriageMemory | null {
        const entry = this.byFile.get(filePath)
        if (!entry) {
            return null
        }
        if (entry.token !== runToken) {
            this.byFile.set(filePath, { token: runToken, memory: entry.memory })
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

    /**
     * `clear` for a path AND everything under it — a FOLDER rename or delete,
     * which Obsidian reports without per-child events.
     */
    clearUnder(path: string): void {
        deleteKeysUnder(this.byFile, path)
    }

    clearAll(): void {
        this.byFile.clear()
    }
}
