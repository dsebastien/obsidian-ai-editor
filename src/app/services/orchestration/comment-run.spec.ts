import { describe, expect, it } from 'bun:test'
import { CONTRACT_VERSION } from '../../domain/operations/contract'
import type { OperationEvent, RawFinding, ReviewRequest } from '../../domain/operations/contract'
import { hashText } from '../../domain/snapshot'
import { BackgroundRequestGate } from './background-gate'
import { CommentRunController } from './comment-run'
import type { StartCommentRunInput } from './comment-run'
import { Semaphore } from './semaphore'

const DOC_TEXT = 'Intro paragraph. The claim under review. Closing words.'

function request(runId = 'run-c1'): ReviewRequest {
    return {
        kind: 'review',
        contractVersion: CONTRACT_VERSION,
        runId,
        snapshotHash: hashText(DOC_TEXT),
        text: DOC_TEXT,
        selection: { from: 17, to: 40 }
    }
}

function finding(overrides: Partial<RawFinding> = {}): RawFinding {
    return {
        quote: 'The claim under review.',
        critique: 'Uncited.',
        edits: [],
        invalidProposal: false,
        severity: 'warning',
        evidence: [],
        ...overrides
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

/** An executor that never produces anything: the job stays in flight. */
function hangingExecutor(): () => AsyncIterable<OperationEvent> {
    return () => ({
        [Symbol.asyncIterator]: () => ({
            next: () => new Promise<IteratorResult<OperationEvent>>(() => undefined)
        })
    })
}

/** An executor whose transport fails before producing any event. */
function throwingExecutor(message: string): () => AsyncIterable<OperationEvent> {
    return () => ({
        [Symbol.asyncIterator]: () => ({
            next: () => Promise.reject(new Error(message))
        })
    })
}

/** Immediate-admission gate over an unlimited pool: the default for tests. */
function openGate(cap = Number.POSITIVE_INFINITY): BackgroundRequestGate {
    return new BackgroundRequestGate({
        gate: new Semaphore(() => cap),
        getLimit: () => cap,
        setTimer: (callback, ms) => Number(setTimeout(callback, ms)),
        clearTimer: (handle) => {
            clearTimeout(handle)
        },
        pollIntervalMs: 1
    })
}

function makeInput(overrides: Partial<StartCommentRunInput> = {}): StartCommentRunInput {
    const req = overrides.request ?? request()
    return {
        commentId: 'comment-1',
        notePath: 'Notes/Test.md',
        request: req,
        editorId: 'editor-1',
        editorName: 'Fact Checker',
        now: () => 1_000,
        execute: eventsExecutor([
            {
                type: 'result',
                runId: req.runId,
                result: { kind: 'review', findings: [finding()], summary: 'One uncited claim.' }
            }
        ]),
        ...overrides
    }
}

describe('background comment run', () => {
    it('collects the editor answer and reports done', async () => {
        const controller = new CommentRunController(openGate())
        const run = controller.start(makeInput())
        expect(run).not.toBeNull()
        expect(await run?.settled).toEqual('done')
        const state = run?.getState()
        expect(state?.status).toEqual('done')
        expect(state?.outcome?.findings).toHaveLength(1)
        expect(state?.outcome?.summary).toEqual('One uncited claim.')
    })

    it('times from when the request started, not from when it was parked', async () => {
        const controller = new CommentRunController(openGate())
        const run = controller.start(makeInput({ now: () => 42_000 }))
        expect(run?.getState().startedAt).toBeNull() // still pending
        await run?.settled
        expect(run?.getState().startedAt).toEqual(42_000)
    })

    it('merges streamed findings with the result payload, deduplicating', async () => {
        const req = request()
        const duplicate = finding()
        const other = finding({ quote: 'Closing words.', critique: 'Weak ending.' })
        const controller = new CommentRunController(openGate())
        const run = controller.start(
            makeInput({
                request: req,
                execute: eventsExecutor([
                    { type: 'finding', runId: req.runId, finding: duplicate },
                    {
                        type: 'result',
                        runId: req.runId,
                        result: { kind: 'review', findings: [duplicate, other] }
                    }
                ])
            })
        )
        await run?.settled
        expect(run?.getState().outcome?.findings).toHaveLength(2)
    })

    it('keeps findings on different occurrences of the same quote distinct', async () => {
        const req = request()
        const first = finding({ occurrence: 0 })
        const second = finding({ occurrence: 1 })
        const controller = new CommentRunController(openGate())
        const run = controller.start(
            makeInput({
                request: req,
                execute: eventsExecutor([
                    { type: 'finding', runId: req.runId, finding: first },
                    { type: 'finding', runId: req.runId, finding: second },
                    { type: 'result', runId: req.runId, result: { kind: 'review', findings: [] } }
                ])
            })
        )
        await run?.settled
        expect(run?.getState().outcome?.findings).toHaveLength(2)
    })
})

describe('comment run protocol enforcement', () => {
    it('discards events carrying a foreign run id', async () => {
        const req = request()
        const controller = new CommentRunController(openGate())
        const run = controller.start(
            makeInput({
                request: req,
                execute: eventsExecutor([
                    { type: 'finding', runId: 'someone-else', finding: finding() },
                    { type: 'result', runId: req.runId, result: { kind: 'review', findings: [] } }
                ])
            })
        )
        await run?.settled
        expect(run?.getState().outcome?.findings).toEqual([])
    })

    it('discards everything after the terminal event', async () => {
        const req = request()
        const controller = new CommentRunController(openGate())
        const run = controller.start(
            makeInput({
                request: req,
                execute: eventsExecutor([
                    { type: 'result', runId: req.runId, result: { kind: 'review', findings: [] } },
                    {
                        type: 'error',
                        runId: req.runId,
                        error: { code: 'unknown', message: 'too late' }
                    }
                ])
            })
        )
        expect(await run?.settled).toEqual('done')
        expect(run?.getState().error).toBeNull()
    })

    it('treats a stream that ends without a terminal event as invalid output', async () => {
        const req = request()
        const controller = new CommentRunController(openGate())
        const run = controller.start(
            makeInput({
                request: req,
                execute: eventsExecutor([
                    { type: 'progress', runId: req.runId, message: 'thinking' }
                ])
            })
        )
        expect(await run?.settled).toEqual('error')
        expect(run?.getState().error?.code).toEqual('invalid-output')
        expect(run?.getState().lastProgress).toEqual('thinking')
    })

    it('rejects a result of the wrong kind', async () => {
        const req = request()
        const controller = new CommentRunController(openGate())
        const run = controller.start(
            makeInput({
                request: req,
                execute: eventsExecutor([
                    {
                        type: 'result',
                        runId: req.runId,
                        result: {
                            kind: 'transform-selection',
                            replacement: 'nope',
                            evidence: []
                        }
                    }
                ])
            })
        )
        expect(await run?.settled).toEqual('error')
        expect(run?.getState().error?.message).toContain('review')
    })

    it('redacts secrets out of a failure before it becomes durable state', async () => {
        const req = request()
        const controller = new CommentRunController(openGate())
        const run = controller.start(
            makeInput({
                request: req,
                redactError: (message) => message.replace('sk-secret', '***'),
                execute: eventsExecutor([
                    {
                        type: 'error',
                        runId: req.runId,
                        error: { code: 'auth', message: 'bad key sk-secret' }
                    }
                ])
            })
        )
        expect(await run?.settled).toEqual('error')
        expect(run?.getState().error?.message).toEqual('bad key ***')
    })

    it('reports a backend that throws as an error, redacted', async () => {
        const controller = new CommentRunController(openGate())
        const run = controller.start(
            makeInput({
                redactError: (message) => message.replace('sk-secret', '***'),
                execute: throwingExecutor('transport died with sk-secret')
            })
        )
        expect(await run?.settled).toEqual('error')
        expect(run?.getState().error?.message).toEqual('transport died with ***')
    })
})

describe('comment run cancellation', () => {
    it('cancels a job and discards its late events', async () => {
        const req = request()
        let released = false
        const controller = new CommentRunController(openGate())
        const run = controller.start(
            makeInput({
                request: req,
                execute: async function* (): AsyncGenerator<OperationEvent> {
                    await Promise.resolve()
                    yield { type: 'progress', runId: req.runId, message: 'working' }
                    released = true
                    yield {
                        type: 'result',
                        runId: req.runId,
                        result: { kind: 'review', findings: [finding()] }
                    }
                }
            })
        )
        run?.cancel()
        expect(await run?.settled).toEqual('cancelled')
        expect(run?.getState().outcome).toBeNull()
        expect(released).toBe(false)
    })

    it('refuses a second job for the same comment while one is in flight', () => {
        const controller = new CommentRunController(openGate())
        const first = controller.start(makeInput({ execute: hangingExecutor() }))
        expect(first).not.toBeNull()
        expect(controller.start(makeInput())).toBeNull()
        first?.cancel()
    })

    it('forgets a run once it settles so a retry can start a new one', async () => {
        const controller = new CommentRunController(openGate())
        const run = controller.start(makeInput())
        await run?.settled
        await Promise.resolve()
        expect(controller.get('comment-1')).toBeNull()
        expect(controller.start(makeInput())).not.toBeNull()
    })

    it('cancels every job of one note and names them', () => {
        const controller = new CommentRunController(openGate())
        const hang = hangingExecutor()
        controller.start(makeInput({ commentId: 'a', execute: hang }))
        controller.start(makeInput({ commentId: 'b', execute: hang }))
        controller.start(makeInput({ commentId: 'c', notePath: 'Other.md', execute: hang }))
        expect([...controller.cancelForNote('Notes/Test.md')].sort()).toEqual(['a', 'b'])
        expect(controller.get('c')).not.toBeNull()
    })

    it('names everything it cancelled on unload, so the store can mark them interrupted', async () => {
        const controller = new CommentRunController(openGate())
        const hang = hangingExecutor()
        const a = controller.start(makeInput({ commentId: 'a', execute: hang }))
        const b = controller.start(makeInput({ commentId: 'b', execute: hang }))
        expect([...controller.cancelAll()].sort()).toEqual(['a', 'b'])
        expect(await a?.settled).toEqual('cancelled')
        expect(await b?.settled).toEqual('cancelled')
        expect(controller.list()).toEqual([])
    })
})

describe('comment run admission', () => {
    it('stays pending while the pool is busy and never queues ahead of a review', async () => {
        const semaphore = new Semaphore(() => 2)
        const gate = new BackgroundRequestGate({
            gate: semaphore,
            getLimit: () => 2,
            setTimer: (callback, ms) => Number(setTimeout(callback, ms)),
            clearTimer: (handle) => {
                clearTimeout(handle)
            },
            pollIntervalMs: 1
        })
        const foreground = await semaphore.acquire()
        const controller = new CommentRunController(gate)
        const run = controller.start(makeInput())
        await new Promise((resolve) => setTimeout(resolve, 5))
        expect(run?.getState().status).toEqual('pending')
        expect(run?.getState().startedAt).toBeNull()
        expect(semaphore.queuedCount()).toEqual(0) // waiting OUTSIDE the queue
        foreground()
        expect(await run?.settled).toEqual('done')
    })

    it('cancelling a job that never got a permit spends nothing', async () => {
        const semaphore = new Semaphore(() => 1)
        const gate = new BackgroundRequestGate({
            gate: semaphore,
            getLimit: () => 1,
            setTimer: (callback, ms) => Number(setTimeout(callback, ms)),
            clearTimer: (handle) => {
                clearTimeout(handle)
            },
            pollIntervalMs: 1
        })
        const foreground = await semaphore.acquire()
        let started = false
        const controller = new CommentRunController(gate)
        const run = controller.start(
            makeInput({
                execute: (): AsyncIterable<OperationEvent> => {
                    started = true
                    return hangingExecutor()()
                }
            })
        )
        run?.cancel()
        expect(await run?.settled).toEqual('cancelled')
        expect(started).toBe(false)
        expect(semaphore.activeCount()).toEqual(1) // only the foreground permit
        foreground()
    })
})
