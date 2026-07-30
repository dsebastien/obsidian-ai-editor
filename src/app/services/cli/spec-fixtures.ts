import { createAnchor } from '../../domain/anchoring/anchor'
import type { Anchor } from '../../domain/anchoring/anchor'
import { asFindingId, asRunId, generateId } from '../../domain/ids'
import { rawFindingSchema } from '../../domain/operations/contract'
import { createSnapshot } from '../../domain/snapshot'
import { FindingStore } from '../orchestration/finding-store'
import type {
    EditorRunState,
    PanelRunState,
    RunHandle,
    StartThreadTurnResult
} from '../orchestration/run-controller'

/**
 * Test-only fixture builders shared by the CLI subcommand specs (review,
 * cancel, status). Not a test file itself (bun only collects `*.spec.ts`),
 * never imported by production code. One `FakeRunHandle` on purpose: the
 * review and status specs must shape the SAME run fixture so the
 * cross-subcommand consistency specs compare like with like.
 */

export function makeState(overrides: Partial<EditorRunState> = {}): EditorRunState {
    return {
        editorId: 'editor-1',
        editorName: 'Hater',
        runId: asRunId(generateId()),
        status: 'done',
        findingIds: [],
        summary: null,
        verdict: null,
        lastProgress: null,
        error: null,
        continuing: false,
        continuationError: null,
        ...overrides
    }
}

export interface FindingFixture {
    readonly editorId: string
    readonly quote: string
    readonly critique: string
    readonly suggestion?: string
    readonly severity?: 'info' | 'suggestion' | 'warning'
    readonly anchor?: Anchor | null
}

export class FakeRunHandle implements RunHandle {
    readonly snapshot = createSnapshot({ filePath: 'Notes/Test.md', text: 'Hello world' })
    readonly findings = new FindingStore()
    readonly settled: Promise<void> = Promise.resolve()
    readonly panelSettled: Promise<void> = Promise.resolve()

    /** Number of `cancelRun` calls — lets specs pin cancel side effects. */
    cancelCount = 0

    private readonly settledFlag: boolean

    private readonly panelState: PanelRunState | null

    constructor(
        private readonly states: readonly EditorRunState[],
        findingFixtures: readonly FindingFixture[] = [],
        options: { readonly settled?: boolean; readonly panel?: PanelRunState } = {}
    ) {
        this.settledFlag = options.settled ?? true
        this.panelState = options.panel ?? null
        for (const fixture of findingFixtures) {
            this.findings.add({
                id: asFindingId(generateId()),
                runId: asRunId('run-1'),
                editorId: fixture.editorId,
                raw: rawFindingSchema.parse({
                    quote: fixture.quote,
                    critique: fixture.critique,
                    ...(fixture.suggestion === undefined ? {} : { suggestion: fixture.suggestion }),
                    ...(fixture.severity === undefined ? {} : { severity: fixture.severity })
                }),
                anchor: fixture.anchor === undefined ? createAnchor(0, 5) : fixture.anchor,
                anchoredText: fixture.anchor === null ? null : fixture.quote,
                matchStrategy: fixture.anchor === null ? null : 'exact'
            })
        }
    }

    getEditorStates(): readonly EditorRunState[] {
        return this.states
    }

    getEditorState(editorId: string): EditorRunState | null {
        return this.states.find((state) => state.editorId === editorId) ?? null
    }

    /** Solo by default; specs pass a `panel` fixture to shape a panel run. */
    getPanelState(): PanelRunState | null {
        return this.panelState
    }

    isSettled(): boolean {
        return this.settledFlag
    }

    isBusy(): boolean {
        const panel = this.panelState
        return (
            !this.settledFlag ||
            (panel !== null && (panel.status === 'waiting' || panel.status === 'running'))
        )
    }

    subscribe(): () => void {
        return () => undefined
    }

    cancelRun(): void {
        this.cancelCount += 1
    }

    applyTextChanges(): void {
        // no-op for the fixture
    }

    retryEditor(): { ok: false; reason: 'not-retryable' } {
        // CLI surfaces never retry (UI-only affordance); fixture refuses.
        return { ok: false, reason: 'not-retryable' }
    }

    continueEditor(): { ok: false; reason: 'not-continuable' } {
        // "Generate more" is a UI affordance too; fixture refuses.
        return { ok: false, reason: 'not-continuable' }
    }

    startThreadTurn(): StartThreadTurnResult {
        // CLI surfaces never push back (card-only affordance); fixture refuses.
        return { ok: false, reason: 'not-found' }
    }
}
