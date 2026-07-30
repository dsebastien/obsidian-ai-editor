import { describe, expect, it } from 'bun:test'
import { createSnapshot } from '../../domain/snapshot'
import type {
    OperationEvent,
    RawFinding,
    ThreadTurnRequest
} from '../../domain/operations/contract'
import { THREAD_MAX_TURNS } from '../../domain/operations/thread'
import { RunController, type RunEditorSpec, type RunHandle } from './run-controller'

/**
 * Thread turns on the run handle: the backend round trip of a per-finding
 * push-back (plan M4). Store transitions themselves are pinned in
 * `finding-store.spec.ts`; here the concern is the operation — request shape,
 * event protocol, resolution vocabulary, permits, and cancellation.
 */

const DOC = 'The quick brown fox jumps over the lazy dog'

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

/** A settled run with exactly one anchored finding on "quick brown". */
async function runWithFinding(findings: RawFinding[] = [raw()]): Promise<RunHandle> {
    const controller = new RunController()
    const editor: RunEditorSpec = {
        editorId: 'alpha',
        editorName: 'Alpha',
        execute: async function* (request) {
            yield { type: 'result', runId: request.runId, result: { kind: 'review', findings } }
        }
    }
    const run = controller.startRun({
        snapshot: createSnapshot({ filePath: 'notes/test.md', text: DOC }),
        editors: [editor]
    })
    await run.settled
    return run
}

function turnResult(
    runId: string,
    payload: { reply: string; concede?: boolean; revisedSuggestion?: string }
): OperationEvent {
    return {
        type: 'result',
        runId,
        result: {
            kind: 'thread-turn',
            reply: payload.reply,
            concede: payload.concede ?? false,
            ...(payload.revisedSuggestion === undefined
                ? {}
                : { revisedSuggestion: payload.revisedSuggestion })
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

describe('RunHandle.startThreadTurn request shape', () => {
    it('sends the live span text, the current critique and the prior turns', async () => {
        const run = await runWithFinding()
        const id = run.findings.list()[0]!.id
        const seen: ThreadTurnRequest[] = []
        const execute = async function* (
            request: ThreadTurnRequest
        ): AsyncIterable<OperationEvent> {
            seen.push(request)
            yield turnResult(request.runId, {
                reply: 'Holding',
                revisedSuggestion: 'sharper wording'
            })
        }

        const first = run.startThreadTurn({
            findingId: id,
            message: '  I disagree  ',
            quote: 'quick brown',
            execute
        })
        expect(first.ok).toBeTrue()
        if (first.ok) {
            await first.settled
        }

        const second = run.startThreadTurn({
            findingId: id,
            message: 'still not convinced',
            quote: 'QUICK BROWN',
            execute
        })
        if (second.ok) {
            await second.settled
        }

        expect(seen).toHaveLength(2)
        // First turn: no history, the original critique, the trimmed message.
        expect(seen[0]?.kind).toEqual('thread-turn')
        expect(seen[0]?.findingId).toEqual(id)
        expect(seen[0]?.quote).toEqual('quick brown')
        expect(seen[0]?.critique).toEqual('Too generic')
        expect(seen[0]?.history).toEqual([])
        expect(seen[0]?.message).toEqual('I disagree')
        // Second turn: the completed exchange rides as history, the live span
        // text is whatever the caller resolved, and the message is NOT in the
        // history (it travels as `message`).
        expect(seen[1]?.quote).toEqual('QUICK BROWN')
        expect(seen[1]?.history).toEqual([
            { role: 'user', content: 'I disagree' },
            { role: 'editor', content: 'Holding' }
        ])
        expect(seen[1]?.message).toEqual('still not convinced')
        // Each turn has its own operation identity.
        expect(seen[0]?.runId).not.toEqual(seen[1]?.runId)
        expect(seen[0]?.snapshotHash).toEqual(run.snapshot.hash)
    })

    it('argues from the revised critique once a turn sharpened it', async () => {
        const run = await runWithFinding()
        const id = run.findings.list()[0]!.id
        const seen: ThreadTurnRequest[] = []
        const execute = async function* (
            request: ThreadTurnRequest
        ): AsyncIterable<OperationEvent> {
            seen.push(request)
            yield {
                type: 'result',
                runId: request.runId,
                result: {
                    kind: 'thread-turn',
                    reply: 'Sharpened',
                    concede: false,
                    revisedCritique: 'The repetition buries the verb'
                }
            }
        }
        const first = run.startThreadTurn({ findingId: id, message: 'why?', quote: 'q', execute })
        if (first.ok) {
            await first.settled
        }
        const second = run.startThreadTurn({ findingId: id, message: 'and?', quote: 'q', execute })
        if (second.ok) {
            await second.settled
        }
        expect(seen[1]?.critique).toEqual('The repetition buries the verb')
    })
})

describe('RunHandle.startThreadTurn outcomes', () => {
    it('resolves held with the revision flag and updates the finding', async () => {
        const run = await runWithFinding()
        const id = run.findings.list()[0]!.id
        const start = run.startThreadTurn({
            findingId: id,
            message: 'give me better',
            quote: 'quick brown',
            execute: async function* (request) {
                yield turnResult(request.runId, {
                    reply: 'Try this',
                    revisedSuggestion: 'swift auburn fox'
                })
            }
        })
        expect(start.ok).toBeTrue()
        if (!start.ok) {
            return
        }
        expect(await start.settled).toEqual({ status: 'held', reply: 'Try this', revised: true })
        const finding = run.findings.get(id)
        expect(finding?.raw.suggestion).toEqual('swift auburn fox')
        expect(finding?.threadTurn).toBeNull()
        expect(finding?.thread).toHaveLength(2)
    })

    it('reports a plain reply as held without a revision', async () => {
        const run = await runWithFinding()
        const id = run.findings.list()[0]!.id
        const start = run.startThreadTurn({
            findingId: id,
            message: 'why?',
            quote: 'quick brown',
            execute: async function* (request) {
                yield turnResult(request.runId, { reply: 'Because it reads flat' })
            }
        })
        if (!start.ok) {
            throw new Error('expected the turn to start')
        }
        expect(await start.settled).toEqual({
            status: 'held',
            reply: 'Because it reads flat',
            revised: false
        })
        expect(run.findings.get(id)?.raw.suggestion).toEqual('swift auburn')
    })

    it('resolves conceded and dismisses the finding', async () => {
        const run = await runWithFinding()
        const id = run.findings.list()[0]!.id
        const start = run.startThreadTurn({
            findingId: id,
            message: 'it is intentional',
            quote: 'quick brown',
            execute: async function* (request) {
                yield turnResult(request.runId, { reply: 'Fair, withdrawing', concede: true })
            }
        })
        if (!start.ok) {
            throw new Error('expected the turn to start')
        }
        expect(await start.settled).toEqual({ status: 'conceded', reply: 'Fair, withdrawing' })
        expect(run.findings.get(id)?.status).toEqual('dismissed')
        expect(run.findings.get(id)?.conceded).toBeTrue()
    })

    it('refuses the turn when the store does, without calling the backend', async () => {
        const run = await runWithFinding()
        const id = run.findings.list()[0]!.id
        let calls = 0
        const execute = async function* (
            request: ThreadTurnRequest
        ): AsyncIterable<OperationEvent> {
            calls += 1
            yield turnResult(request.runId, { reply: 'never sent' })
        }
        expect(run.startThreadTurn({ findingId: id, message: '   ', quote: 'q', execute })).toEqual(
            {
                ok: false,
                reason: 'blank-message'
            }
        )
        run.findings.dismiss(id)
        expect(run.startThreadTurn({ findingId: id, message: 'hi', quote: 'q', execute })).toEqual({
            ok: false,
            reason: 'invalid-status'
        })
        expect(calls).toEqual(0)
    })

    it('refuses a second turn while one is in flight', async () => {
        const run = await runWithFinding()
        const id = run.findings.list()[0]!.id
        const gate = deferred()
        const start = run.startThreadTurn({
            findingId: id,
            message: 'first',
            quote: 'q',
            execute: async function* (request) {
                await gate.promise
                yield turnResult(request.runId, { reply: 'done' })
            }
        })
        expect(
            run.startThreadTurn({
                findingId: id,
                message: 'second',
                quote: 'q',
                execute: async function* () {
                    // never reached
                }
            })
        ).toEqual({ ok: false, reason: 'in-flight' })
        gate.resolve()
        if (start.ok) {
            await start.settled
        }
    })

    it('stops at the turn cap', async () => {
        const run = await runWithFinding()
        const id = run.findings.list()[0]!.id
        const execute = async function* (
            request: ThreadTurnRequest
        ): AsyncIterable<OperationEvent> {
            yield turnResult(request.runId, { reply: 'again' })
        }
        for (let turn = 0; turn < THREAD_MAX_TURNS; turn++) {
            const start = run.startThreadTurn({
                findingId: id,
                message: `push ${turn}`,
                quote: 'q',
                execute
            })
            if (!start.ok) {
                throw new Error(`turn ${turn} was refused`)
            }
            await start.settled
        }
        expect(
            run.startThreadTurn({ findingId: id, message: 'one more', quote: 'q', execute })
        ).toEqual({ ok: false, reason: 'cap-reached' })
    })
})

describe('RunHandle.startThreadTurn protocol enforcement', () => {
    it('fails on a wrong result kind and redacts the message', async () => {
        const run = await runWithFinding()
        const id = run.findings.list()[0]!.id
        const start = run.startThreadTurn({
            findingId: id,
            message: 'push',
            quote: 'q',
            execute: async function* (request) {
                yield {
                    type: 'result',
                    runId: request.runId,
                    result: { kind: 'review', findings: [] }
                }
            }
        })
        if (!start.ok) {
            throw new Error('expected the turn to start')
        }
        expect(await start.settled).toEqual({
            status: 'failed',
            reason: "Expected a 'thread-turn' result, got 'review'"
        })
        expect(run.findings.get(id)?.threadTurn).toEqual({
            status: 'failed',
            message: 'push',
            reason: "Expected a 'thread-turn' result, got 'review'"
        })
        // The finding itself is untouched and can be pushed back on again.
        expect(run.findings.get(id)?.status).toEqual('open')
        expect(run.findings.get(id)?.thread).toEqual([])
    })

    it('fails when the stream ends without a terminal event', async () => {
        const run = await runWithFinding()
        const id = run.findings.list()[0]!.id
        const start = run.startThreadTurn({
            findingId: id,
            message: 'push',
            quote: 'q',
            execute: async function* (request) {
                yield { type: 'progress', runId: request.runId, message: 'thinking' }
            }
        })
        if (!start.ok) {
            throw new Error('expected the turn to start')
        }
        expect(await start.settled).toEqual({
            status: 'failed',
            reason: 'Stream ended without a terminal event'
        })
    })

    it('routes backend errors through the redaction seam', async () => {
        const run = await runWithFinding()
        const id = run.findings.list()[0]!.id
        const start = run.startThreadTurn({
            findingId: id,
            message: 'push',
            quote: 'q',
            redactError: (message) => message.replace('sk-secret', '***'),
            execute: async function* (request) {
                yield {
                    type: 'error',
                    runId: request.runId,
                    error: { code: 'auth', message: 'rejected key sk-secret' }
                }
            }
        })
        if (!start.ok) {
            throw new Error('expected the turn to start')
        }
        expect(await start.settled).toEqual({
            status: 'failed',
            reason: 'rejected key ***'
        })
        expect(run.findings.get(id)?.threadTurn?.status).toEqual('failed')
    })

    it('discards foreign-run and post-terminal events', async () => {
        const run = await runWithFinding()
        const id = run.findings.list()[0]!.id
        const start = run.startThreadTurn({
            findingId: id,
            message: 'push',
            quote: 'q',
            execute: async function* (request) {
                yield turnResult('some-other-run', { reply: 'foreign', concede: true })
                yield turnResult(request.runId, { reply: 'mine' })
                yield turnResult(request.runId, { reply: 'late', concede: true })
            }
        })
        if (!start.ok) {
            throw new Error('expected the turn to start')
        }
        expect(await start.settled).toEqual({ status: 'held', reply: 'mine', revised: false })
        expect(run.findings.get(id)?.status).toEqual('open')
        expect(run.findings.get(id)?.thread).toEqual([
            { role: 'user', content: 'push' },
            { role: 'editor', content: 'mine' }
        ])
    })

    it('reports a thrown stream as a failure', async () => {
        const run = await runWithFinding()
        const id = run.findings.list()[0]!.id
        const start = run.startThreadTurn({
            findingId: id,
            message: 'push',
            quote: 'q',
            // eslint-disable-next-line require-yield
            execute: async function* () {
                throw new Error('socket closed')
            }
        })
        if (!start.ok) {
            throw new Error('expected the turn to start')
        }
        expect(await start.settled).toEqual({ status: 'failed', reason: 'socket closed' })
    })

    it('discards the outcome when the finding left the store mid-turn', async () => {
        const run = await runWithFinding()
        const id = run.findings.list()[0]!.id
        const gate = deferred()
        const start = run.startThreadTurn({
            findingId: id,
            message: 'push',
            quote: 'q',
            execute: async function* (request) {
                await gate.promise
                yield turnResult(request.runId, { reply: 'too late' })
            }
        })
        run.findings.removeMany([id])
        gate.resolve()
        if (!start.ok) {
            throw new Error('expected the turn to start')
        }
        expect(await start.settled).toEqual({ status: 'discarded' })
    })
})

describe('thread turns, cancellation and concurrency', () => {
    it('is cancelled by cancelRun and marks the turn failed', async () => {
        const run = await runWithFinding()
        const id = run.findings.list()[0]!.id
        const running = deferred()
        let aborted = false
        const start = run.startThreadTurn({
            findingId: id,
            message: 'push',
            quote: 'q',
            execute: async function* (request, signal) {
                running.resolve()
                await new Promise<void>((resolve) => {
                    if (signal.aborted) {
                        aborted = true
                        resolve()
                        return
                    }
                    signal.addEventListener('abort', () => {
                        aborted = true
                        resolve()
                    })
                })
                yield turnResult(request.runId, { reply: 'never' })
            }
        })
        await running.promise
        run.cancelRun()
        if (!start.ok) {
            throw new Error('expected the turn to start')
        }
        expect(await start.settled).toEqual({ status: 'cancelled' })
        expect(aborted).toBeTrue()
        expect(run.findings.get(id)?.threadTurn).toEqual({
            status: 'failed',
            message: 'push',
            reason: 'Cancelled'
        })
    })

    it('still allows a push-back on a cancelled run findings', async () => {
        const run = await runWithFinding()
        const id = run.findings.list()[0]!.id
        run.cancelRun() // findings stay inspectable after a cancel
        const start = run.startThreadTurn({
            findingId: id,
            message: 'push',
            quote: 'q',
            execute: async function* (request) {
                yield turnResult(request.runId, { reply: 'still here' })
            }
        })
        if (!start.ok) {
            throw new Error('expected the turn to start')
        }
        expect(await start.settled).toEqual({
            status: 'held',
            reply: 'still here',
            revised: false
        })
    })

    it('does not make the run report itself as in progress', async () => {
        const run = await runWithFinding()
        const id = run.findings.list()[0]!.id
        const gate = deferred()
        const start = run.startThreadTurn({
            findingId: id,
            message: 'push',
            quote: 'q',
            execute: async function* (request) {
                await gate.promise
                yield turnResult(request.runId, { reply: 'done' })
            }
        })
        expect(run.isSettled()).toBeTrue()
        gate.resolve()
        if (start.ok) {
            await start.settled
        }
        expect(run.isSettled()).toBeTrue()
    })

    it('takes a permit from the plugin-wide concurrency gate', async () => {
        const controller = new RunController(() => 1)
        const reviewGate = deferred()
        const run = controller.startRun({
            snapshot: createSnapshot({ filePath: 'notes/test.md', text: DOC }),
            editors: [
                {
                    editorId: 'alpha',
                    editorName: 'Alpha',
                    execute: async function* (request) {
                        await reviewGate.promise
                        yield {
                            type: 'result',
                            runId: request.runId,
                            result: { kind: 'review', findings: [raw()] }
                        }
                    }
                }
            ]
        })
        // The single permit is held by the review; a turn on a finding cannot
        // even be started yet (no finding), so wait for the review first.
        reviewGate.resolve()
        await run.settled
        const id = run.findings.list()[0]!.id

        // Now hold the only permit with a turn and prove a second run queues.
        const turnGate = deferred()
        const turn = run.startThreadTurn({
            findingId: id,
            message: 'push',
            quote: 'q',
            execute: async function* (request) {
                await turnGate.promise
                yield turnResult(request.runId, { reply: 'done' })
            }
        })
        await Promise.resolve()
        let secondStarted = false
        const second = controller.startRun({
            snapshot: createSnapshot({ filePath: 'notes/other.md', text: DOC }),
            editors: [
                {
                    editorId: 'beta',
                    editorName: 'Beta',
                    execute: async function* (request) {
                        secondStarted = true
                        yield {
                            type: 'result',
                            runId: request.runId,
                            result: { kind: 'review', findings: [] }
                        }
                    }
                }
            ]
        })
        await Promise.resolve()
        await Promise.resolve()
        expect(secondStarted).toBeFalse() // the turn holds the permit
        turnGate.resolve()
        if (turn.ok) {
            await turn.settled
        }
        await second.settled
        expect(secondStarted).toBeTrue()
    })
})
