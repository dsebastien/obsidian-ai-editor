import { describe, expect, it } from 'bun:test'
import { asFindingId } from '../../domain/ids'
import { createSnapshot } from '../../domain/snapshot'
import type {
    OperationEvent,
    OperationResult,
    RawFinding,
    ReviewRequest,
    ThreadTurnRequest
} from '../../domain/operations/contract'
import { CONTRACT_VERSION } from '../../domain/operations/contract'
import { RunController, type RunEditorSpec } from './run-controller'

const DOC = 'The quick brown fox jumps over the lazy dog. The fox is fast.'

function snapshot(text = DOC, selection?: { from: number; to: number }) {
    return createSnapshot({ filePath: 'notes/test.md', text, ...(selection ? { selection } : {}) })
}

function raw(overrides: Partial<RawFinding> = {}): RawFinding {
    return {
        quote: 'quick brown',
        critique: 'Too generic',
        edits: [{ op: 'replace', text: 'swift auburn' }],
        invalidProposal: false,
        severity: 'suggestion',
        evidence: [],
        ...overrides
    }
}

function finding(runId: string, rawFinding: RawFinding): OperationEvent {
    return { type: 'finding', runId, finding: rawFinding }
}

function result(runId: string, findings: RawFinding[], summary?: string): OperationEvent {
    return {
        type: 'result',
        runId,
        result: {
            kind: 'review',
            findings,
            ...(summary !== undefined ? { summary } : {})
        }
    }
}

/** Editor whose stream is fully described by a script of events per runId. */
function scriptedEditor(
    editorId: string,
    script: (runId: string) => OperationEvent[]
): RunEditorSpec {
    return {
        editorId,
        editorName: `Editor ${editorId}`,
        execute: async function* (request) {
            await Promise.resolve() // detach from the synchronous start
            yield* script(request.runId)
        }
    }
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
    let resolve: () => void = () => undefined
    const promise = new Promise<void>((res) => {
        resolve = res
    })
    return { promise, resolve }
}

describe('RunController happy path', () => {
    it('runs multiple editors, anchors findings, and reports per-editor state', async () => {
        const controller = new RunController()
        const snap = snapshot()
        const seenRequests: ReviewRequest[] = []
        const alpha: RunEditorSpec = {
            editorId: 'alpha',
            editorName: 'Alpha',
            execute: async function* (request) {
                seenRequests.push(request)
                yield finding(request.runId, raw())
                yield result(request.runId, [], 'Alpha summary')
            }
        }
        const beta = scriptedEditor('beta', (runId) => [
            finding(
                runId,
                raw({
                    quote: 'lazy dog',
                    critique: 'Cliché',
                    edits: [{ op: 'replace', text: 'idle hound' }]
                })
            ),
            result(runId, [])
        ])

        const run = controller.startRun({ snapshot: snap, editors: [alpha, beta] })
        await run.settled

        expect(run.isSettled()).toBeTrue()
        const states = run.getEditorStates()
        expect(states).toHaveLength(2)
        expect(states.every((state) => state.status === 'done')).toBeTrue()

        // Request shape: contract version + snapshot binding.
        const request = seenRequests[0]
        expect(request?.contractVersion).toEqual(CONTRACT_VERSION)
        expect(request?.snapshotHash).toEqual(snap.hash)
        expect(request?.text).toEqual(DOC)
        expect(request?.selection).toBeUndefined()

        // Per-editor runIds are distinct.
        const [first, second] = states
        expect(first?.runId).not.toEqual(second?.runId)

        // Findings are anchored exactly and attributed per editor.
        const alphaFindings = run.findings.listByEditor('alpha')
        expect(alphaFindings).toHaveLength(1)
        expect(alphaFindings[0]?.anchor).toEqual({ from: 4, to: 15, state: 'anchored' })
        expect(alphaFindings[0]?.anchoredText).toEqual('quick brown')
        expect(alphaFindings[0]?.matchStrategy).toEqual('exact')
        const betaFindings = run.findings.listByEditor('beta')
        expect(betaFindings).toHaveLength(1)
        expect(run.getEditorState('alpha')?.findingIds).toEqual([alphaFindings[0]!.id])
        expect(run.getEditorState('alpha')?.summary).toEqual('Alpha summary')
    })

    it('ingests buffered result findings and dedupes streamed duplicates', async () => {
        const controller = new RunController()
        const streamedAndBuffered = raw()
        const bufferedOnly = raw({ quote: 'lazy dog', critique: 'Other', edits: [] })
        const editor = scriptedEditor('buffered', (runId) => [
            finding(runId, streamedAndBuffered),
            result(runId, [streamedAndBuffered, bufferedOnly])
        ])
        const run = controller.startRun({ snapshot: snapshot(), editors: [editor] })
        await run.settled
        expect(run.findings.list()).toHaveLength(2)
    })

    it('keeps findings on different occurrences of the same quote distinct', async () => {
        // DOC contains "fox" twice; same critique on occurrence 0 and 1 are
        // two legitimate findings — the dedupe key must include the hints.
        const first = raw({
            quote: 'fox',
            critique: 'Overused',
            edits: [],
            occurrence: 0
        })
        const second = raw({
            quote: 'fox',
            critique: 'Overused',
            edits: [],
            occurrence: 1
        })
        const editor = scriptedEditor('occ', (runId) => [
            finding(runId, first),
            finding(runId, second),
            result(runId, [first, second])
        ])
        const run = new RunController().startRun({ snapshot: snapshot(), editors: [editor] })
        await run.settled
        const findings = run.findings.list()
        expect(findings).toHaveLength(2)
        const anchors = findings.map((f) => f.anchor?.from).sort((a, b) => (a ?? 0) - (b ?? 0))
        expect(anchors[0]).not.toEqual(anchors[1])
    })

    it('propagates the snapshot selection into the request', async () => {
        const controller = new RunController()
        let seen: ReviewRequest | null = null
        const editor: RunEditorSpec = {
            editorId: 'sel',
            editorName: 'Sel',
            execute: async function* (request) {
                seen = request
                yield result(request.runId, [])
            }
        }
        const run = controller.startRun({
            snapshot: snapshot(DOC, { from: 4, to: 15 }),
            editors: [editor]
        })
        await run.settled
        expect(seen).not.toBeNull()
        expect(seen!.selection).toEqual({ from: 4, to: 15 })
    })

    it('rejects duplicate editor ids upfront', () => {
        const controller = new RunController()
        const make = () => scriptedEditor('dup', (runId) => [result(runId, [])])
        expect(() =>
            controller.startRun({ snapshot: snapshot(), editors: [make(), make()] })
        ).toThrow('Duplicate editorId')
    })
})

describe('RunController cancellation', () => {
    it('cancels mid-stream, aborts the signal, and discards late events', async () => {
        const controller = new RunController()
        const gate = deferred()
        let observedSignal: AbortSignal | null = null
        const editor: RunEditorSpec = {
            editorId: 'slow',
            editorName: 'Slow',
            execute: async function* (request, signal) {
                observedSignal = signal
                yield finding(request.runId, raw())
                await gate.promise
                // Late events after cancellation must be discarded.
                yield finding(request.runId, raw({ quote: 'lazy dog', critique: 'Late' }))
                yield result(request.runId, [], 'late summary')
            }
        }
        const run = controller.startRun({ snapshot: snapshot(), editors: [editor] })
        // Let the first finding land (a few turns: the concurrency-gate
        // acquire adds one microtask before the stream starts).
        for (let i = 0; i < 5; i++) {
            await Promise.resolve()
        }
        expect(run.findings.list()).toHaveLength(1)

        run.cancelRun()
        expect(observedSignal).not.toBeNull()
        expect(observedSignal!.aborted).toBeTrue()
        expect(run.getEditorState('slow')?.status).toEqual('cancelled')

        gate.resolve()
        await run.settled
        // Late finding + result were discarded; status stayed cancelled.
        expect(run.findings.list()).toHaveLength(1)
        expect(run.getEditorState('slow')?.status).toEqual('cancelled')
        expect(run.getEditorState('slow')?.summary).toBeNull()
    })

    it('treats a stream aborting via throw after cancel as cancelled, not error', async () => {
        const controller = new RunController()
        const gate = deferred()
        const editor: RunEditorSpec = {
            editorId: 'throwing',
            editorName: 'Throwing',
            execute: async function* (request, signal) {
                yield finding(request.runId, raw())
                await gate.promise
                if (signal.aborted) {
                    throw new Error('aborted')
                }
            }
        }
        const run = controller.startRun({ snapshot: snapshot(), editors: [editor] })
        await Promise.resolve()
        await Promise.resolve()
        run.cancelRun()
        gate.resolve()
        await run.settled
        expect(run.getEditorState('throwing')?.status).toEqual('cancelled')
        expect(run.getEditorState('throwing')?.error).toBeNull()
    })

    it('starting a new run for the same file cancels the previous one', async () => {
        const controller = new RunController()
        const gate = deferred()
        const hanging: RunEditorSpec = {
            editorId: 'hang',
            editorName: 'Hang',
            execute: async function* (request) {
                yield finding(request.runId, raw())
                await gate.promise
            }
        }
        const first = controller.startRun({ snapshot: snapshot(), editors: [hanging] })
        await Promise.resolve()
        const second = controller.startRun({
            snapshot: snapshot(),
            editors: [scriptedEditor('quick', (runId) => [result(runId, [])])]
        })
        expect(first.getEditorState('hang')?.status).toEqual('cancelled')
        expect(controller.getRun('notes/test.md')).toBe(second)
        gate.resolve()
        await first.settled
        await second.settled
        expect(second.getEditorState('quick')?.status).toEqual('done')
    })
})

describe('RunController event protocol', () => {
    it('discards events carrying a foreign runId', async () => {
        const controller = new RunController()
        const editor = scriptedEditor('strict', (runId) => [
            finding('some-other-run', raw({ quote: 'lazy dog', critique: 'Foreign' })),
            { type: 'error', runId: 'some-other-run', error: { code: 'unknown', message: 'x' } },
            result(runId, [raw()])
        ])
        const run = controller.startRun({ snapshot: snapshot(), editors: [editor] })
        await run.settled
        expect(run.getEditorState('strict')?.status).toEqual('done')
        expect(run.findings.list()).toHaveLength(1)
        expect(run.findings.list()[0]?.raw.quote).toEqual('quick brown')
    })

    it('processes exactly one terminal event and discards the rest', async () => {
        const controller = new RunController()
        const editor = scriptedEditor('double', (runId) => [
            result(runId, [], 'first summary'),
            result(runId, [raw()], 'second summary'),
            finding(runId, raw({ quote: 'lazy dog', critique: 'Post-terminal' })),
            { type: 'error', runId, error: { code: 'network', message: 'boom' } }
        ])
        const run = controller.startRun({ snapshot: snapshot(), editors: [editor] })
        await run.settled
        const state = run.getEditorState('double')
        expect(state?.status).toEqual('done')
        expect(state?.summary).toEqual('first summary')
        expect(state?.error).toBeNull()
        expect(run.findings.list()).toHaveLength(0)
    })

    it('surfaces error events with their code', async () => {
        const controller = new RunController()
        const editor = scriptedEditor('failing', (runId) => [
            { type: 'error', runId, error: { code: 'rate-limit', message: 'slow down' } }
        ])
        const run = controller.startRun({ snapshot: snapshot(), editors: [editor] })
        await run.settled
        const state = run.getEditorState('failing')
        expect(state?.status).toEqual('error')
        expect(state?.error).toEqual({ code: 'rate-limit', message: 'slow down' })
    })

    it('maps a cancelled error event to cancelled status', async () => {
        const controller = new RunController()
        const editor = scriptedEditor('self-cancel', (runId) => [
            { type: 'error', runId, error: { code: 'cancelled', message: 'user cancelled' } }
        ])
        const run = controller.startRun({ snapshot: snapshot(), editors: [editor] })
        await run.settled
        expect(run.getEditorState('self-cancel')?.status).toEqual('cancelled')
    })

    it('flags a stream ending without a terminal event as invalid-output', async () => {
        const controller = new RunController()
        const editor = scriptedEditor('truncated', (runId) => [finding(runId, raw())])
        const run = controller.startRun({ snapshot: snapshot(), editors: [editor] })
        await run.settled
        const state = run.getEditorState('truncated')
        expect(state?.status).toEqual('error')
        expect(state?.error?.code).toEqual('invalid-output')
    })

    it('flags a non-review result as invalid-output', async () => {
        const controller = new RunController()
        const editor: RunEditorSpec = {
            editorId: 'wrong-kind',
            editorName: 'Wrong kind',
            execute: async function* (request) {
                yield {
                    type: 'result',
                    runId: request.runId,
                    result: { kind: 'insert-at', insertion: 'nope', evidence: [] }
                }
            }
        }
        const run = controller.startRun({ snapshot: snapshot(), editors: [editor] })
        await run.settled
        expect(run.getEditorState('wrong-kind')?.error?.code).toEqual('invalid-output')
    })

    it('turns a throwing stream into an unknown error', async () => {
        const controller = new RunController()
        const editor: RunEditorSpec = {
            editorId: 'crashing',
            editorName: 'Crashing',
            execute: async function* (request) {
                yield { type: 'progress', runId: request.runId }
                throw new Error('backend exploded')
            }
        }
        const run = controller.startRun({ snapshot: snapshot(), editors: [editor] })
        await run.settled
        const state = run.getEditorState('crashing')
        expect(state?.status).toEqual('error')
        expect(state?.error).toEqual({ code: 'unknown', message: 'backend exploded' })
    })

    it('redacts secrets from thrown transport errors before they reach run state', async () => {
        const controller = new RunController()
        const editor: RunEditorSpec = {
            editorId: 'leaky-throw',
            editorName: 'Leaky throw',
            redactError: (message) => message.split('sk-secret-123').join('[redacted]'),
            execute: async function* (request) {
                yield { type: 'progress', runId: request.runId }
                throw new Error('401 Incorrect API key provided: sk-secret-123')
            }
        }
        const run = controller.startRun({ snapshot: snapshot(), editors: [editor] })
        await run.settled
        const state = run.getEditorState('leaky-throw')
        expect(state?.error?.message).not.toContain('sk-secret-123')
        expect(state?.error?.message).toContain('[redacted]')
    })

    it('redacts secrets from error events before they reach run state', async () => {
        const controller = new RunController()
        const editor: RunEditorSpec = {
            editorId: 'leaky-event',
            editorName: 'Leaky event',
            redactError: (message) => message.split('sk-secret-123').join('[redacted]'),
            execute: async function* (request) {
                yield {
                    type: 'error',
                    runId: request.runId,
                    error: { code: 'auth', message: 'denied for key sk-secret-123' }
                }
            }
        }
        const run = controller.startRun({ snapshot: snapshot(), editors: [editor] })
        await run.settled
        const state = run.getEditorState('leaky-event')
        expect(state?.status).toEqual('error')
        expect(state?.error?.message).not.toContain('sk-secret-123')
    })

    it('records progress messages', async () => {
        const controller = new RunController()
        const editor = scriptedEditor('progressing', (runId) => [
            { type: 'progress', runId, message: 'thinking…' },
            result(runId, [])
        ])
        const run = controller.startRun({ snapshot: snapshot(), editors: [editor] })
        await run.settled
        expect(run.getEditorState('progressing')?.lastProgress).toEqual('thinking…')
    })
})

describe('RunController anchoring outcomes', () => {
    it('keeps ambiguous quotes unanchored (display-only)', async () => {
        const controller = new RunController()
        // "The " appears twice with identical neighborhoods → ambiguous.
        const editor = scriptedEditor('ambiguous', (runId) => [
            result(runId, [raw({ quote: 'The', edits: [{ op: 'replace', text: 'A' }] })])
        ])
        const run = controller.startRun({ snapshot: snapshot(), editors: [editor] })
        await run.settled
        const tracked = run.findings.list()[0]
        expect(tracked?.anchor).toBeNull()
        expect(tracked?.matchStrategy).toBeNull()
        expect(run.findings.accept(tracked!.id, DOC)).toEqual({
            ok: false,
            reason: 'unanchored'
        })
    })

    it('disambiguates repeated quotes via hints', async () => {
        const controller = new RunController()
        const editor = scriptedEditor('hinted', (runId) => [
            result(runId, [
                raw({ quote: 'The', prefix: 'lazy dog. ', edits: [{ op: 'replace', text: 'A' }] }),
                raw({
                    quote: 'fox',
                    occurrence: 1,
                    critique: 'Second fox',
                    edits: [{ op: 'replace', text: 'vixen' }]
                })
            ])
        ])
        const run = controller.startRun({ snapshot: snapshot(), editors: [editor] })
        await run.settled
        const [prefixed, indexed] = run.findings.list()
        expect(prefixed?.anchor).toEqual({ from: 45, to: 48, state: 'anchored' })
        expect(indexed?.anchor).toEqual({ from: 49, to: 52, state: 'anchored' })
    })

    it('keeps unmatched quotes unanchored', async () => {
        const controller = new RunController()
        const editor = scriptedEditor('nomatch', (runId) => [
            result(runId, [raw({ quote: 'this text does not exist' })])
        ])
        const run = controller.startRun({ snapshot: snapshot(), editors: [editor] })
        await run.settled
        expect(run.findings.list()[0]?.anchor).toBeNull()
    })
})

describe('RunController edits & acceptance', () => {
    it('remaps anchors through edits and stales intersecting findings', async () => {
        const controller = new RunController()
        const editor = scriptedEditor('editing', (runId) => [
            result(runId, [
                raw(), // "quick brown" [4, 15)
                raw({
                    quote: 'lazy dog',
                    critique: 'Cliché',
                    edits: [{ op: 'replace', text: 'idle hound' }]
                }) // [35, 43)
            ])
        ])
        const run = controller.startRun({ snapshot: snapshot(), editors: [editor] })
        await run.settled

        // Edit inside "quick brown", plus an insertion before "lazy dog".
        run.applyTextChanges([
            { from: 5, to: 6, insertedLength: 3 },
            { from: 20, to: 20, insertedLength: 5 }
        ])
        const [staled, shifted] = run.findings.list()
        expect(staled?.anchor?.state).toEqual('stale')
        expect(shifted?.anchor).toEqual({ from: 42, to: 50, state: 'anchored' })

        // Stale finding cannot be accepted (Business Rules #3).
        expect(run.findings.accept(staled!.id, DOC)).toEqual({
            ok: false,
            reason: 'stale-proposal'
        })

        // The shifted finding accepts against the post-edit document.
        const edited = `${DOC.slice(0, 5)}XYZ${DOC.slice(6, 20)}ABCDE${DOC.slice(20)}`
        expect(run.findings.accept(shifted!.id, edited).ok).toBeTrue()
    })

    it('remaps findings that arrive AFTER the user edited (never raw snapshot coordinates)', async () => {
        const controller = new RunController()
        const gate = deferred()
        const editor: RunEditorSpec = {
            editorId: 'late',
            editorName: 'Late',
            execute: async function* (request) {
                await gate.promise
                // Arrives after the edits below: quote 'lazy dog' is [35, 43)
                // in the snapshot but must be stored in CURRENT coordinates.
                yield result(request.runId, [
                    raw({
                        quote: 'lazy dog',
                        critique: 'Cliché',
                        edits: [{ op: 'replace', text: 'idle hound' }]
                    })
                ])
            }
        }
        const run = controller.startRun({ snapshot: snapshot(), editors: [editor] })
        // Two separate edit batches before the finding lands: delete 'The '
        // at the start, then insert 5 chars at (post-edit) offset 20.
        run.applyTextChanges([{ from: 0, to: 4, insertedLength: 0 }])
        run.applyTextChanges([{ from: 20, to: 20, insertedLength: 5 }])
        gate.resolve()
        await run.settled

        const tracked = run.findings.list()[0]
        expect(tracked?.anchor).toEqual({ from: 36, to: 44, state: 'anchored' })
        const edited = `${DOC.slice(4, 24)}ABCDE${DOC.slice(24)}`
        expect(run.findings.accept(tracked!.id, edited).ok).toBeTrue()
    })

    it('stales a late-arriving finding whose range was edited while streaming', async () => {
        const controller = new RunController()
        const gate = deferred()
        const editor: RunEditorSpec = {
            editorId: 'late-stale',
            editorName: 'Late stale',
            execute: async function* (request) {
                await gate.promise
                yield result(request.runId, [raw()]) // 'quick brown' [4, 15)
            }
        }
        const run = controller.startRun({ snapshot: snapshot(), editors: [editor] })
        run.applyTextChanges([{ from: 5, to: 7, insertedLength: 0 }])
        gate.resolve()
        await run.settled

        const tracked = run.findings.list()[0]
        expect(tracked?.anchor?.state).toEqual('stale')
        expect(run.findings.isActionable(tracked!.id)).toBeFalse()
        const edited = `${DOC.slice(0, 5)}${DOC.slice(7)}`
        expect(run.findings.accept(tracked!.id, edited)).toEqual({
            ok: false,
            reason: 'stale-proposal'
        })
    })

    it('blocks acceptance when the current text no longer matches', async () => {
        const controller = new RunController()
        const editor = scriptedEditor('precondition', (runId) => [result(runId, [raw()])])
        const run = controller.startRun({ snapshot: snapshot(), editors: [editor] })
        await run.settled
        const tracked = run.findings.list()[0]
        const rewritten = 'Something entirely different'
        expect(run.findings.accept(tracked!.id, rewritten)).toEqual({
            ok: false,
            reason: 'stale-proposal'
        })
    })
})

describe('RunController subscriptions', () => {
    it('notifies on status changes and findings, and supports unsubscribe', async () => {
        const controller = new RunController()
        const gate = deferred()
        const editor: RunEditorSpec = {
            editorId: 'notifier',
            editorName: 'Notifier',
            execute: async function* (request) {
                yield finding(request.runId, raw())
                await gate.promise
                yield result(request.runId, [])
            }
        }
        const run = controller.startRun({ snapshot: snapshot(), editors: [editor] })
        let notifications = 0
        const unsubscribe = run.subscribe(() => notifications++)
        await Promise.resolve()
        await Promise.resolve()
        expect(notifications).toBeGreaterThan(0)

        const seen = notifications
        unsubscribe()
        gate.resolve()
        await run.settled
        expect(notifications).toEqual(seen)
    })

    it('survives throwing subscribers', async () => {
        const controller = new RunController()
        const editor = scriptedEditor('sturdy', (runId) => [result(runId, [raw()])])
        const run = controller.startRun({ snapshot: snapshot(), editors: [editor] })
        run.subscribe(() => {
            throw new Error('bad listener')
        })
        await run.settled
        expect(run.getEditorState('sturdy')?.status).toEqual('done')
    })

    it('cancelAll cancels every active run', async () => {
        const controller = new RunController()
        const gate = deferred()
        const hanging: RunEditorSpec = {
            editorId: 'hang',
            editorName: 'Hang',
            execute: async function* (request) {
                yield finding(request.runId, raw())
                await gate.promise
            }
        }
        const run = controller.startRun({ snapshot: snapshot(), editors: [hanging] })
        await Promise.resolve()
        controller.cancelAll()
        expect(run.getEditorState('hang')?.status).toEqual('cancelled')
        gate.resolve()
        await run.settled
    })

    it('cancelAll forgets every run', async () => {
        const controller = new RunController()
        const editor = scriptedEditor('done', (runId) => [result(runId, [])])
        const run = controller.startRun({ snapshot: snapshot(), editors: [editor] })
        await run.settled
        controller.cancelAll()
        expect(controller.getRun('notes/test.md')).toBeNull()
    })

    it('discardRun cancels and forgets the run for a file', async () => {
        const controller = new RunController()
        const gate = deferred()
        const hanging: RunEditorSpec = {
            editorId: 'hang',
            editorName: 'Hang',
            execute: async function* (request) {
                yield finding(request.runId, raw())
                await gate.promise
            }
        }
        const run = controller.startRun({ snapshot: snapshot(), editors: [hanging] })
        await Promise.resolve()
        controller.discardRun('notes/test.md')
        expect(run.getEditorState('hang')?.status).toEqual('cancelled')
        expect(controller.getRun('notes/test.md')).toBeNull()
        // Discarding an unknown path is a no-op.
        controller.discardRun('notes/unknown.md')
        gate.resolve()
        await run.settled
    })

    it('discardUnder sweeps a renamed/deleted FOLDER, and nothing outside it', async () => {
        // Obsidian emits ONE vault event for a folder, with no per-child ones:
        // a controller that only matched the exact path left every note under
        // it holding a live run (permit + retained snapshot), and a note later
        // created at a reused path inherited it.
        const controller = new RunController()
        const editor = scriptedEditor('done', (runId) => [result(runId, [])])
        const paths = ['Notes', 'Notes/A.md', 'Notes/Sub/B.md', 'NotesArchive/C.md', 'Other.md']
        for (const filePath of paths) {
            const run = controller.startRun({
                snapshot: createSnapshot({ filePath, text: DOC }),
                editors: [editor]
            })
            await run.settled
        }
        controller.discardUnder('Notes')
        expect(controller.getRun('Notes')).toBeNull()
        expect(controller.getRun('Notes/A.md')).toBeNull()
        expect(controller.getRun('Notes/Sub/B.md')).toBeNull()
        expect(controller.getRun('NotesArchive/C.md')).not.toBeNull()
        expect(controller.getRun('Other.md')).not.toBeNull()
    })

    it('discardUnder cancels the in-flight runs it sweeps', async () => {
        const controller = new RunController()
        const gate = deferred()
        const hanging: RunEditorSpec = {
            editorId: 'hang',
            editorName: 'Hang',
            execute: async function* (request) {
                yield finding(request.runId, raw())
                await gate.promise
            }
        }
        const run = controller.startRun({
            snapshot: createSnapshot({ filePath: 'Notes/Sub/B.md', text: DOC }),
            editors: [hanging]
        })
        await Promise.resolve()
        controller.discardUnder('Notes')
        expect(run.getEditorState('hang')?.status).toEqual('cancelled')
        gate.resolve()
        await run.settled
    })
})

describe('RunController.renameUnder (issue #47 — a rename is not a close)', () => {
    it('re-keys the run to the new path with findings intact — same handle, re-pathed snapshot', async () => {
        const controller = new RunController()
        const editor = scriptedEditor('keep', (runId) => [result(runId, [raw()])])
        const run = controller.startRun({ snapshot: snapshot(), editors: [editor] })
        await run.settled

        controller.renameUnder('notes/test.md', 'notes/better-title.md')

        expect(controller.getRun('notes/test.md')).toBeNull()
        const moved = controller.getRun('notes/better-title.md')
        expect(moved).toBe(run)
        expect(moved?.snapshot.filePath).toEqual('notes/better-title.md')
        // Content identity is untouched: anchors and preconditions stay valid.
        expect(moved?.snapshot.text).toEqual(DOC)
        expect(moved?.findings.list()).toHaveLength(1)
        expect(moved?.getEditorState('keep')?.status).toEqual('done')
    })

    it('remaps a whole FOLDER, sparing prefix look-alikes', async () => {
        const controller = new RunController()
        const editor = scriptedEditor('done', (runId) => [result(runId, [])])
        for (const filePath of ['Notes/A.md', 'Notes/Sub/B.md', 'NotesArchive/C.md']) {
            const run = controller.startRun({
                snapshot: createSnapshot({ filePath, text: DOC }),
                editors: [editor]
            })
            await run.settled
        }
        controller.renameUnder('Notes', 'Moved')
        expect(controller.getRun('Notes/A.md')).toBeNull()
        expect(controller.getRun('Moved/A.md')).not.toBeNull()
        expect(controller.getRun('Moved/Sub/B.md')).not.toBeNull()
        expect(controller.getRun('Moved/Sub/B.md')?.snapshot.filePath).toEqual('Moved/Sub/B.md')
        expect(controller.getRun('NotesArchive/C.md')?.snapshot.filePath).toEqual(
            'NotesArchive/C.md'
        )
    })

    it('keeps an IN-FLIGHT run alive across the rename — late findings land on the moved run', async () => {
        const controller = new RunController()
        const gate = deferred()
        const slow: RunEditorSpec = {
            editorId: 'slow',
            editorName: 'Slow',
            execute: async function* (request) {
                await gate.promise
                yield finding(request.runId, raw())
                yield result(request.runId, [])
            }
        }
        const run = controller.startRun({ snapshot: snapshot(), editors: [slow] })
        await Promise.resolve()

        controller.renameUnder('notes/test.md', 'notes/better-title.md')
        expect(run.getEditorState('slow')?.status).toEqual('running')

        gate.resolve()
        await run.settled
        const moved = controller.getRun('notes/better-title.md')
        expect(moved?.getEditorState('slow')?.status).toEqual('done')
        expect(moved?.findings.list()).toHaveLength(1)
    })

    it('discards a stale run already sitting at the target path instead of inheriting it', async () => {
        const controller = new RunController()
        const editor = scriptedEditor('done', (runId) => [result(runId, [raw()])])
        const stale = controller.startRun({
            snapshot: createSnapshot({ filePath: 'Moved/A.md', text: 'other text entirely' }),
            editors: [editor]
        })
        const live = controller.startRun({
            snapshot: createSnapshot({ filePath: 'Notes/A.md', text: DOC }),
            editors: [editor]
        })
        await Promise.all([stale.settled, live.settled])

        controller.renameUnder('Notes', 'Moved')

        // The moved note gets ITS run, never the stale occupant's findings.
        expect(controller.getRun('Moved/A.md')).toBe(live)
        expect(controller.getRun('Moved/A.md')?.snapshot.text).toEqual(DOC)
        expect(controller.getRun('Notes/A.md')).toBeNull()
    })
})

describe('RunController finding lookup', () => {
    it('resolves the run owning a finding across files', async () => {
        const controller = new RunController()
        const editor = scriptedEditor('lookup', (runId) => [result(runId, [raw()])])
        const runA = controller.startRun({
            snapshot: createSnapshot({ filePath: 'notes/a.md', text: DOC }),
            editors: [editor]
        })
        const runB = controller.startRun({
            snapshot: createSnapshot({ filePath: 'notes/b.md', text: DOC }),
            editors: [editor]
        })
        await Promise.all([runA.settled, runB.settled])

        const findingA = runA.findings.list()[0]
        const findingB = runB.findings.list()[0]
        expect(findingA).toBeDefined()
        expect(findingB).toBeDefined()
        if (!findingA || !findingB) {
            return
        }
        expect(controller.findRunWithFinding(findingA.id)).toBe(runA)
        expect(controller.findRunWithFinding(findingB.id)).toBe(runB)
    })

    it('returns null for an unknown finding id', () => {
        const controller = new RunController()
        expect(controller.findRunWithFinding(asFindingId('nope'))).toBeNull()
    })
})

describe('RunController concurrency gate (behavior.maxConcurrentRequests)', () => {
    /** Waits enough microtask turns for acquire/consume continuations. */
    async function settle(): Promise<void> {
        for (let i = 0; i < 5; i++) {
            await Promise.resolve()
        }
    }

    /**
     * Editor whose stream starts (recorded in `started`), then holds until
     * `gate` resolves OR the run is cancelled (abort-aware like the real
     * executors), then emits an empty result.
     */
    function gatedEditor(editorId: string, started: string[], gate: Promise<void>): RunEditorSpec {
        return {
            editorId,
            editorName: `Editor ${editorId}`,
            execute: async function* (request, signal) {
                started.push(editorId)
                await new Promise<void>((resolve) => {
                    if (signal.aborted) {
                        resolve()
                        return
                    }
                    signal.addEventListener('abort', () => resolve(), { once: true })
                    void gate.then(resolve)
                })
                yield result(request.runId, [])
            }
        }
    }

    it('starts at most N executor streams and keeps the N+1th pending', async () => {
        const controller = new RunController(() => 2)
        const started: string[] = []
        const gate = deferred()
        const run = controller.startRun({
            snapshot: snapshot(),
            editors: [
                gatedEditor('one', started, gate.promise),
                gatedEditor('two', started, gate.promise),
                gatedEditor('three', started, gate.promise)
            ]
        })
        await settle()

        // Only two streams started; the third editor never reached its backend.
        expect(started).toEqual(['one', 'two'])
        expect(run.getEditorState('one')?.status).toEqual('running')
        expect(run.getEditorState('two')?.status).toEqual('running')
        expect(run.getEditorState('three')?.status).toEqual('pending')

        // Completion releases permits and admits the waiter (FIFO).
        gate.resolve()
        await run.settled
        expect(started).toEqual(['one', 'two', 'three'])
        const states = run.getEditorStates()
        expect(states.every((state) => state.status === 'done')).toBeTrue()
    })

    it('shares the gate across concurrent runs on different files', async () => {
        const controller = new RunController(() => 1)
        const started: string[] = []
        const gateA = deferred()
        const gateB = deferred()
        const runA = controller.startRun({
            snapshot: createSnapshot({ filePath: 'notes/a.md', text: DOC }),
            editors: [gatedEditor('a', started, gateA.promise)]
        })
        const runB = controller.startRun({
            snapshot: createSnapshot({ filePath: 'notes/b.md', text: DOC }),
            editors: [gatedEditor('b', started, gateB.promise)]
        })
        await settle()

        // One permit plugin-wide: run B waits behind run A.
        expect(started).toEqual(['a'])
        expect(runB.getEditorState('b')?.status).toEqual('pending')

        gateA.resolve()
        await runA.settled
        await settle()
        expect(started).toEqual(['a', 'b'])
        gateB.resolve()
        await runB.settled
        expect(runB.getEditorState('b')?.status).toEqual('done')
    })

    it('cancelling a run ejects its queued editor without starting or leaking', async () => {
        const controller = new RunController(() => 1)
        const started: string[] = []
        const gate = deferred()
        const run = controller.startRun({
            snapshot: snapshot(),
            editors: [
                gatedEditor('holding', started, gate.promise),
                gatedEditor('queued', started, gate.promise)
            ]
        })
        await settle()
        expect(started).toEqual(['holding'])
        expect(run.getEditorState('queued')?.status).toEqual('pending')

        run.cancelRun()
        await run.settled

        // The queued editor settled as cancelled and its stream never started.
        expect(started).toEqual(['holding'])
        expect(run.getEditorState('holding')?.status).toEqual('cancelled')
        expect(run.getEditorState('queued')?.status).toEqual('cancelled')

        // No leaked permit: a fresh run acquires immediately and completes.
        const after = controller.startRun({
            snapshot: createSnapshot({ filePath: 'notes/after.md', text: DOC }),
            editors: [scriptedEditor('after', (runId) => [result(runId, [])])]
        })
        await after.settled
        expect(after.getEditorState('after')?.status).toEqual('done')
    })

    it('cancelling only the queued run leaves the in-flight run untouched', async () => {
        const controller = new RunController(() => 1)
        const started: string[] = []
        const gate = deferred()
        const runA = controller.startRun({
            snapshot: createSnapshot({ filePath: 'notes/a.md', text: DOC }),
            editors: [gatedEditor('a', started, gate.promise)]
        })
        const runB = controller.startRun({
            snapshot: createSnapshot({ filePath: 'notes/b.md', text: DOC }),
            editors: [gatedEditor('b', started, gate.promise)]
        })
        await settle()
        expect(started).toEqual(['a'])

        // Abort-while-queued: B leaves the queue immediately and settles.
        runB.cancelRun()
        await runB.settled
        expect(started).toEqual(['a'])
        expect(runB.getEditorState('b')?.status).toEqual('cancelled')

        // A still holds its permit and finishes normally.
        expect(runA.getEditorState('a')?.status).toEqual('running')
        gate.resolve()
        await runA.settled
        expect(runA.getEditorState('a')?.status).toEqual('done')
    })

    it('applies a limit raised between runs to subsequent acquisitions', async () => {
        let limit = 1
        const controller = new RunController(() => limit)
        const startedFirst: string[] = []
        const gateFirst = deferred()
        const first = controller.startRun({
            snapshot: createSnapshot({ filePath: 'notes/first.md', text: DOC }),
            editors: [
                gatedEditor('f1', startedFirst, gateFirst.promise),
                gatedEditor('f2', startedFirst, gateFirst.promise)
            ]
        })
        await settle()
        expect(startedFirst).toEqual(['f1']) // limit 1: second editor queued

        gateFirst.resolve()
        await first.settled

        // Settings change between runs: the next run sees the new limit.
        limit = 2
        const startedSecond: string[] = []
        const gateSecond = deferred()
        const second = controller.startRun({
            snapshot: createSnapshot({ filePath: 'notes/second.md', text: DOC }),
            editors: [
                gatedEditor('s1', startedSecond, gateSecond.promise),
                gatedEditor('s2', startedSecond, gateSecond.promise)
            ]
        })
        await settle()
        expect(startedSecond).toEqual(['s1', 's2']) // both in flight under limit 2

        gateSecond.resolve()
        await second.settled
        expect(second.getEditorStates().every((state) => state.status === 'done')).toBeTrue()
    })

    it('reclaims the permit on cancel even when the executor ignores its abort signal', async () => {
        const controller = new RunController(() => 1)
        const started: string[] = []
        /** Rogue executor: never yields, never ends, ignores the signal. */
        const rogue: RunEditorSpec = {
            editorId: 'rogue',
            editorName: 'Rogue',
            execute: async function* (request) {
                started.push('rogue')
                await new Promise<never>(() => undefined) // hangs forever
                yield result(request.runId, []) // unreachable
            }
        }
        const run = controller.startRun({ snapshot: snapshot(), editors: [rogue] })
        await settle()
        expect(started).toEqual(['rogue'])
        expect(run.getEditorState('rogue')?.status).toEqual('running')

        // Cancel marks the editor terminal; the stream keeps hanging, but the
        // permit must be freed NOW — not at iterator end (which never comes).
        run.cancelRun()
        expect(run.getEditorState('rogue')?.status).toEqual('cancelled')

        const after = controller.startRun({
            snapshot: createSnapshot({ filePath: 'notes/after.md', text: DOC }),
            editors: [scriptedEditor('after', (runId) => [result(runId, [])])]
        })
        await after.settled
        expect(after.getEditorState('after')?.status).toEqual('done')
    })

    it('frees the permit at the terminal event while the stream is still draining', async () => {
        const controller = new RunController(() => 1)
        const started: string[] = []
        /** Emits its terminal result, then keeps the stream open forever. */
        const slowClosing: RunEditorSpec = {
            editorId: 'slow',
            editorName: 'Slow closing',
            execute: async function* (request) {
                started.push('slow')
                yield result(request.runId, [])
                await new Promise<never>(() => undefined) // never closes
            }
        }
        const run = controller.startRun({
            snapshot: snapshot(),
            editors: [slowClosing, scriptedEditor('next', (runId) => [result(runId, [])])]
        })
        // Extra turns: admission happens mid-drain, adding microtask hops
        // before the second editor's stream starts and settles.
        await settle()
        await settle()

        // The terminal 'result' released the permit; the queued editor ran to
        // completion even though the first stream never closed.
        expect(started).toEqual(['slow'])
        expect(run.getEditorState('slow')?.status).toEqual('done')
        expect(run.getEditorState('next')?.status).toEqual('done')
    })
})

describe('RunHandle.retryEditor (per-editor retry)', () => {
    /** Fresh buffer text passed at retry time — repeated "fox" on purpose. */
    const FRESH = 'A fox here. A fox there. Nothing else.'

    async function until(predicate: () => boolean): Promise<void> {
        for (let i = 0; i < 50 && !predicate(); i++) {
            await Bun.sleep(0)
        }
        expect(predicate()).toBeTrue()
    }

    /** First attempt fails with a timeout; later attempts run `retryScript`. */
    function failingThenScripted(
        editorId: string,
        retryScript: (runId: string) => OperationEvent[]
    ): RunEditorSpec {
        let attempt = 0
        return {
            editorId,
            editorName: `Editor ${editorId}`,
            execute: async function* (request) {
                await Promise.resolve()
                if (attempt++ === 0) {
                    yield finding(request.runId, raw({ critique: 'From the failed attempt' }))
                    yield {
                        type: 'error',
                        runId: request.runId,
                        error: { code: 'timeout', message: 'boom' }
                    }
                    return
                }
                yield* retryScript(request.runId)
            }
        }
    }

    it('re-runs after an error, REPLACES the old findings, and anchors against the fresh text (occurrence disambiguation)', async () => {
        const controller = new RunController()
        const requests: ReviewRequest[] = []
        let attempt = 0
        const editor: RunEditorSpec = {
            editorId: 'flaky',
            editorName: 'Flaky',
            execute: async function* (request) {
                requests.push(request)
                await Promise.resolve()
                if (attempt++ === 0) {
                    yield finding(request.runId, raw({ critique: 'Partial, from failure' }))
                    yield {
                        type: 'error',
                        runId: request.runId,
                        error: { code: 'network', message: 'boom' }
                    }
                    return
                }
                // Repeated text in the NEW buffer: occurrence 1 must anchor
                // on the SECOND "fox" of the fresh text, not the snapshot's.
                yield result(request.runId, [
                    raw({
                        quote: 'fox',
                        occurrence: 1,
                        critique: 'Second fox',
                        edits: [{ op: 'replace', text: 'vixen' }]
                    })
                ])
            }
        }
        const run = controller.startRun({ snapshot: snapshot(), editors: [editor] })
        await run.settled
        expect(run.getEditorState('flaky')?.status).toEqual('error')
        expect(run.findings.list()).toHaveLength(1)
        const oldId = run.findings.list()[0]!.id
        const oldRunId = run.getEditorState('flaky')?.runId

        expect(run.retryEditor('flaky', FRESH)).toEqual({ ok: true })
        await until(() => run.getEditorState('flaky')?.status === 'done')

        // Old finding gone, new one anchored against the FRESH text.
        const findings = run.findings.list()
        expect(findings).toHaveLength(1)
        expect(run.findings.get(oldId)).toBeNull()
        const tracked = findings[0]
        expect(tracked?.raw.critique).toEqual('Second fox')
        expect(tracked?.anchor).toEqual({
            from: FRESH.indexOf('fox', 3),
            to: FRESH.indexOf('fox', 3) + 3,
            state: 'anchored'
        })
        expect(tracked?.anchoredText).toEqual('fox')

        // The retried request carried the fresh text, and a fresh attempt id.
        expect(requests[1]?.text).toEqual(FRESH)
        expect(requests[1]?.runId).not.toEqual(requests[0]?.runId)
        const state = run.getEditorState('flaky')
        expect(state?.runId).not.toEqual(oldRunId)
        expect(state?.error).toBeNull()
        expect(state?.findingIds).toEqual([tracked!.id])
    })

    it('retries after cancelRun on a FRESH abort signal', async () => {
        const controller = new RunController()
        const freshness: boolean[] = []
        let attempt = 0
        const editor: RunEditorSpec = {
            editorId: 'cancelled-once',
            editorName: 'Cancelled once',
            execute: async function* (request, signal) {
                await Promise.resolve()
                if (attempt++ === 0) {
                    await new Promise<void>((resolve) => {
                        signal.addEventListener('abort', () => resolve())
                    })
                    return
                }
                freshness.push(signal.aborted)
                yield result(request.runId, [])
            }
        }
        const run = controller.startRun({ snapshot: snapshot(), editors: [editor] })
        for (let i = 0; i < 5; i++) {
            await Promise.resolve()
        }
        run.cancelRun()
        await run.settled
        expect(run.getEditorState('cancelled-once')?.status).toEqual('cancelled')

        expect(run.retryEditor('cancelled-once', DOC)).toEqual({ ok: true })
        await until(() => run.getEditorState('cancelled-once')?.status === 'done')
        // The retry's signal was NOT the (permanently aborted) run signal.
        expect(freshness).toEqual([false])
    })

    it('acquires the concurrency permit exactly like a first attempt', async () => {
        const controller = new RunController(() => 1)
        const failing = scriptedEditor('failing', (runId) => [
            { type: 'error', runId, error: { code: 'network', message: 'boom' } }
        ])
        const runA = controller.startRun({
            snapshot: createSnapshot({ filePath: 'notes/a.md', text: DOC }),
            editors: [failing]
        })
        await runA.settled
        expect(runA.getEditorState('failing')?.status).toEqual('error')

        // A second run now holds the single permit with a hanging stream.
        const gate = deferred()
        const hog: RunEditorSpec = {
            editorId: 'hog',
            editorName: 'Hog',
            execute: async function* (request) {
                await gate.promise
                yield result(request.runId, [])
            }
        }
        const runB = controller.startRun({
            snapshot: createSnapshot({ filePath: 'notes/b.md', text: DOC }),
            editors: [hog]
        })
        for (let i = 0; i < 5; i++) {
            await Promise.resolve()
        }

        // Retry queues behind the limit: the editor stays 'pending'.
        expect(runA.retryEditor('failing', DOC)).toEqual({ ok: true })
        for (let i = 0; i < 5; i++) {
            await Promise.resolve()
        }
        expect(runA.getEditorState('failing')?.status).toEqual('pending')
        expect(runA.isSettled()).toBeFalse()

        // Freeing the permit admits the retry. (The retried attempt errors
        // again — the scripted editor always fails — which is fine: what is
        // pinned here is the admission, not the outcome.)
        gate.resolve()
        runB.cancelRun()
        await until(() => runA.getEditorState('failing')?.status === 'error')
    })

    it('rejects illegal retries: done, in-flight, mid-retry, and unknown editors', async () => {
        const controller = new RunController()
        const gate = deferred()
        let attempt = 0
        const editor: RunEditorSpec = {
            editorId: 'once-bad',
            editorName: 'Once bad',
            execute: async function* (request) {
                await Promise.resolve()
                if (attempt++ === 0) {
                    yield {
                        type: 'error',
                        runId: request.runId,
                        error: { code: 'network', message: 'boom' }
                    }
                    return
                }
                await gate.promise
                yield result(request.runId, [])
            }
        }
        const done = scriptedEditor('fine', (runId) => [result(runId, [])])
        const run = controller.startRun({ snapshot: snapshot(), editors: [editor, done] })
        await run.settled

        // 'done' editors and unknown ids are not retryable.
        expect(run.retryEditor('fine', DOC)).toEqual({ ok: false, reason: 'not-retryable' })
        expect(run.retryEditor('nope', DOC)).toEqual({ ok: false, reason: 'unknown-editor' })

        // A retry in flight blocks a second retry of the same editor.
        expect(run.retryEditor('once-bad', DOC)).toEqual({ ok: true })
        expect(run.retryEditor('once-bad', DOC)).toEqual({ ok: false, reason: 'not-retryable' })
        gate.resolve()
        await until(() => run.getEditorState('once-bad')?.status === 'done')
    })

    it('flips isSettled back to false while the retry is in flight', async () => {
        const controller = new RunController()
        const editor = failingThenScripted('again', (runId) => [result(runId, [])])
        const run = controller.startRun({ snapshot: snapshot(), editors: [editor] })
        await run.settled
        expect(run.isSettled()).toBeTrue()

        expect(run.retryEditor('again', DOC)).toEqual({ ok: true })
        expect(run.isSettled()).toBeFalse()
        await until(() => run.isSettled())
        expect(run.getEditorState('again')?.status).toEqual('done')
    })

    it('remaps retried findings through edits applied AFTER the retry started', async () => {
        const controller = new RunController()
        const gate = deferred()
        let attempt = 0
        const editor: RunEditorSpec = {
            editorId: 'remap',
            editorName: 'Remap',
            execute: async function* (request) {
                await Promise.resolve()
                if (attempt++ === 0) {
                    yield {
                        type: 'error',
                        runId: request.runId,
                        error: { code: 'timeout', message: 'slow' }
                    }
                    return
                }
                await gate.promise
                yield result(request.runId, [raw()]) // 'quick brown' [4, 15) in DOC
            }
        }
        const run = controller.startRun({ snapshot: snapshot(), editors: [editor] })
        await run.settled

        // Retry against the current text (unchanged here), then edit BEFORE
        // the finding arrives: insert 5 chars at offset 0.
        expect(run.retryEditor('remap', DOC)).toEqual({ ok: true })
        run.applyTextChanges([{ from: 0, to: 0, insertedLength: 5 }])
        gate.resolve()
        await until(() => run.getEditorState('remap')?.status === 'done')

        const tracked = run.findings.list()[0]
        expect(tracked?.anchor).toEqual({ from: 9, to: 20, state: 'anchored' })
        const edited = `XXXXX${DOC}`
        expect(run.findings.accept(tracked!.id, edited).ok).toBeTrue()
    })

    it('cancelRun aborts an in-flight retry', async () => {
        const controller = new RunController()
        let observedSignal: AbortSignal | null = null
        let attempt = 0
        const editor: RunEditorSpec = {
            editorId: 'retry-cancel',
            editorName: 'Retry cancel',
            execute: async function* (request, signal) {
                await Promise.resolve()
                if (attempt++ === 0) {
                    yield {
                        type: 'error',
                        runId: request.runId,
                        error: { code: 'network', message: 'boom' }
                    }
                    return
                }
                observedSignal = signal
                await new Promise<void>((resolve) => {
                    signal.addEventListener('abort', () => resolve())
                })
            }
        }
        const run = controller.startRun({ snapshot: snapshot(), editors: [editor] })
        await run.settled

        expect(run.retryEditor('retry-cancel', DOC)).toEqual({ ok: true })
        await until(() => run.getEditorState('retry-cancel')?.status === 'running')
        run.cancelRun()
        expect(observedSignal).not.toBeNull()
        expect(observedSignal!.aborted).toBeTrue()
        expect(run.getEditorState('retry-cancel')?.status).toEqual('cancelled')
        expect(run.isSettled()).toBeTrue()
    })
})

// ---------------------------------------------------------------------------
// Panel runs (plan M6): members in parallel + one aggregation step
// ---------------------------------------------------------------------------

describe('RunController panel runs', () => {
    async function until(predicate: () => boolean): Promise<void> {
        for (let i = 0; i < 100 && !predicate(); i++) {
            await Bun.sleep(0)
        }
        expect(predicate()).toBeTrue()
    }

    /** Member whose stream blocks until `gate` resolves, then reports one finding. */
    function blockingMember(editorId: string, gate: Promise<void>): RunEditorSpec {
        return {
            editorId,
            editorName: `Member ${editorId}`,
            execute: async function* (request, signal) {
                running.add(editorId)
                await Promise.race([
                    gate,
                    new Promise<void>((resolve) =>
                        signal.addEventListener('abort', () => resolve())
                    )
                ])
                running.delete(editorId)
                if (signal.aborted) {
                    return
                }
                yield finding(request.runId, raw({ quote: 'quick brown', critique: editorId }))
                yield result(request.runId, [], `${editorId} summary`)
            }
        }
    }

    /** Editors currently inside their `execute` body (concurrency assertions). */
    const running = new Set<string>()

    function panelResultEvent(runId: string): OperationEvent {
        return {
            type: 'result',
            runId,
            result: {
                kind: 'aggregate-panel',
                recommendation: 'needs-work',
                memberVerdicts: [],
                topFixes: [{ action: 'Tighten the opening' }],
                dissent: [],
                missingMembers: []
            }
        }
    }

    /** Scripted member: one finding then a review result. */
    function member(editorId: string, name = `Member ${editorId}`): RunEditorSpec {
        return {
            editorId,
            editorName: name,
            execute: async function* (request) {
                await Promise.resolve()
                yield finding(request.runId, raw({ quote: 'quick brown', critique: editorId }))
                yield result(request.runId, [], `${editorId} summary`)
            }
        }
    }

    function failingMember(editorId: string, name = `Member ${editorId}`): RunEditorSpec {
        return {
            editorId,
            editorName: name,
            execute: async function* (request) {
                await Promise.resolve()
                yield {
                    type: 'error',
                    runId: request.runId,
                    error: { code: 'timeout', message: 'too slow' }
                }
            }
        }
    }

    it('schedules every member through the shared gate without starving another run', async () => {
        running.clear()
        const controller = new RunController(() => 2)
        const gate = deferred()
        const members = ['m1', 'm2', 'm3'].map((id) => blockingMember(id, gate.promise))
        const soloGate = deferred()
        const solo = blockingMember('solo', soloGate.promise)

        const panelRun = controller.startRun({
            snapshot: snapshot(),
            editors: members,
            panel: { panelId: 'panel-1', panelName: 'Pre-publish review' }
        })
        const soloRun = controller.startRun({
            snapshot: createSnapshot({ filePath: 'notes/other.md', text: DOC }),
            editors: [solo]
        })

        // Two members in flight, the third and the other run's editor queued:
        // members are ordinary editor streams on the ordinary permit gate.
        await until(() => running.size === 2)
        expect([...running].sort()).toEqual(['m1', 'm2'])
        expect(panelRun.getEditorState('m3')?.status).toBe('pending')
        expect(soloRun.getEditorState('solo')?.status).toBe('pending')

        // Freeing the members admits the queue in FIFO order — the other run
        // gets its permit without waiting for the whole panel to finish.
        gate.resolve()
        await until(() => running.has('solo'))
        soloGate.resolve()
        await panelRun.settled
        await soloRun.settled
    })

    it('aggregates once the members settle, carrying their own results', async () => {
        const controller = new RunController()
        const requests: { members: readonly { editorName: string; failed: boolean }[] }[] = []
        const run = controller.startRun({
            snapshot: snapshot(),
            editors: [member('a', 'Devil’s Advocate'), member('b', 'Beginner Reader')],
            panel: {
                panelId: 'panel-1',
                panelName: 'Pre-publish review',
                aggregate: async function* (request) {
                    requests.push({ members: request.members })
                    await Promise.resolve()
                    yield panelResultEvent(request.runId)
                }
            }
        })

        await run.settled
        // The scorecard has its own settle point: members done ≠ panel done.
        await run.panelSettled

        const state = run.getPanelState()
        expect(state?.panelName).toBe('Pre-publish review')
        expect(state?.status).toBe('done')
        expect(state?.result?.topFixes.map((fix) => fix.action)).toEqual(['Tighten the opening'])
        expect(state?.missingMembers).toEqual([])
        expect(requests).toHaveLength(1)
        expect(requests[0]?.members.map((entry) => entry.editorName)).toEqual([
            'Devil’s Advocate',
            'Beginner Reader'
        ])
    })

    it('keeps every finding attributed to the member that reported it', async () => {
        const controller = new RunController()
        const run = controller.startRun({
            snapshot: snapshot(),
            editors: [member('a'), member('b')],
            panel: { panelId: 'panel-1', panelName: 'Panel' }
        })
        await run.settled

        const byEditor = run.findings.list().map((entry) => entry.editorId)
        expect(byEditor.sort()).toEqual(['a', 'b'])
    })

    it('completes with the survivors, naming the failed member to the chairperson', async () => {
        const controller = new RunController()
        let sent: readonly { editorName: string; failed: boolean }[] = []
        const run = controller.startRun({
            snapshot: snapshot(),
            editors: [member('a', 'Alpha'), failingMember('b', 'Bravo')],
            panel: {
                panelId: 'panel-1',
                panelName: 'Panel',
                aggregate: async function* (request) {
                    sent = request.members
                    await Promise.resolve()
                    yield panelResultEvent(request.runId)
                }
            }
        })

        await run.panelSettled

        expect(run.getPanelState()?.status).toBe('done')
        expect(run.getPanelState()?.missingMembers).toEqual(['Bravo'])
        expect(sent.map((entry) => [entry.editorName, entry.failed])).toEqual([
            ['Alpha', false],
            ['Bravo', true]
        ])
        // The failed member is still retryable inside the run.
        expect(run.getEditorState('b')?.status).toBe('error')
    })

    it('skips aggregation when no member succeeded, and says so', async () => {
        const controller = new RunController()
        let called = false
        const run = controller.startRun({
            snapshot: snapshot(),
            editors: [failingMember('a', 'Alpha'), failingMember('b', 'Bravo')],
            panel: {
                panelId: 'panel-1',
                panelName: 'Panel',
                aggregate: async function* (request) {
                    called = true
                    yield panelResultEvent(request.runId)
                }
            }
        })

        await run.panelSettled

        expect(called).toBeFalse()
        expect(run.getPanelState()?.status).toBe('skipped')
        expect(run.getPanelState()?.missingMembers).toEqual(['Alpha', 'Bravo'])
    })

    it('reports an unavailable scorecard rather than pretending there is none', async () => {
        const controller = new RunController()
        const run = controller.startRun({
            snapshot: snapshot(),
            editors: [member('a')],
            panel: { panelId: 'panel-1', panelName: 'Panel' }
        })

        await run.panelSettled

        expect(run.getPanelState()?.status).toBe('unavailable')
    })

    it('cancelling mid-panel cancels every member and the pending aggregation', async () => {
        running.clear()
        const controller = new RunController()
        const gate = deferred()
        let called = false
        const run = controller.startRun({
            snapshot: snapshot(),
            editors: [blockingMember('m1', gate.promise), blockingMember('m2', gate.promise)],
            panel: {
                panelId: 'panel-1',
                panelName: 'Panel',
                aggregate: async function* (request) {
                    called = true
                    yield panelResultEvent(request.runId)
                }
            }
        })

        await until(() => running.size === 2)
        run.cancelRun()

        expect(run.getEditorStates().map((state) => state.status)).toEqual([
            'cancelled',
            'cancelled'
        ])
        expect(run.getPanelState()?.status).toBe('cancelled')
        await run.panelSettled
        expect(called).toBeFalse()
        gate.resolve()
    })

    it('cancelling while the scorecard is in flight aborts the aggregation', async () => {
        const controller = new RunController()
        let aggregationSignal: AbortSignal | null = null
        const run = controller.startRun({
            snapshot: snapshot(),
            editors: [member('a')],
            panel: {
                panelId: 'panel-1',
                panelName: 'Panel',
                // eslint-disable-next-line require-yield -- reason: models an aggregation that only ever ends by being aborted
                aggregate: async function* (_request, signal) {
                    aggregationSignal = signal
                    await new Promise<void>((resolve) =>
                        signal.addEventListener('abort', () => resolve())
                    )
                }
            }
        })

        await until(() => run.getPanelState()?.status === 'running')
        run.cancelRun()

        expect(aggregationSignal).not.toBeNull()
        expect(aggregationSignal!.aborted).toBeTrue()
        expect(run.getPanelState()?.status).toBe('cancelled')
        await run.panelSettled
    })

    it('retrying one failed member re-opens the panel and re-derives the scorecard', async () => {
        const controller = new RunController()
        let attempt = 0
        const flaky: RunEditorSpec = {
            editorId: 'b',
            editorName: 'Bravo',
            execute: async function* (request) {
                await Promise.resolve()
                if (attempt++ === 0) {
                    yield {
                        type: 'error',
                        runId: request.runId,
                        error: { code: 'timeout', message: 'too slow' }
                    }
                    return
                }
                yield finding(request.runId, raw({ quote: 'lazy dog', critique: 'retried' }))
                yield result(request.runId, [])
            }
        }
        const missingPerCall: string[][] = []
        const run = controller.startRun({
            snapshot: snapshot(),
            editors: [member('a', 'Alpha'), flaky],
            panel: {
                panelId: 'panel-1',
                panelName: 'Panel',
                aggregate: async function* (request) {
                    missingPerCall.push(
                        request.members.filter((entry) => entry.failed).map((e) => e.editorName)
                    )
                    await Promise.resolve()
                    yield panelResultEvent(request.runId)
                }
            }
        })

        await run.panelSettled
        expect(run.getPanelState()?.missingMembers).toEqual(['Bravo'])

        // The stage-A per-editor retry works inside a panel run…
        expect(run.retryEditor('b', DOC)).toEqual({ ok: true })
        // …and it invalidates the scorecard that said Bravo was missing.
        expect(run.getPanelState()?.status).toBe('waiting')
        expect(run.getPanelState()?.missingMembers).toEqual([])

        await until(() => run.getPanelState()?.status === 'done')
        expect(run.getPanelState()?.missingMembers).toEqual([])
        expect(missingPerCall).toEqual([['Bravo'], []])
        // The retried member's findings replaced the failed attempt's.
        expect(
            run.findings.list().filter((entry) => entry.editorId === 'b').length
        ).toBeGreaterThan(0)
    })

    it('redacts the aggregation failure and never reports silent success', async () => {
        const controller = new RunController()
        const run = controller.startRun({
            snapshot: snapshot(),
            editors: [member('a')],
            panel: {
                panelId: 'panel-1',
                panelName: 'Panel',
                redactError: (message) => message.replace('sk-secret', '[redacted]'),
                aggregate: async function* (request) {
                    await Promise.resolve()
                    yield {
                        type: 'error',
                        runId: request.runId,
                        error: { code: 'auth', message: 'rejected sk-secret' }
                    }
                }
            }
        })

        await run.panelSettled

        expect(run.getPanelState()?.status).toBe('error')
        expect(run.getPanelState()?.error).toBe('rejected [redacted]')
    })

    it('carries the aggregation diagnostics through, still behind reveal() (issue #42)', async () => {
        // A CLI-backed chairperson that dies must not leave the scorecard
        // failure as opaque as reviews used to be (#39): the capture rides the
        // panel state, the MESSAGE stays status-only.
        const diagnostics = { summary: 'The tool wrote 12 bytes.', reveal: () => 'stderr text' }
        const controller = new RunController()
        const run = controller.startRun({
            snapshot: snapshot(),
            editors: [member('a')],
            panel: {
                panelId: 'panel-1',
                panelName: 'Panel',
                aggregate: async function* (request) {
                    await Promise.resolve()
                    yield {
                        type: 'error',
                        runId: request.runId,
                        error: {
                            code: 'unknown',
                            message: 'The tool exited with status 1.',
                            diagnostics
                        }
                    }
                }
            }
        })

        await run.panelSettled

        expect(run.getPanelState()?.status).toBe('error')
        expect(run.getPanelState()?.errorDiagnostics).toBe(diagnostics)
        // The redacted message never absorbs the content.
        expect(run.getPanelState()?.error).not.toContain('stderr text')

        // A member going back to work re-opens the panel: the failed
        // attempt's capture belongs to the failed attempt and goes with it.
        expect(run.continueEditor('a', DOC)).toEqual({ ok: true })
        expect(run.getPanelState()?.status).toBe('waiting')
        expect(run.getPanelState()?.errorDiagnostics).toBeNull()
        run.cancelRun()
    })

    it('treats a stream that ends without a terminal event as a failure', async () => {
        const controller = new RunController()
        const run = controller.startRun({
            snapshot: snapshot(),
            editors: [member('a')],
            panel: {
                panelId: 'panel-1',
                panelName: 'Panel',
                // eslint-disable-next-line require-yield -- reason: models the protocol violation of a stream ending without a terminal event
                aggregate: async function* () {
                    await Promise.resolve()
                }
            }
        })

        await run.panelSettled

        expect(run.getPanelState()?.status).toBe('error')
        expect(run.getPanelState()?.error).toBe('Stream ended without a terminal event')
    })

    it('leaves a solo run without any panel state', async () => {
        const controller = new RunController()
        const run = controller.startRun({ snapshot: snapshot(), editors: [member('a')] })
        await run.panelSettled
        expect(run.getPanelState()).toBeNull()
    })
})

// ---------------------------------------------------------------------------
// "Generate more" — continuation passes (plan M6)
// ---------------------------------------------------------------------------

describe('RunHandle.continueEditor', () => {
    /** Editor whose Nth attempt yields the Nth script entry. */
    function perAttempt(editorId: string, scripts: ((runId: string) => OperationEvent[])[]) {
        const requests: ReviewRequest[] = []
        let attempt = 0
        const spec: RunEditorSpec = {
            editorId,
            editorName: `Editor ${editorId}`,
            execute: async function* (request) {
                requests.push(request)
                await Promise.resolve()
                const script = scripts[attempt++] ?? ((): OperationEvent[] => [])
                yield* script(request.runId)
            }
        }
        return { spec, requests }
    }

    it('APPENDS to the findings already produced instead of replacing them', async () => {
        const { spec } = perAttempt('alpha', [
            (runId) => [result(runId, [raw()], 'First pass')],
            (runId) => [result(runId, [raw({ quote: 'lazy dog', critique: 'Cliché' })])]
        ])
        const controller = new RunController()
        const run = controller.startRun({ snapshot: snapshot(), editors: [spec] })
        await run.settled
        expect(run.getEditorState('alpha')?.findingIds).toHaveLength(1)

        expect(run.continueEditor('alpha', DOC)).toEqual({ ok: true })
        await Bun.sleep(5)
        const state = run.getEditorState('alpha')
        expect(state?.status).toBe('done')
        expect(state?.findingIds).toHaveLength(2)
        expect(run.findings.list().map((item) => item.raw.quote)).toEqual([
            'quick brown',
            'lazy dog'
        ])
    })

    it('sends what was already reported, so the editor is asked not to repeat it', async () => {
        const { spec, requests } = perAttempt('alpha', [
            (runId) => [result(runId, [raw()])],
            (runId) => [result(runId, [])]
        ])
        const controller = new RunController()
        const run = controller.startRun({ snapshot: snapshot(), editors: [spec] })
        await run.settled
        // Absent, not empty, on a first pass — a backend can tell "nothing
        // yet" from "found nothing".
        expect(requests[0]?.alreadyReported).toBeUndefined()

        run.continueEditor('alpha', DOC)
        await Bun.sleep(5)
        expect(requests[1]?.alreadyReported).toEqual([
            { quote: 'quick brown', critique: 'Too generic' }
        ])
    })

    it('drops a literal repeat on arrival — the dedupe keys survive the pass', async () => {
        const { spec } = perAttempt('alpha', [
            (runId) => [result(runId, [raw()])],
            // Same finding in every field: the editor ignored the instruction.
            (runId) => [result(runId, [raw()])]
        ])
        const controller = new RunController()
        const run = controller.startRun({ snapshot: snapshot(), editors: [spec] })
        await run.settled
        run.continueEditor('alpha', DOC)
        await Bun.sleep(5)
        expect(run.getEditorState('alpha')?.findingIds).toHaveLength(1)
    })

    it('keeps the first pass’s summary when the continuation reports none', async () => {
        const { spec } = perAttempt('alpha', [
            (runId) => [result(runId, [raw()], 'The opening is weak')],
            (runId) => [result(runId, [])]
        ])
        const controller = new RunController()
        const run = controller.startRun({ snapshot: snapshot(), editors: [spec] })
        await run.settled
        run.continueEditor('alpha', DOC)
        await Bun.sleep(5)
        expect(run.getEditorState('alpha')?.summary).toBe('The opening is weak')
    })

    it('a FAILED continuation leaves the editor done, so Retry cannot destroy the findings', async () => {
        const { spec } = perAttempt('alpha', [
            (runId) => [result(runId, [raw()])],
            (runId) => [{ type: 'error', runId, error: { code: 'timeout', message: 'Timed out' } }]
        ])
        const controller = new RunController()
        const run = controller.startRun({ snapshot: snapshot(), editors: [spec] })
        await run.settled
        run.continueEditor('alpha', DOC)
        await Bun.sleep(5)
        const state = run.getEditorState('alpha')
        expect(state?.status).toBe('done')
        expect(state?.error).toBeNull()
        expect(state?.continuationError).toBe('Timed out')
        expect(state?.findingIds).toHaveLength(1)
        // 'done' is not retryable — which is the point: Retry replaces an
        // editor's findings, and the ones on screen are still good.
        expect(run.retryEditor('alpha', DOC)).toEqual({
            ok: false,
            reason: 'not-retryable'
        })
    })

    it('cancelling mid-continuation restores done, keeping every finding', async () => {
        const gate = deferred()
        const spec: RunEditorSpec = {
            editorId: 'alpha',
            editorName: 'Alpha',
            execute: async function* (request) {
                if (request.alreadyReported === undefined) {
                    yield result(request.runId, [raw()])
                    return
                }
                await gate.promise
                yield result(request.runId, [])
            }
        }
        const controller = new RunController()
        const run = controller.startRun({ snapshot: snapshot(), editors: [spec] })
        await run.settled
        run.continueEditor('alpha', DOC)
        expect(run.isSettled()).toBeFalse()
        run.cancelRun()
        const state = run.getEditorState('alpha')
        expect(state?.status).toBe('done')
        expect(state?.continuationError).toBe('Cancelled')
        expect(state?.findingIds).toHaveLength(1)
        gate.resolve()
    })

    it('refuses an editor that is not done — nothing to build on, or already working', async () => {
        const { spec } = perAttempt('alpha', [
            (runId) => [{ type: 'error', runId, error: { code: 'network', message: 'Offline' } }]
        ])
        const controller = new RunController()
        const run = controller.startRun({ snapshot: snapshot(), editors: [spec] })
        await run.settled
        expect(run.continueEditor('alpha', DOC)).toEqual({
            ok: false,
            reason: 'not-continuable'
        })
        expect(run.continueEditor('nobody', DOC)).toEqual({
            ok: false,
            reason: 'unknown-editor'
        })
    })

    it('anchors the new findings against the CURRENT text, not the run snapshot', async () => {
        const edited = `PREFIX ${DOC}`
        const { spec } = perAttempt('alpha', [
            (runId) => [result(runId, [])],
            (runId) => [result(runId, [raw({ quote: 'quick brown', edits: [] })])]
        ])
        const controller = new RunController()
        const run = controller.startRun({ snapshot: snapshot(), editors: [spec] })
        await run.settled
        run.continueEditor('alpha', edited)
        await Bun.sleep(5)
        const anchored = run.findings.list()[0]
        expect(anchored?.anchor).not.toBeNull()
        expect(edited.slice(anchored?.anchor?.from ?? 0, anchored?.anchor?.to ?? 0)).toBe(
            'quick brown'
        )
    })

    it('re-opens a panel’s scorecard: it named what the members found', async () => {
        const { spec } = perAttempt('alpha', [
            (runId) => [result(runId, [raw()])],
            (runId) => [result(runId, [])]
        ])
        const controller = new RunController()
        const run = controller.startRun({
            snapshot: snapshot(),
            editors: [spec],
            panel: {
                panelId: 'panel-1',
                panelName: 'Pre-publish review',
                aggregate: async function* (request) {
                    await Promise.resolve()
                    yield {
                        type: 'result',
                        runId: request.runId,
                        result: {
                            kind: 'aggregate-panel',
                            memberVerdicts: [],
                            missingMembers: [],
                            topFixes: [],
                            dissent: [],
                            recommendation: 'needs-work',
                            rationale: 'Some work'
                        }
                    }
                }
            }
        })
        await run.panelSettled
        expect(run.getPanelState()?.status).toBe('done')

        run.continueEditor('alpha', DOC)
        expect(run.getPanelState()?.status).toBe('waiting')
        // KEPT, marked stale: a continuation only appends, so every finding
        // the scorecard weighed is still on the note — discarding it would
        // throw away a synthesis the user paid for.
        expect(run.getPanelState()?.result).not.toBeNull()
        expect(run.getPanelState()?.resultStale).toBeTrue()
        await Bun.sleep(10)
        expect(run.getPanelState()?.status).toBe('done')
        expect(run.getPanelState()?.resultStale).toBeFalse()
    })

    it('keeps the scorecard when the continuation it re-opened is cancelled', async () => {
        // The failure the asymmetry exists for: the editor goes back to `done`
        // with its findings intact, so the run must not end with no scorecard.
        const { spec } = perAttempt('alpha', [
            (runId) => [result(runId, [raw()])],
            (runId) => [result(runId, [])]
        ])
        const controller = new RunController()
        const run = controller.startRun({
            snapshot: snapshot(),
            editors: [spec],
            panel: {
                panelId: 'panel-1',
                panelName: 'Pre-publish review',
                aggregate: async function* (request) {
                    await Promise.resolve()
                    yield {
                        type: 'result',
                        runId: request.runId,
                        result: {
                            kind: 'aggregate-panel',
                            memberVerdicts: [],
                            missingMembers: [],
                            topFixes: [],
                            dissent: [],
                            recommendation: 'needs-work',
                            rationale: 'Some work'
                        }
                    }
                }
            }
        })
        await run.panelSettled
        run.continueEditor('alpha', DOC)
        run.cancelRun()
        expect(run.getEditorState('alpha')?.status).toBe('done')
        expect(run.getPanelState()?.status).toBe('cancelled')
        expect(run.getPanelState()?.result).not.toBeNull()
        expect(run.getPanelState()?.resultStale).toBeTrue()
    })

    it('reports the run as busy while the scorecard is being written', async () => {
        // Every cancel/busy gate keys on `isBusy`: during aggregation the
        // editors are all terminal, so `isSettled` alone would hide Cancel and
        // let a new run replace a request the user is paying for.
        let releaseAggregation = (): void => undefined
        const gate = new Promise<void>((resolve) => {
            releaseAggregation = resolve
        })
        const controller = new RunController()
        const run = controller.startRun({
            snapshot: snapshot(),
            editors: [scriptedEditor('alpha', (runId) => [result(runId, [])])],
            panel: {
                panelId: 'panel-1',
                panelName: 'Pre-publish review',
                aggregate: async function* (request) {
                    await gate
                    yield {
                        type: 'result',
                        runId: request.runId,
                        result: {
                            kind: 'aggregate-panel',
                            memberVerdicts: [],
                            missingMembers: [],
                            topFixes: [],
                            dissent: [],
                            recommendation: 'publish'
                        }
                    }
                }
            }
        })
        await run.settled
        expect(run.isSettled()).toBeTrue()
        expect(run.isBusy()).toBeTrue()
        releaseAggregation()
        await run.panelSettled
        expect(run.isBusy()).toBeFalse()
    })

    it('carries the member roster so the scorecard can be checked against it', async () => {
        const controller = new RunController()
        const run = controller.startRun({
            snapshot: snapshot(),
            editors: [
                scriptedEditor('alpha', (runId) => [result(runId, [])]),
                scriptedEditor('beta', (runId) => [result(runId, [])])
            ],
            panel: { panelId: 'panel-1', panelName: 'Pre-publish review' }
        })
        await run.panelSettled
        expect(run.getPanelState()?.memberNames).toEqual(['Editor alpha', 'Editor beta'])
    })
})

// ---------------------------------------------------------------------------
// Contract v2: per-edit anchoring, salvage reporting, thread revisions
// ---------------------------------------------------------------------------

describe('RunController per-edit anchoring (contract v2)', () => {
    // DOC = 'The quick brown fox jumps over the lazy dog. The fox is fast.'
    it('an edit without its own quote copies the finding anchor; one with a quote anchors itself', async () => {
        const controller = new RunController()
        const editor = scriptedEditor('v2', (runId) => [
            result(runId, [
                raw({
                    quote: 'quick brown',
                    edits: [
                        { op: 'replace', text: 'swift auburn' },
                        { op: 'insert-before', quote: 'lazy dog', text: 'famously ' }
                    ]
                })
            ])
        ])
        const run = controller.startRun({ snapshot: snapshot(), editors: [editor] })
        await run.settled
        const tracked = run.findings.list()[0]
        expect(tracked?.anchor).toEqual({ from: 4, to: 15, state: 'anchored' })
        expect(tracked?.edits).toHaveLength(2)
        // Own-quote-less edit: the finding's anchor, copied.
        expect(tracked?.edits[0]?.anchor).toEqual({ from: 4, to: 15, state: 'anchored' })
        expect(tracked?.edits[0]?.anchoredText).toEqual('quick brown')
        // Own-quote edit: anchored independently ('lazy dog' at [35, 43)).
        expect(tracked?.edits[1]?.anchor).toEqual({ from: 35, to: 43, state: 'anchored' })
        expect(tracked?.edits[1]?.anchoredText).toEqual('lazy dog')
        // The whole proposal is applicable — accept returns both changes.
        const accepted = run.findings.accept(tracked!.id, DOC)
        expect(accepted.ok).toBeTrue()
        if (accepted.ok) {
            expect(accepted.changes).toEqual([
                { from: 4, to: 15, insert: 'swift auburn' },
                { from: 35, to: 35, insert: 'famously ' }
            ])
        }
    })

    it('an edit whose own quote cannot be located leaves the WHOLE proposal display-only', async () => {
        const controller = new RunController()
        const editor = scriptedEditor('v2-miss', (runId) => [
            result(runId, [
                raw({
                    quote: 'quick brown',
                    edits: [
                        { op: 'replace', text: 'swift auburn' },
                        { op: 'delete', quote: 'not in the document' }
                    ]
                })
            ])
        ])
        const run = controller.startRun({ snapshot: snapshot(), editors: [editor] })
        await run.settled
        const tracked = run.findings.list()[0]
        expect(tracked?.anchor).not.toBeNull()
        expect(tracked?.edits[1]?.anchor).toBeNull()
        expect(run.findings.isActionable(tracked!.id)).toBeFalse()
    })
})

describe('RunController salvage reporting (contract v2)', () => {
    it('records the result event salvage on the editor state, accumulating across passes', async () => {
        const controller = new RunController()
        const editor: RunEditorSpec = {
            editorId: 'salvager',
            editorName: 'Salvager',
            execute: async function* (request) {
                await Promise.resolve()
                yield {
                    type: 'result',
                    runId: request.runId,
                    result: { kind: 'review', findings: [raw()] },
                    salvage: { discardedFindings: 2, invalidProposals: 1 }
                }
            }
        }
        const run = controller.startRun({ snapshot: snapshot(), editors: [editor] })
        await run.settled
        expect(run.getEditorState('salvager')?.salvage).toEqual({
            discardedFindings: 2,
            invalidProposals: 1
        })
    })

    it('stays null when nothing was salvaged', async () => {
        const controller = new RunController()
        const run = controller.startRun({
            snapshot: snapshot(),
            editors: [scriptedEditor('clean', (runId) => [result(runId, [raw()])])]
        })
        await run.settled
        expect(run.getEditorState('clean')?.salvage).toBeNull()
    })
})

describe('RunController thread revisions (contract v2)', () => {
    function threadExecutor(
        resultBody: Omit<Extract<OperationResult, { kind: 'thread-turn' }>, 'kind'>
    ): (request: ThreadTurnRequest, signal: AbortSignal) => AsyncIterable<OperationEvent> {
        return async function* (request) {
            await Promise.resolve()
            yield {
                type: 'result',
                runId: request.runId,
                result: { kind: 'thread-turn', ...resultBody }
            }
        }
    }

    it('anchors revisedEdits against the live text supplied by currentText', async () => {
        const controller = new RunController()
        const run = controller.startRun({
            snapshot: snapshot(),
            editors: [scriptedEditor('rev', (runId) => [result(runId, [raw()])])]
        })
        await run.settled
        const tracked = run.findings.list()[0]!
        const begun = run.startThreadTurn({
            findingId: tracked.id,
            message: 'push back',
            quote: 'quick brown',
            currentText: () => DOC,
            execute: threadExecutor({
                reply: 'Revised.',
                concede: false,
                revisedEdits: [{ op: 'insert-after', quote: 'lazy dog', text: '!' }]
            })
        })
        expect(begun.ok).toBeTrue()
        if (!begun.ok) return
        const resolution = await begun.settled
        expect(resolution.status).toEqual('held')
        const revised = run.findings.get(tracked.id)
        expect(revised?.edits).toHaveLength(1)
        expect(revised?.edits[0]?.anchor).toEqual({ from: 35, to: 43, state: 'anchored' })
        expect(run.findings.isActionable(tracked.id)).toBeTrue()
    })

    it('degrades a revision to display-only when no live text is available', async () => {
        const controller = new RunController()
        const run = controller.startRun({
            snapshot: snapshot(),
            editors: [scriptedEditor('rev2', (runId) => [result(runId, [raw()])])]
        })
        await run.settled
        const tracked = run.findings.list()[0]!
        const begun = run.startThreadTurn({
            findingId: tracked.id,
            message: 'push back',
            quote: 'quick brown',
            currentText: () => null,
            execute: threadExecutor({
                reply: 'Revised.',
                concede: false,
                revisedEdits: [{ op: 'replace', text: 'anything' }]
            })
        })
        expect(begun.ok).toBeTrue()
        if (!begun.ok) return
        await begun.settled
        expect(run.findings.get(tracked.id)?.edits[0]?.anchor).toBeNull()
        expect(run.findings.isActionable(tracked.id)).toBeFalse()
    })
})

describe('RunController cross-run carryover (issue #19)', () => {
    /** Editor whose stream waits for an external gate before yielding. */
    function gatedEditor(
        editorId: string,
        gate: Promise<void>,
        script: (runId: string) => OperationEvent[]
    ): RunEditorSpec {
        return {
            editorId,
            editorName: `Editor ${editorId}`,
            execute: async function* (request) {
                await gate
                yield* script(request.runId)
            }
        }
    }

    async function firstRunWithFinding(
        controller: RunController,
        rawFinding: RawFinding = raw(),
        editorId = 'alpha'
    ) {
        const editor = scriptedEditor(editorId, (runId) => [
            finding(runId, rawFinding),
            result(runId, [])
        ])
        const run = controller.startRun({ snapshot: snapshot(), editors: [editor] })
        await run.settled
        const tracked = run.findings.listByEditor(editorId)
        expect(tracked).toHaveLength(1)
        return { run, tracked: tracked[0]! }
    }

    it('keeps the previous findings on screen (dimmed) while the new run prepares', async () => {
        const controller = new RunController()
        const { tracked } = await firstRunWithFinding(controller)
        const gate = deferred()
        const run2 = controller.startRun({
            snapshot: snapshot(),
            editors: [gatedEditor('alpha', gate.promise, (runId) => [result(runId, [])])]
        })
        // Before anything streams: the old finding is present, flagged, listed
        // for its editor, re-anchored against the new snapshot.
        const carried = run2.findings.get(tracked.id)
        expect(carried).not.toBeNull()
        expect(carried?.carryover).toBeTrue()
        expect(carried?.status).toEqual('open')
        expect(carried?.anchor).toEqual({ from: 4, to: 15, state: 'anchored' })
        expect(run2.getEditorState('alpha')?.findingIds).toEqual([tracked.id])
        gate.resolve()
        await run2.settled
    })

    it('an unchanged observation keeps its id and refreshes from the new round', async () => {
        const controller = new RunController()
        const { tracked } = await firstRunWithFinding(controller)
        const repeat = raw({ edits: [{ op: 'delete' }] }) // same observation, new proposal
        const run2 = controller.startRun({
            snapshot: snapshot(),
            editors: [
                scriptedEditor('alpha', (runId) => [finding(runId, repeat), result(runId, [])])
            ]
        })
        await run2.settled
        const findings = run2.findings.listByEditor('alpha')
        expect(findings).toHaveLength(1)
        expect(findings[0]?.id).toEqual(tracked.id)
        expect(findings[0]?.carryover).toBeFalse()
        expect(findings[0]?.status).toEqual('open')
        expect(findings[0]?.raw.edits).toEqual([{ op: 'delete' }])
        expect(run2.getEditorState('alpha')?.findingIds).toEqual([tracked.id])
    })

    it('a dismissed finding stays dismissed when the observation is repeated verbatim', async () => {
        const controller = new RunController()
        const { run, tracked } = await firstRunWithFinding(controller)
        run.findings.dismiss(tracked.id)
        const run2 = controller.startRun({
            snapshot: snapshot(),
            editors: [
                scriptedEditor('alpha', (runId) => [finding(runId, raw()), result(runId, [])])
            ]
        })
        await run2.settled
        const findings = run2.findings.listByEditor('alpha')
        expect(findings).toHaveLength(1)
        expect(findings[0]?.id).toEqual(tracked.id)
        expect(findings[0]?.status).toEqual('dismissed')
        expect(findings[0]?.carryover).toBeFalse()
    })

    it('a dismissed finding does not resurrect via a reworded critique on the same span', async () => {
        const controller = new RunController()
        const { run, tracked } = await firstRunWithFinding(controller)
        run.findings.dismiss(tracked.id)
        const reworded = raw({ critique: 'Entirely different wording, same objection' })
        const run2 = controller.startRun({
            snapshot: snapshot(),
            editors: [
                scriptedEditor('alpha', (runId) => [finding(runId, reworded), result(runId, [])])
            ]
        })
        await run2.settled
        const findings = run2.findings.listByEditor('alpha')
        expect(findings).toHaveLength(1)
        expect(findings[0]?.id).toEqual(tracked.id)
        expect(findings[0]?.status).toEqual('dismissed')
        expect(findings[0]?.raw.critique).toEqual('Entirely different wording, same objection')
    })

    it('an accepted finding repeated by the re-run is dropped as stale', async () => {
        const controller = new RunController()
        const { run, tracked } = await firstRunWithFinding(controller)
        const accepted = run.findings.accept(tracked.id, DOC)
        expect(accepted.ok).toBeTrue()
        const run2 = controller.startRun({
            snapshot: snapshot(),
            editors: [
                scriptedEditor('alpha', (runId) => [finding(runId, raw()), result(runId, [])])
            ]
        })
        await run2.settled
        const findings = run2.findings.listByEditor('alpha')
        // Only the accepted record remains — the repeat did not enter.
        expect(findings).toHaveLength(1)
        expect(findings[0]?.id).toEqual(tracked.id)
        expect(findings[0]?.status).toEqual('accepted')
    })

    it('an observation the re-run no longer reports is dropped when the round completes', async () => {
        const controller = new RunController()
        const { tracked } = await firstRunWithFinding(controller)
        const other = raw({ quote: 'lazy dog', critique: 'Cliché', edits: [] })
        const run2 = controller.startRun({
            snapshot: snapshot(),
            editors: [
                scriptedEditor('alpha', (runId) => [finding(runId, other), result(runId, [])])
            ]
        })
        await run2.settled
        const findings = run2.findings.listByEditor('alpha')
        expect(findings).toHaveLength(1)
        expect(findings[0]?.raw.quote).toEqual('lazy dog')
        expect(run2.findings.get(tracked.id)).toBeNull()
        expect(run2.getEditorState('alpha')?.findingIds).not.toContain(tracked.id)
    })

    it('a failed re-run keeps the previous findings, un-dimmed', async () => {
        const controller = new RunController()
        const { tracked } = await firstRunWithFinding(controller)
        const run2 = controller.startRun({
            snapshot: snapshot(),
            editors: [
                scriptedEditor('alpha', (runId) => [
                    { type: 'error', runId, error: { code: 'network', message: 'boom' } }
                ])
            ]
        })
        await run2.settled
        const carried = run2.findings.get(tracked.id)
        expect(carried).not.toBeNull()
        expect(carried?.carryover).toBeFalse()
        expect(carried?.status).toEqual('open')
    })

    it('cancelling a re-run keeps the previous findings, un-dimmed', async () => {
        const controller = new RunController()
        const { tracked } = await firstRunWithFinding(controller)
        const gate = deferred()
        const run2 = controller.startRun({
            snapshot: snapshot(),
            editors: [gatedEditor('alpha', gate.promise, (runId) => [result(runId, [])])]
        })
        expect(run2.findings.get(tracked.id)?.carryover).toBeTrue()
        run2.cancelRun()
        expect(run2.findings.get(tracked.id)?.carryover).toBeFalse()
        expect(run2.findings.get(tracked.id)?.status).toEqual('open')
        gate.resolve()
        await run2.settled
    })

    it('a selection-scoped re-run never drops carried findings outside its range', async () => {
        const controller = new RunController()
        const inScope = raw() // 'quick brown' → [4, 15)
        const outOfScope = raw({ quote: 'lazy dog', critique: 'Cliché', edits: [] })
        const editor = scriptedEditor('alpha', (runId) => [
            finding(runId, inScope),
            finding(runId, outOfScope),
            result(runId, [])
        ])
        const run1 = controller.startRun({ snapshot: snapshot(), editors: [editor] })
        await run1.settled
        expect(run1.findings.list()).toHaveLength(2)
        // Re-review ONLY the 'quick brown' span, reporting nothing.
        const run2 = controller.startRun({
            snapshot: snapshot(DOC, { from: 4, to: 15 }),
            editors: [scriptedEditor('alpha', (runId) => [result(runId, [])])]
        })
        await run2.settled
        const remaining = run2.findings.listByEditor('alpha')
        expect(remaining).toHaveLength(1)
        expect(remaining[0]?.raw.quote).toEqual('lazy dog')
        expect(remaining[0]?.carryover).toBeFalse()
    })

    it('a per-editor retry re-dims carried findings instead of destroying them', async () => {
        const controller = new RunController()
        const { run, tracked } = await firstRunWithFinding(controller)
        run.findings.dismiss(tracked.id)
        let attempt = 0
        const flaky: RunEditorSpec = {
            editorId: 'alpha',
            editorName: 'Alpha',
            execute: async function* (request) {
                await Promise.resolve()
                attempt += 1
                if (attempt === 1) {
                    yield {
                        type: 'error',
                        runId: request.runId,
                        error: { code: 'network', message: 'boom' }
                    } as OperationEvent
                    return
                }
                yield finding(request.runId, raw())
                yield result(request.runId, [])
            }
        }
        const run2 = controller.startRun({ snapshot: snapshot(), editors: [flaky] })
        await run2.settled
        // Failed round: carried finding kept, un-dimmed.
        expect(run2.findings.get(tracked.id)?.carryover).toBeFalse()
        const retried = run2.retryEditor('alpha', DOC)
        expect(retried.ok).toBeTrue()
        // Wait for the retry loop to settle.
        while (!run2.isSettled()) {
            await Bun.sleep(1)
        }
        const findings = run2.findings.listByEditor('alpha')
        expect(findings).toHaveLength(1)
        expect(findings[0]?.id).toEqual(tracked.id)
        expect(findings[0]?.status).toEqual('dismissed')
        expect(findings[0]?.carryover).toBeFalse()
    })

    it('findings of an editor not part of the new run are not carried', async () => {
        const controller = new RunController()
        const { tracked } = await firstRunWithFinding(controller)
        const run2 = controller.startRun({
            snapshot: snapshot(),
            editors: [scriptedEditor('beta', (runId) => [result(runId, [])])]
        })
        await run2.settled
        expect(run2.findings.get(tracked.id)).toBeNull()
    })

    it('carryover from a quote the note no longer contains degrades to display-only', async () => {
        const controller = new RunController()
        const { tracked } = await firstRunWithFinding(controller)
        const gate = deferred()
        const changed = 'A completely different document now.'
        const run2 = controller.startRun({
            snapshot: createSnapshot({ filePath: 'notes/test.md', text: changed }),
            editors: [gatedEditor('alpha', gate.promise, (runId) => [result(runId, [])])]
        })
        const carried = run2.findings.get(tracked.id)
        expect(carried?.anchor).toBeNull()
        expect(carried?.edits.every((edit) => edit.anchor === null)).toBeTrue()
        gate.resolve()
        await run2.settled
    })
})

describe('RunController history observer (issue #21)', () => {
    function observerHarness(): {
        settled: { editorId: string; findings: number; quotes: string[] }[]
        observer: import('./run-controller').RunObserver
    } {
        const settled: { editorId: string; findings: number; quotes: string[] }[] = []
        return {
            settled,
            observer: {
                editorSettled: (input) => {
                    settled.push({
                        editorId: input.editorId,
                        findings: input.findings.length,
                        quotes: input.findings.map((f) => f.raw.quote)
                    })
                },
                threadSettled: () => undefined,
                panelSettled: () => undefined
            }
        }
    }

    it('reports a completed pass once, with the findings it produced', async () => {
        const { settled, observer } = observerHarness()
        const controller = new RunController(undefined, observer)
        const run = controller.startRun({
            snapshot: snapshot(),
            editors: [
                scriptedEditor('alpha', (runId) => [finding(runId, raw()), result(runId, [])])
            ]
        })
        await run.settled
        expect(settled).toEqual([{ editorId: 'alpha', findings: 1, quotes: ['quick brown'] }])
    })

    it('reports nothing for a failed editor', async () => {
        const { settled, observer } = observerHarness()
        const controller = new RunController(undefined, observer)
        const run = controller.startRun({
            snapshot: snapshot(),
            editors: [
                scriptedEditor('alpha', (runId) => [
                    finding(runId, raw()),
                    { type: 'error', runId, error: { code: 'network', message: 'boom' } }
                ])
            ]
        })
        await run.settled
        expect(settled).toEqual([])
    })

    it('a re-run reports its round even when carryover adopted the finding', async () => {
        const { settled, observer } = observerHarness()
        const controller = new RunController(undefined, observer)
        const editor = scriptedEditor('alpha', (runId) => [
            finding(runId, raw()),
            result(runId, [])
        ])
        const run1 = controller.startRun({ snapshot: snapshot(), editors: [editor] })
        await run1.settled
        const run2 = controller.startRun({ snapshot: snapshot(), editors: [editor] })
        await run2.settled
        // Two rounds, one report each — the HISTORY dedupe (verbatim-repeat
        // key) is the service's job, not the observer's.
        expect(settled).toHaveLength(2)
    })
})

describe('RunHandle.addEditor (joining a run, 2026-08-04)', () => {
    async function waitUntil(condition: () => boolean): Promise<void> {
        for (let i = 0; i < 200 && !condition(); i++) {
            await Bun.sleep(1)
        }
        expect(condition()).toBeTrue()
    }

    it('queues onto a BUSY run without disturbing the editor in flight', async () => {
        const gate = deferred()
        const alpha: RunEditorSpec = {
            editorId: 'alpha',
            editorName: 'Alpha',
            execute: async function* (request) {
                await gate.promise
                yield result(request.runId, [])
            }
        }
        const run = new RunController().startRun({ snapshot: snapshot(), editors: [alpha] })
        const beta = scriptedEditor('beta', (runId) => [finding(runId, raw()), result(runId, [])])
        expect(run.addEditor(beta, DOC)).toEqual({ ok: true })
        await waitUntil(() => run.getEditorState('beta')?.status === 'done')
        // Beta landed its finding while alpha is STILL working: nothing was
        // cancelled, and the run stays unsettled until alpha finishes.
        expect(run.findings.listByEditor('beta')).toHaveLength(1)
        expect(run.isSettled()).toBeFalse()
        gate.resolve()
        await waitUntil(() => run.isSettled())
        expect(run.getEditorState('alpha')?.status).toBe('done')
    })

    it('joins a SETTLED run and flips it back to in-progress', async () => {
        const alpha = scriptedEditor('alpha', (runId) => [result(runId, [])])
        const run = new RunController().startRun({ snapshot: snapshot(), editors: [alpha] })
        await run.settled
        expect(run.isSettled()).toBeTrue()
        const beta = scriptedEditor('beta', (runId) => [result(runId, [], 'Beta summary')])
        expect(run.addEditor(beta, DOC)).toEqual({ ok: true })
        expect(run.isSettled()).toBeFalse()
        await waitUntil(() => run.isSettled())
        expect(run.getEditorState('beta')?.summary).toBe('Beta summary')
    })

    it('refuses an editor already in the run, whatever its status', async () => {
        const alpha = scriptedEditor('alpha', (runId) => [result(runId, [])])
        const run = new RunController().startRun({ snapshot: snapshot(), editors: [alpha] })
        await run.settled
        expect(
            run.addEditor(
                scriptedEditor('alpha', () => []),
                DOC
            )
        ).toEqual({
            ok: false,
            reason: 'already-in-run'
        })
    })

    it('cancelRun aborts a joined attempt like any other', async () => {
        const gate = deferred()
        const alpha = scriptedEditor('alpha', (runId) => [result(runId, [])])
        const run = new RunController().startRun({ snapshot: snapshot(), editors: [alpha] })
        await run.settled
        const beta: RunEditorSpec = {
            editorId: 'beta',
            editorName: 'Beta',
            execute: async function* (request) {
                await gate.promise
                yield result(request.runId, [])
            }
        }
        expect(run.addEditor(beta, DOC)).toEqual({ ok: true })
        run.cancelRun()
        expect(run.getEditorState('beta')?.status).toBe('cancelled')
        expect(run.isSettled()).toBeTrue()
        gate.resolve()
    })
})
