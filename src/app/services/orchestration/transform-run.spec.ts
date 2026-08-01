import { describe, expect, it } from 'bun:test'
import { CONTRACT_VERSION, type OperationEvent } from '../../domain/operations/contract'
import { createSnapshot, hashText } from '../../domain/snapshot'
import { Semaphore } from './semaphore'
import {
    TransformController,
    type StartTransformInput,
    type TransformOperationRequest
} from './transform-run'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const DOC_TEXT = 'Intro paragraph. The selected middle part. Closing words.'
const SELECTION = { from: 17, to: 42 } // 'The selected middle part.'
const SPAN_TEXT = DOC_TEXT.slice(SELECTION.from, SELECTION.to)

function makeSnapshot(text = DOC_TEXT, filePath = 'Notes/Test.md') {
    return createSnapshot({ filePath, text })
}

function transformRequest(runId = 'run-t1', text = DOC_TEXT): TransformOperationRequest {
    return {
        kind: 'transform-selection',
        contractVersion: CONTRACT_VERSION,
        runId,
        snapshotHash: hashText(text),
        text,
        selection: { ...SELECTION },
        instruction: 'Rephrase the selected text.'
    }
}

function insertRequest(runId = 'run-i1', text = DOC_TEXT): TransformOperationRequest {
    return {
        kind: 'insert-at',
        contractVersion: CONTRACT_VERSION,
        runId,
        snapshotHash: hashText(text),
        text,
        position: text.length,
        instruction: 'Continue writing.'
    }
}

function eventsExecutor(events: readonly OperationEvent[]) {
    return async function* execute(): AsyncGenerator<OperationEvent> {
        await Promise.resolve()
        for (const event of events) {
            yield event
        }
    }
}

function makeInput(overrides: Partial<StartTransformInput> = {}): StartTransformInput {
    const snapshot = overrides.snapshot ?? makeSnapshot()
    const request = overrides.request ?? transformRequest()
    return {
        snapshot,
        request,
        target:
            request.kind === 'transform-selection'
                ? {
                      kind: 'replace-span',
                      from: request.selection.from,
                      to: request.selection.to,
                      spanText: snapshot.text.slice(request.selection.from, request.selection.to),
                      spanHash: hashText(
                          snapshot.text.slice(request.selection.from, request.selection.to)
                      )
                  }
                : { kind: 'insert-at', position: request.position, docHash: snapshot.hash },
        editorId: 'editor-1',
        editorName: 'Concision Editor',
        execute: eventsExecutor([
            {
                type: 'result',
                runId: request.runId,
                result: {
                    kind: 'transform-selection',
                    replacement: 'A better middle part.',
                    evidence: []
                }
            }
        ]),
        ...overrides
    }
}

/** Executor that stays open until `finish` is called (permit/cancel tests). */
function pendingExecutor(runId: string) {
    let resolveGate: () => void = () => undefined
    const gate = new Promise<void>((resolve) => {
        resolveGate = resolve
    })
    const execute = async function* execute(): AsyncGenerator<OperationEvent> {
        await gate
        yield {
            type: 'result',
            runId,
            result: { kind: 'transform-selection', replacement: 'done', evidence: [] }
        } satisfies OperationEvent
    }
    return { execute, finish: () => resolveGate() }
}

async function tick(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 0))
}

// ---------------------------------------------------------------------------
// Result flow
// ---------------------------------------------------------------------------

describe('TransformRunHandle results', () => {
    it('runs a transform-selection operation to a done outcome', async () => {
        const controller = new TransformController()
        const notifications: string[] = []
        const run = controller.startTransform(
            makeInput({
                execute: eventsExecutor([
                    { type: 'progress', runId: 'run-t1', message: 'thinking' },
                    {
                        type: 'result',
                        runId: 'run-t1',
                        result: {
                            kind: 'transform-selection',
                            replacement: 'A better middle part.',
                            rationale: 'Tighter phrasing',
                            evidence: []
                        }
                    }
                ])
            })
        )
        run.subscribe(() => notifications.push(run.getState().status))
        await run.settled
        const state = run.getState()
        expect(state.status).toBe('done')
        expect(state.outcome).toEqual({
            text: 'A better middle part.',
            rationale: 'Tighter phrasing'
        })
        expect(state.error).toBeNull()
        expect(run.isSettled()).toBe(true)
        expect(notifications).toContain('done')
        // No label provided → null; the UI falls back to a kind-based title.
        expect(run.actionLabel).toBeNull()
    })

    it('exposes the caller-provided action label on the handle', () => {
        const controller = new TransformController()
        const run = controller.startTransform(makeInput({ actionLabel: 'Rephrase' }))
        expect(run.actionLabel).toBe('Rephrase')
        run.cancel()
    })

    it('runs an insert-at operation and surfaces the insertion as the outcome', async () => {
        const controller = new TransformController()
        const request = insertRequest()
        const run = controller.startTransform(
            makeInput({
                request,
                execute: eventsExecutor([
                    {
                        type: 'result',
                        runId: request.runId,
                        result: { kind: 'insert-at', insertion: ' And then some.', evidence: [] }
                    }
                ])
            })
        )
        await run.settled
        expect(run.kind).toBe('insert-at')
        expect(run.getState().status).toBe('done')
        expect(run.getState().outcome?.text).toBe(' And then some.')
        expect(run.getState().outcome?.rationale).toBeNull()
    })

    it('records progress messages while running', async () => {
        const controller = new TransformController()
        const run = controller.startTransform(
            makeInput({
                execute: eventsExecutor([
                    { type: 'progress', runId: 'run-t1', message: 'drafting' },
                    {
                        type: 'result',
                        runId: 'run-t1',
                        result: { kind: 'transform-selection', replacement: 'x', evidence: [] }
                    }
                ])
            })
        )
        await run.settled
        expect(run.getState().lastProgress).toBe('drafting')
    })
})

// ---------------------------------------------------------------------------
// Protocol enforcement
// ---------------------------------------------------------------------------

describe('TransformRunHandle protocol', () => {
    it('fails with invalid-output when the result kind does not match the request', async () => {
        const controller = new TransformController()
        const run = controller.startTransform(
            makeInput({
                execute: eventsExecutor([
                    {
                        type: 'result',
                        runId: 'run-t1',
                        result: { kind: 'review', findings: [] }
                    }
                ])
            })
        )
        await run.settled
        expect(run.getState().status).toBe('error')
        expect(run.getState().error?.code).toBe('invalid-output')
        expect(run.getState().error?.message).toContain("'transform-selection'")
        expect(run.getState().outcome).toBeNull()
    })

    it('discards events carrying a foreign runId', async () => {
        const controller = new TransformController()
        const run = controller.startTransform(
            makeInput({
                execute: eventsExecutor([
                    {
                        type: 'result',
                        runId: 'other-run',
                        result: { kind: 'transform-selection', replacement: 'evil', evidence: [] }
                    },
                    {
                        type: 'result',
                        runId: 'run-t1',
                        result: { kind: 'transform-selection', replacement: 'good', evidence: [] }
                    }
                ])
            })
        )
        await run.settled
        expect(run.getState().status).toBe('done')
        expect(run.getState().outcome?.text).toBe('good')
    })

    it('discards events after the terminal event', async () => {
        const controller = new TransformController()
        const run = controller.startTransform(
            makeInput({
                execute: eventsExecutor([
                    {
                        type: 'result',
                        runId: 'run-t1',
                        result: { kind: 'transform-selection', replacement: 'first', evidence: [] }
                    },
                    {
                        type: 'error',
                        runId: 'run-t1',
                        error: { code: 'unknown', message: 'late failure' }
                    }
                ])
            })
        )
        await run.settled
        expect(run.getState().status).toBe('done')
        expect(run.getState().outcome?.text).toBe('first')
        expect(run.getState().error).toBeNull()
    })

    it('treats a stream ending without a terminal event as invalid-output', async () => {
        const controller = new TransformController()
        const run = controller.startTransform(
            makeInput({
                execute: eventsExecutor([{ type: 'progress', runId: 'run-t1' }])
            })
        )
        await run.settled
        expect(run.getState().status).toBe('error')
        expect(run.getState().error?.code).toBe('invalid-output')
    })

    it('ignores finding events (review-only) without failing the run', async () => {
        const controller = new TransformController()
        const run = controller.startTransform(
            makeInput({
                execute: eventsExecutor([
                    {
                        type: 'finding',
                        runId: 'run-t1',
                        finding: {
                            quote: 'The selected',
                            critique: 'off-contract',
                            edits: [],
                            invalidProposal: false,
                            severity: 'suggestion',
                            evidence: []
                        }
                    },
                    {
                        type: 'result',
                        runId: 'run-t1',
                        result: { kind: 'transform-selection', replacement: 'ok', evidence: [] }
                    }
                ])
            })
        )
        await run.settled
        expect(run.getState().status).toBe('done')
        expect(run.getState().outcome?.text).toBe('ok')
    })

    it('surfaces backend error events with their code, redacted', async () => {
        const controller = new TransformController()
        const run = controller.startTransform(
            makeInput({
                redactError: (message) => message.split('sk-secret').join('[redacted]'),
                execute: eventsExecutor([
                    {
                        type: 'error',
                        runId: 'run-t1',
                        error: { code: 'timeout', message: 'timed out with key sk-secret' }
                    }
                ])
            })
        )
        await run.settled
        expect(run.getState().status).toBe('error')
        expect(run.getState().error?.code).toBe('timeout')
        expect(run.getState().error?.message).toBe('timed out with key [redacted]')
    })

    it('redacts messages from thrown executor failures', async () => {
        const controller = new TransformController()
        const run = controller.startTransform(
            makeInput({
                redactError: (message) => message.split('sk-secret').join('[redacted]'),
                // eslint-disable-next-line require-yield
                execute: async function* execute(): AsyncGenerator<OperationEvent> {
                    await Promise.resolve()
                    throw new Error('boom sk-secret boom')
                }
            })
        )
        await run.settled
        expect(run.getState().status).toBe('error')
        expect(run.getState().error?.code).toBe('unknown')
        expect(run.getState().error?.message).toBe('boom [redacted] boom')
    })
})

// ---------------------------------------------------------------------------
// Cancellation & concurrency
// ---------------------------------------------------------------------------

describe('TransformRunHandle cancellation and concurrency', () => {
    it('cancel() aborts an in-flight run and discards its late result', async () => {
        const controller = new TransformController()
        const pending = pendingExecutor('run-t1')
        const run = controller.startTransform(makeInput({ execute: pending.execute }))
        await tick()
        expect(run.getState().status).toBe('running')
        run.cancel()
        expect(run.getState().status).toBe('cancelled')
        expect(run.isSettled()).toBe(true)
        pending.finish()
        await run.settled
        expect(run.getState().status).toBe('cancelled')
        expect(run.getState().outcome).toBeNull()
    })

    it('stays pending behind the shared gate and releases the permit on settle', async () => {
        const gate = new Semaphore(() => 1)
        const controller = new TransformController(gate)
        const first = pendingExecutor('run-a')
        const runA = controller.startTransform(
            makeInput({
                snapshot: makeSnapshot(DOC_TEXT, 'Notes/A.md'),
                request: transformRequest('run-a'),
                execute: first.execute
            })
        )
        const runB = controller.startTransform(
            makeInput({
                snapshot: makeSnapshot(DOC_TEXT, 'Notes/B.md'),
                request: transformRequest('run-b')
            })
        )
        await tick()
        expect(runA.getState().status).toBe('running')
        expect(runB.getState().status).toBe('pending')
        expect(gate.queuedCount()).toBe(1)
        first.finish()
        await runA.settled
        await runB.settled
        expect(runA.getState().status).toBe('done')
        expect(runB.getState().status).toBe('done')
        expect(gate.activeCount()).toBe(0)
    })

    it('cancelling a queued run ejects the waiter without consuming a permit', async () => {
        const gate = new Semaphore(() => 1)
        const controller = new TransformController(gate)
        const first = pendingExecutor('run-a')
        const runA = controller.startTransform(
            makeInput({
                snapshot: makeSnapshot(DOC_TEXT, 'Notes/A.md'),
                request: transformRequest('run-a'),
                execute: first.execute
            })
        )
        const runB = controller.startTransform(
            makeInput({
                snapshot: makeSnapshot(DOC_TEXT, 'Notes/B.md'),
                request: transformRequest('run-b')
            })
        )
        await tick()
        runB.cancel()
        await runB.settled
        expect(runB.getState().status).toBe('cancelled')
        expect(gate.queuedCount()).toBe(0)
        first.finish()
        await runA.settled
        expect(runA.getState().status).toBe('done')
        expect(gate.activeCount()).toBe(0)
    })

    it('releases the permit the moment the run terminates, before the stream closes', async () => {
        const gate = new Semaphore(() => 1)
        const controller = new TransformController(gate)
        // Executor whose stream NEVER ends: the permit must still be freed
        // when cancel() terminates the run.
        const run = controller.startTransform(
            makeInput({
                // eslint-disable-next-line require-yield
                execute: async function* execute(): AsyncGenerator<OperationEvent> {
                    await new Promise(() => undefined) // hangs forever
                }
            })
        )
        await tick()
        expect(gate.activeCount()).toBe(1)
        run.cancel()
        expect(gate.activeCount()).toBe(0)
    })
})

// ---------------------------------------------------------------------------
// Apply precondition (Business Rules #3/#4)
// ---------------------------------------------------------------------------

describe('TransformRunHandle.checkPrecondition', () => {
    async function doneTransformRun() {
        const controller = new TransformController()
        const run = controller.startTransform(makeInput())
        await run.settled
        return run
    }

    it('refuses while the run is not done', async () => {
        const controller = new TransformController()
        const pending = pendingExecutor('run-t1')
        const run = controller.startTransform(makeInput({ execute: pending.execute }))
        await tick()
        expect(run.checkPrecondition(DOC_TEXT)).toEqual({ ok: false, reason: 'not-done' })
        run.cancel()
        pending.finish() // let the stream close so `settled` resolves
        await run.settled
        expect(run.checkPrecondition(DOC_TEXT)).toEqual({ ok: false, reason: 'not-done' })
    })

    it('applies when the selected span is unchanged', async () => {
        const run = await doneTransformRun()
        const result = run.checkPrecondition(DOC_TEXT)
        expect(result.ok).toBe(true)
        if (result.ok) {
            expect(result.outcome.text).toBe('A better middle part.')
        }
    })

    it('still applies after edits strictly AFTER the span', async () => {
        const run = await doneTransformRun()
        const edited = `${DOC_TEXT} Plus a brand-new trailing sentence.`
        expect(run.checkPrecondition(edited).ok).toBe(true)
    })

    it('refuses when the span content changed', async () => {
        const run = await doneTransformRun()
        const edited = DOC_TEXT.replace(SPAN_TEXT, 'The MUTATED middle part..')
        expect(run.checkPrecondition(edited)).toEqual({ ok: false, reason: 'text-changed' })
    })

    it('refuses when an edit BEFORE the span shifts its offsets', async () => {
        const run = await doneTransformRun()
        expect(run.checkPrecondition(`X${DOC_TEXT}`)).toEqual({
            ok: false,
            reason: 'text-changed'
        })
    })

    it('refuses when the document shrank below the span', async () => {
        const run = await doneTransformRun()
        expect(run.checkPrecondition('short')).toEqual({ ok: false, reason: 'text-changed' })
    })

    it('insert-at applies only on a byte-identical document', async () => {
        const controller = new TransformController()
        const request = insertRequest()
        const run = controller.startTransform(
            makeInput({
                request,
                execute: eventsExecutor([
                    {
                        type: 'result',
                        runId: request.runId,
                        result: { kind: 'insert-at', insertion: 'more', evidence: [] }
                    }
                ])
            })
        )
        await run.settled
        expect(run.checkPrecondition(DOC_TEXT).ok).toBe(true)
        expect(run.checkPrecondition(`${DOC_TEXT} `)).toEqual({
            ok: false,
            reason: 'text-changed'
        })
    })
})

// ---------------------------------------------------------------------------
// Controller lifecycle
// ---------------------------------------------------------------------------

describe('TransformController', () => {
    it('replaces (and cancels) the previous run for the same file', async () => {
        const controller = new TransformController()
        const pending = pendingExecutor('run-t1')
        const first = controller.startTransform(makeInput({ execute: pending.execute }))
        await tick()
        const second = controller.startTransform(makeInput({ request: transformRequest('run-t2') }))
        expect(first.getState().status).toBe('cancelled')
        expect(controller.getRun('Notes/Test.md')).toBe(second)
        pending.finish()
        await second.settled
        expect(second.getState().status).toBe('done')
    })

    it('keeps runs of different files independent', async () => {
        const controller = new TransformController()
        const runA = controller.startTransform(
            makeInput({ snapshot: makeSnapshot(DOC_TEXT, 'Notes/A.md') })
        )
        const runB = controller.startTransform(
            makeInput({
                snapshot: makeSnapshot(DOC_TEXT, 'Notes/B.md'),
                request: transformRequest('run-b')
            })
        )
        await runA.settled
        await runB.settled
        expect(controller.getRun('Notes/A.md')).toBe(runA)
        expect(controller.getRun('Notes/B.md')).toBe(runB)
        expect(runA.getState().status).toBe('done')
        expect(runB.getState().status).toBe('done')
    })

    it('discardRun cancels and forgets the run', async () => {
        const controller = new TransformController()
        const pending = pendingExecutor('run-t1')
        const run = controller.startTransform(makeInput({ execute: pending.execute }))
        await tick()
        controller.discardRun('Notes/Test.md')
        expect(run.getState().status).toBe('cancelled')
        expect(controller.getRun('Notes/Test.md')).toBeNull()
        controller.discardRun('Notes/Test.md') // idempotent
    })

    it('discardUnder sweeps a folder and cancels what it sweeps', async () => {
        const controller = new TransformController()
        const inside = pendingExecutor('run-inside')
        const outside = pendingExecutor('run-outside')
        const runInside = controller.startTransform(
            makeInput({
                execute: inside.execute,
                snapshot: createSnapshot({ filePath: 'Notes/Sub/A.md', text: DOC_TEXT })
            })
        )
        const runOutside = controller.startTransform(
            makeInput({
                execute: outside.execute,
                snapshot: createSnapshot({ filePath: 'NotesArchive/B.md', text: DOC_TEXT })
            })
        )
        await tick()
        controller.discardUnder('Notes')
        expect(runInside.getState().status).toBe('cancelled')
        expect(controller.getRun('Notes/Sub/A.md')).toBeNull()
        expect(runOutside.getState().status).not.toBe('cancelled')
        expect(controller.getRun('NotesArchive/B.md')).toBe(runOutside)
    })

    it('cancelAll cancels and forgets every run', async () => {
        const controller = new TransformController()
        const pendingA = pendingExecutor('run-a')
        const pendingB = pendingExecutor('run-b')
        const runA = controller.startTransform(
            makeInput({
                snapshot: makeSnapshot(DOC_TEXT, 'Notes/A.md'),
                request: transformRequest('run-a'),
                execute: pendingA.execute
            })
        )
        const runB = controller.startTransform(
            makeInput({
                snapshot: makeSnapshot(DOC_TEXT, 'Notes/B.md'),
                request: transformRequest('run-b'),
                execute: pendingB.execute
            })
        )
        await tick()
        controller.cancelAll()
        expect(runA.getState().status).toBe('cancelled')
        expect(runB.getState().status).toBe('cancelled')
        expect(controller.getRun('Notes/A.md')).toBeNull()
        expect(controller.getRun('Notes/B.md')).toBeNull()
    })
})
