import type { Anchor, TextChange } from '../../domain/anchoring/anchor'
import { createAnchor, mapAnchorThroughChanges } from '../../domain/anchoring/anchor'
import type { MatchStrategy } from '../../domain/anchoring/match'
import { matchQuote } from '../../domain/anchoring/match'
import type { FindingId, RunId } from '../../domain/ids'
import { asFindingId, asRunId, generateId } from '../../domain/ids'
import type {
    OperationEvent,
    RawFinding,
    ReviewRequest,
    Verdict
} from '../../domain/operations/contract'
import { CONTRACT_VERSION } from '../../domain/operations/contract'
import type { DocumentSnapshot } from '../../domain/snapshot'
import { FindingStore } from './finding-store'

/**
 * Review-run orchestration: consumes backend event streams for one snapshot,
 * enforces the event protocol (run-id matching, exactly-once terminal),
 * anchors findings, and maintains per-editor status — all Obsidian-free and
 * backend-agnostic (backends are injected as `execute` functions).
 *
 * Protocol enforcement (see the operation contract):
 * - Events carrying a foreign runId are discarded.
 * - Events after the terminal event (result/error/cancel) are discarded.
 * - A stream that ends without a terminal event is a protocol violation and
 *   surfaces as an `invalid-output` error, never as silent success.
 */

export type EditorRunStatus = 'pending' | 'running' | 'done' | 'error' | 'cancelled'

export type OperationErrorInfo = Extract<OperationEvent, { type: 'error' }>['error']

/** One editor persona participating in a run, with its backend injected. */
export interface RunEditorSpec {
    readonly editorId: string
    readonly editorName: string
    /**
     * Redacts secrets (API keys…) from an error message before it becomes
     * user-visible run state (Business Rules #12). The backend bridge knows
     * the configured secrets and MUST inject this (e.g. `redactSecret` bound
     * to the backend's API key) — provider 401 bodies can echo the submitted
     * key back. Identity when omitted (secret-free backends only).
     */
    readonly redactError?: (message: string) => string
    readonly execute: (request: ReviewRequest, signal: AbortSignal) => AsyncIterable<OperationEvent>
}

export interface StartRunInput {
    readonly snapshot: DocumentSnapshot
    readonly editors: readonly RunEditorSpec[]
}

/** Immutable view of one editor's progress within a run. */
export interface EditorRunState {
    readonly editorId: string
    readonly editorName: string
    readonly runId: RunId
    readonly status: EditorRunStatus
    /** Finding ids in arrival order; resolve via the run's `findings` store. */
    readonly findingIds: readonly FindingId[]
    readonly summary: string | null
    readonly verdict: Verdict | null
    readonly lastProgress: string | null
    readonly error: OperationErrorInfo | null
}

/** Handle over one review run (one snapshot, N editors). */
export interface RunHandle {
    readonly snapshot: DocumentSnapshot
    /** Finding state machine for this run (statuses, accept preconditions). */
    readonly findings: FindingStore
    /** Resolves when every editor stream has reached a terminal state. */
    readonly settled: Promise<void>
    getEditorStates(): readonly EditorRunState[]
    getEditorState(editorId: string): EditorRunState | null
    /** Whether every editor has reached a terminal status. */
    isSettled(): boolean
    subscribe(listener: () => void): () => void
    /** Aborts all in-flight editor streams; late events are discarded. */
    cancelRun(): void
    /** Remaps every anchored finding through user edits (stale per BR #3). */
    applyTextChanges(changes: readonly TextChange[]): void
}

interface InternalEditorState {
    readonly editorId: string
    readonly editorName: string
    readonly runId: RunId
    status: EditorRunStatus
    findingIds: FindingId[]
    summary: string | null
    verdict: Verdict | null
    lastProgress: string | null
    error: OperationErrorInfo | null
    /** True once a terminal event was processed; later events are discarded. */
    terminal: boolean
    /** Content keys of ingested findings, deduping stream vs result payloads. */
    seenFindingKeys: Set<string>
}

class ReviewRunHandle implements RunHandle {
    readonly snapshot: DocumentSnapshot
    readonly findings: FindingStore
    readonly settled: Promise<void>

    private readonly abort = new AbortController()
    private readonly listeners = new Set<() => void>()
    private readonly states = new Map<string, InternalEditorState>()
    /**
     * Every user-edit batch applied since the run started, in application
     * order (each batch expressed in the coordinates of the document it was
     * applied to). Findings arriving AFTER an edit are anchored against the
     * snapshot and then replayed through this history so they land in
     * current-document coordinates — without the replay, a late finding
     * would carry snapshot coordinates while claiming to be anchored, and
     * Accept could pass its precondition against the wrong text occurrence
     * (Business Rules #3/#4).
     */
    private readonly appliedChanges: TextChange[][] = []
    private settledFlag = false

    constructor(input: StartRunInput) {
        this.snapshot = input.snapshot
        this.findings = new FindingStore(() => this.notify())

        for (const spec of input.editors) {
            if (this.states.has(spec.editorId)) {
                throw new Error(`Duplicate editorId in run: ${spec.editorId}`)
            }
            this.states.set(spec.editorId, {
                editorId: spec.editorId,
                editorName: spec.editorName,
                runId: asRunId(generateId()),
                status: 'pending',
                findingIds: [],
                summary: null,
                verdict: null,
                lastProgress: null,
                error: null,
                terminal: false,
                seenFindingKeys: new Set()
            })
        }

        const loops = input.editors.map((spec) => this.consume(spec))
        this.settled = Promise.allSettled(loops).then(() => {
            this.settledFlag = true
        })
    }

    getEditorStates(): readonly EditorRunState[] {
        return [...this.states.values()].map((state) => toPublicState(state))
    }

    getEditorState(editorId: string): EditorRunState | null {
        const state = this.states.get(editorId)
        return state ? toPublicState(state) : null
    }

    isSettled(): boolean {
        return this.settledFlag
    }

    subscribe(listener: () => void): () => void {
        this.listeners.add(listener)
        return () => {
            this.listeners.delete(listener)
        }
    }

    cancelRun(): void {
        if (this.abort.signal.aborted) {
            return
        }
        this.abort.abort()
        for (const state of this.states.values()) {
            if (!state.terminal) {
                state.terminal = true
                state.status = 'cancelled'
            }
        }
        this.notify()
    }

    applyTextChanges(changes: readonly TextChange[]): void {
        if (changes.length === 0) {
            return
        }
        this.appliedChanges.push([...changes])
        this.findings.applyTextChanges(changes)
    }

    private async consume(spec: RunEditorSpec): Promise<void> {
        const state = this.states.get(spec.editorId)
        if (!state || state.terminal) {
            return
        }
        const request: ReviewRequest = {
            kind: 'review',
            contractVersion: CONTRACT_VERSION,
            runId: state.runId,
            snapshotHash: this.snapshot.hash,
            text: this.snapshot.text,
            ...(this.snapshot.selection ? { selection: { ...this.snapshot.selection } } : {})
        }
        state.status = 'running'
        this.notify()
        try {
            for await (const event of spec.execute(request, this.abort.signal)) {
                if (state.terminal) {
                    continue // post-terminal or post-cancel: discard
                }
                if (event.runId !== state.runId) {
                    continue // foreign run: discard
                }
                this.handleEvent(spec, state, event)
            }
        } catch (cause) {
            if (!state.terminal) {
                if (this.abort.signal.aborted) {
                    this.terminate(state, 'cancelled', null)
                } else {
                    this.terminate(state, 'error', {
                        code: 'unknown',
                        message: redactMessage(
                            spec,
                            cause instanceof Error ? cause.message : String(cause)
                        )
                    })
                }
            }
        }
        if (!state.terminal) {
            if (this.abort.signal.aborted) {
                this.terminate(state, 'cancelled', null)
            } else {
                this.terminate(state, 'error', {
                    code: 'invalid-output',
                    message: 'Stream ended without a terminal event'
                })
            }
        }
    }

    private handleEvent(
        spec: RunEditorSpec,
        state: InternalEditorState,
        event: OperationEvent
    ): void {
        switch (event.type) {
            case 'progress':
                state.lastProgress = event.message ?? null
                this.notify()
                return
            case 'finding':
                this.ingestFinding(spec, state, event.finding)
                return
            case 'result':
                if (event.result.kind !== 'review') {
                    this.terminate(state, 'error', {
                        code: 'invalid-output',
                        message: `Expected a review result, got '${event.result.kind}'`
                    })
                    return
                }
                for (const raw of event.result.findings) {
                    this.ingestFinding(spec, state, raw)
                }
                state.summary = event.result.summary ?? null
                state.verdict = event.result.verdict ?? null
                this.terminate(state, 'done', null)
                return
            case 'error':
                if (event.error.code === 'cancelled') {
                    this.terminate(state, 'cancelled', null)
                } else {
                    this.terminate(state, 'error', {
                        code: event.error.code,
                        message: redactMessage(spec, event.error.message)
                    })
                }
                return
        }
    }

    /**
     * Anchors a raw finding against the snapshot and registers it. Ambiguous
     * or unmatched quotes yield an unanchored (display-only) finding — never
     * a guessed position (Business Rules #4). The fresh anchor (snapshot
     * coordinates) is replayed through every edit applied since the run
     * started, so a finding arriving mid-edit is either remapped to current
     * coordinates or marked stale — never left on stale snapshot offsets.
     * Findings arriving both as stream events and inside the terminal result
     * are deduped by content.
     */
    private ingestFinding(spec: RunEditorSpec, state: InternalEditorState, raw: RawFinding): void {
        const key = JSON.stringify([raw.quote, raw.critique, raw.suggestion ?? ''])
        if (state.seenFindingKeys.has(key)) {
            return
        }
        state.seenFindingKeys.add(key)

        const match = matchQuote(this.snapshot.text, raw.quote, {
            prefix: raw.prefix,
            suffix: raw.suffix,
            occurrence: raw.occurrence
        })
        let anchor: Anchor | null = null
        let anchoredText: string | null = null
        let matchStrategy: MatchStrategy | null = null
        if (match.status === 'matched') {
            anchor = createAnchor(match.match.from, match.match.to)
            anchoredText = this.snapshot.text.slice(match.match.from, match.match.to)
            matchStrategy = match.match.strategy
            for (const batch of this.appliedChanges) {
                anchor = mapAnchorThroughChanges(anchor, batch)
            }
        }

        const id = asFindingId(generateId())
        state.findingIds.push(id)
        // `add` fires the store's onChange, which notifies subscribers.
        this.findings.add({
            id,
            runId: state.runId,
            editorId: spec.editorId,
            raw,
            anchor,
            anchoredText,
            matchStrategy
        })
    }

    private terminate(
        state: InternalEditorState,
        status: EditorRunStatus,
        error: OperationErrorInfo | null
    ): void {
        state.terminal = true
        state.status = status
        state.error = error
        this.notify()
    }

    private notify(): void {
        for (const listener of [...this.listeners]) {
            try {
                listener()
            } catch {
                // A faulty subscriber must never break orchestration.
            }
        }
    }
}

/**
 * Routes an outbound error message through the editor's redaction seam so
 * secret material embedded in transport/provider errors never reaches
 * user-visible state (Business Rules #12).
 */
function redactMessage(spec: RunEditorSpec, message: string): string {
    return spec.redactError ? spec.redactError(message) : message
}

function toPublicState(state: InternalEditorState): EditorRunState {
    return {
        editorId: state.editorId,
        editorName: state.editorName,
        runId: state.runId,
        status: state.status,
        findingIds: [...state.findingIds],
        summary: state.summary,
        verdict: state.verdict,
        lastProgress: state.lastProgress,
        error: state.error
    }
}

/**
 * Manages review runs per file: at most one active run per file path.
 * Starting a new run for a file cancels the previous one (its late events
 * are discarded by the cancelled handle).
 */
export class RunController {
    private readonly runs = new Map<string, RunHandle>()

    startRun(input: StartRunInput): RunHandle {
        const existing = this.runs.get(input.snapshot.filePath)
        if (existing) {
            existing.cancelRun()
        }
        const run = new ReviewRunHandle(input)
        this.runs.set(input.snapshot.filePath, run)
        return run
    }

    /** The current (possibly settled) run for a file, if any. */
    getRun(filePath: string): RunHandle | null {
        return this.runs.get(filePath) ?? null
    }

    /** Cancels every active run (e.g. on plugin unload). */
    cancelAll(): void {
        for (const run of this.runs.values()) {
            run.cancelRun()
        }
    }
}
