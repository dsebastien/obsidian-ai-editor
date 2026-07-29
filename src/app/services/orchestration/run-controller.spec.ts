import { describe, expect, it } from 'bun:test'
import { asFindingId } from '../../domain/ids'
import { createSnapshot } from '../../domain/snapshot'
import type { OperationEvent, RawFinding, ReviewRequest } from '../../domain/operations/contract'
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
        suggestion: 'swift auburn',
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
                raw({ quote: 'lazy dog', critique: 'Cliché', suggestion: 'idle hound' })
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
        const bufferedOnly = raw({ quote: 'lazy dog', critique: 'Other', suggestion: undefined })
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
            suggestion: undefined,
            occurrence: 0
        })
        const second = raw({
            quote: 'fox',
            critique: 'Overused',
            suggestion: undefined,
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
        // Let the first finding land.
        await Promise.resolve()
        await Promise.resolve()
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
                    result: { kind: 'refine-proposal', suggestion: 'nope' }
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
            result(runId, [raw({ quote: 'The', suggestion: 'A' })])
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
                raw({ quote: 'The', prefix: 'lazy dog. ', suggestion: 'A' }),
                raw({ quote: 'fox', occurrence: 1, critique: 'Second fox', suggestion: 'vixen' })
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
                raw({ quote: 'lazy dog', critique: 'Cliché', suggestion: 'idle hound' }) // [35, 43)
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
        expect(run.findings.accept(staled!.id, DOC)).toEqual({ ok: false, reason: 'stale' })

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
                    raw({ quote: 'lazy dog', critique: 'Cliché', suggestion: 'idle hound' })
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
        expect(run.findings.accept(tracked!.id, edited)).toEqual({ ok: false, reason: 'stale' })
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
            reason: 'precondition-failed'
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
