import { describe, expect, it } from 'bun:test'
import { marginCommentSchema } from '../../domain/comments/margin-comment'
import type { MarginComment } from '../../domain/comments/margin-comment'
import { CONTRACT_VERSION } from '../../domain/operations/contract'
import type { OperationEvent, ReviewRequest } from '../../domain/operations/contract'
import { BackgroundRequestGate } from '../orchestration/background-gate'
import { CommentRunController } from '../orchestration/comment-run'
import { Semaphore } from '../orchestration/semaphore'
import { CommentJobRegistry } from './comment-job-registry'
import { MarginCommentRepository } from './comment-repository'
import type { CommentStorageAdapter } from './comment-repository'

const NOTE = 'Notes/Test.md'
const STORE_PATH = 'plugins/editor-ai-daemons/comments.json'

class MemoryStorage implements CommentStorageAdapter {
    readonly files = new Map<string, string>()

    read(path: string): Promise<string | null> {
        return Promise.resolve(this.files.get(path) ?? null)
    }
    write(path: string, data: string): Promise<void> {
        this.files.set(path, data)
        return Promise.resolve()
    }
    exists(path: string): Promise<boolean> {
        return Promise.resolve(this.files.has(path))
    }
    rename(from: string, to: string): Promise<void> {
        const data = this.files.get(from)
        if (data === undefined) {
            return Promise.reject(new Error('ENOENT'))
        }
        this.files.set(to, data)
        this.files.delete(from)
        return Promise.resolve()
    }
    remove(path: string): Promise<void> {
        this.files.delete(path)
        return Promise.resolve()
    }
}

function makeRepository(): MarginCommentRepository {
    return new MarginCommentRepository({
        storage: new MemoryStorage(),
        storePath: STORE_PATH,
        setTimer: () => 0,
        clearTimer: () => undefined,
        saveDelayMs: 10_000
    })
}

function comment(overrides: Partial<MarginComment> = {}): MarginComment {
    return marginCommentSchema.parse({
        id: 'c1',
        quote: 'the claim',
        instruction: 'Is this supported?',
        editorId: 'editor-1',
        editorName: 'Fact Checker',
        status: 'submitted',
        createdAt: 1_000,
        updatedAt: 1_000,
        ...overrides
    })
}

function request(runId = 'run-1'): ReviewRequest {
    return {
        kind: 'review',
        contractVersion: CONTRACT_VERSION,
        runId,
        snapshotHash: 'hash',
        text: 'the claim is here'
    }
}

function resultExecutor(runId: string, summary?: string) {
    return async function* (): AsyncGenerator<OperationEvent> {
        await Promise.resolve()
        yield {
            type: 'result',
            runId,
            result: { kind: 'review', findings: [], ...(summary ? { summary } : {}) }
        }
    }
}

function errorExecutor(runId: string, message: string) {
    return async function* (): AsyncGenerator<OperationEvent> {
        await Promise.resolve()
        yield { type: 'error', runId, error: { code: 'unknown', message } }
    }
}

/** Lets the gate, the executor and the settle handlers all run. */
function settle(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, 5))
}

function hangingExecutor(): () => AsyncIterable<OperationEvent> {
    return () => ({
        [Symbol.asyncIterator]: () => ({
            next: () => new Promise<IteratorResult<OperationEvent>>(() => undefined)
        })
    })
}

interface Harness {
    registry: CommentJobRegistry
    repository: MarginCommentRepository
    runs: CommentRunController
    tickers: { count: number; cleared: number }
    notifications: () => number
}

function setup(clock = { value: 5_000 }): Harness {
    const repository = makeRepository()
    const gate = new BackgroundRequestGate({
        gate: new Semaphore(() => Number.POSITIVE_INFINITY),
        getLimit: () => Number.POSITIVE_INFINITY,
        setTimer: (callback, ms) => Number(setTimeout(callback, ms)),
        clearTimer: (handle) => {
            clearTimeout(handle)
        },
        pollIntervalMs: 1
    })
    const runs = new CommentRunController(gate)
    const tickers = { count: 0, cleared: 0 }
    let notifications = 0
    const registry = new CommentJobRegistry({
        repository,
        runs,
        now: () => clock.value,
        setTicker: () => {
            tickers.count += 1
            return tickers.count
        },
        clearTicker: () => {
            tickers.cleared += 1
        }
    })
    registry.subscribe(() => {
        notifications += 1
    })
    return { registry, repository, runs, tickers, notifications: () => notifications }
}

describe('launching a background comment job', () => {
    it('records the comment durably before the request goes out', () => {
        const { registry, repository } = setup()
        const result = registry.launch({
            notePath: NOTE,
            comment: comment(),
            run: {
                request: request(),
                editorId: 'editor-1',
                editorName: 'Fact Checker',
                execute: hangingExecutor()
            }
        })
        expect(result.ok).toBe(true)
        expect(repository.listFor(NOTE)).toHaveLength(1)
        registry.interruptAll()
    })

    it('moves the durable comment to running, then to done with the answer', async () => {
        const { registry, repository } = setup()
        const req = request()
        registry.launch({
            notePath: NOTE,
            comment: comment(),
            run: {
                request: req,
                editorId: 'editor-1',
                editorName: 'Fact Checker',
                execute: resultExecutor(req.runId, 'Supported by the linked source.')
            }
        })
        expect(registry.commentFor(NOTE, 'c1')?.status).toEqual('submitted')
        await settle()
        const stored = repository.listFor(NOTE)[0]
        expect(stored?.status).toEqual('done')
        expect(stored?.reply).toEqual('Supported by the linked source.')
    })

    it('records a backend failure as failed, with the redacted message', async () => {
        const { registry, repository } = setup()
        const req = request()
        registry.launch({
            notePath: NOTE,
            comment: comment(),
            run: {
                request: req,
                editorId: 'editor-1',
                editorName: 'Fact Checker',
                execute: errorExecutor(req.runId, 'HTTP 500')
            }
        })
        await settle()
        const stored = repository.listFor(NOTE)[0]
        expect(stored?.status).toEqual('failed')
        expect(stored?.error).toEqual('HTTP 500')
    })

    it('refuses a second job for a comment that is already running', () => {
        const { registry } = setup()
        const input = {
            notePath: NOTE,
            comment: comment(),
            run: {
                request: request(),
                editorId: 'editor-1',
                editorName: 'Fact Checker',
                execute: hangingExecutor()
            }
        }
        expect(registry.launch(input).ok).toBe(true)
        const second = registry.launch(input)
        expect(second).toEqual({ ok: false, reason: 'already-running' })
        registry.interruptAll()
    })

    it('refuses when the note is at the per-note cap', () => {
        const { registry, repository } = setup()
        for (let i = 0; i < 500; i++) {
            repository.upsert(NOTE, comment({ id: `filler-${i}`, status: 'done' }))
        }
        const result = registry.launch({
            notePath: NOTE,
            comment: comment({ id: 'overflow' }),
            run: {
                request: request(),
                editorId: 'editor-1',
                editorName: 'Fact Checker',
                execute: hangingExecutor()
            }
        })
        expect(result).toEqual({ ok: false, reason: 'note-full' })
    })
})

describe('the live timer', () => {
    it('runs a ticker only while something is in flight', async () => {
        const { registry, tickers } = setup()
        const req = request()
        registry.launch({
            notePath: NOTE,
            comment: comment(),
            run: {
                request: req,
                editorId: 'editor-1',
                editorName: 'Fact Checker',
                execute: resultExecutor(req.runId)
            }
        })
        expect(tickers.count).toEqual(1)
        await settle()
        expect(registry.hasActiveJobs()).toBe(false)
        expect(tickers.cleared).toBeGreaterThanOrEqual(1)
    })

    it('joins the live start time onto the row so the timer counts work, not queue time', async () => {
        const clock = { value: 10_000 }
        const { registry } = setup(clock)
        registry.launch({
            notePath: NOTE,
            comment: comment(),
            run: {
                request: request(),
                editorId: 'editor-1',
                editorName: 'Fact Checker',
                execute: hangingExecutor(),
                now: () => clock.value
            }
        })
        await settle()
        clock.value = 10_000 + 27_000
        const view = registry.viewsFor(NOTE)[0]
        expect(view?.statusLabel).toEqual('Reviewing')
        expect(view?.timer).toEqual('0:27')
        registry.interruptAll()
    })

    it('stops the ticker on dispose', () => {
        const { registry, tickers } = setup()
        registry.launch({
            notePath: NOTE,
            comment: comment(),
            run: {
                request: request(),
                editorId: 'editor-1',
                editorName: 'Fact Checker',
                execute: hangingExecutor()
            }
        })
        expect(tickers.count).toEqual(1)
        registry.dispose()
        expect(tickers.cleared).toEqual(1)
    })
})

describe('cancellation and unload', () => {
    it('marks a cancelled job interrupted rather than failed', async () => {
        const { registry, repository } = setup()
        registry.launch({
            notePath: NOTE,
            comment: comment(),
            run: {
                request: request(),
                editorId: 'editor-1',
                editorName: 'Fact Checker',
                execute: hangingExecutor()
            }
        })
        await settle()
        expect(registry.cancel('c1')).toBe(true)
        await settle()
        const stored = repository.listFor(NOTE)[0]
        expect(stored?.status).toEqual('interrupted')
        // No invented reason: the job simply did not finish.
        expect(stored?.error).toBeUndefined()
    })

    it('records every in-flight job as interrupted on unload', async () => {
        const { registry, repository } = setup()
        for (const id of ['a', 'b']) {
            registry.launch({
                notePath: NOTE,
                comment: comment({ id }),
                run: {
                    request: request(id),
                    editorId: 'editor-1',
                    editorName: 'Fact Checker',
                    execute: hangingExecutor()
                }
            })
        }
        await settle()
        expect([...registry.interruptAll()].sort()).toEqual(['a', 'b'])
        await settle()
        expect(repository.listFor(NOTE).map((entry) => entry.status)).toEqual([
            'interrupted',
            'interrupted'
        ])
    })

    it('dismissing cancels the job and closes the comment', async () => {
        const { registry, repository } = setup()
        registry.launch({
            notePath: NOTE,
            comment: comment(),
            run: {
                request: request(),
                editorId: 'editor-1',
                editorName: 'Fact Checker',
                execute: hangingExecutor()
            }
        })
        await settle()
        expect(registry.dismiss(NOTE, 'c1')).toBe(true)
        await settle()
        // The cancellation resolution must not reopen a dismissed comment.
        expect(repository.listFor(NOTE)[0]?.status).toEqual('dismissed')
    })

    it('deleting cancels the job and removes the comment for good', async () => {
        const { registry, repository, runs } = setup()
        registry.launch({
            notePath: NOTE,
            comment: comment(),
            run: {
                request: request(),
                editorId: 'editor-1',
                editorName: 'Fact Checker',
                execute: hangingExecutor()
            }
        })
        await settle()
        expect(registry.delete(NOTE, 'c1')).toBe(true)
        await settle()
        expect(repository.listFor(NOTE)).toEqual([])
        // Cancelled, and the terminal transition cannot resurrect the entry.
        expect(runs.get('c1')?.isSettled() ?? true).toBe(true)
        expect(repository.listFor(NOTE)).toEqual([])
    })

    it('follows a renamed note when deleting', () => {
        const { registry, repository } = setup()
        repository.upsert(NOTE, comment({ status: 'done' }))
        repository.noteRenamed(NOTE, 'Notes/Renamed.md')
        expect(registry.delete(NOTE, 'c1')).toBe(true)
        expect(repository.listFor('Notes/Renamed.md')).toEqual([])
    })

    it('reports nothing deleted for an unknown comment', () => {
        const { registry } = setup()
        expect(registry.delete(NOTE, 'nope')).toBe(false)
    })
})

describe('retry preparation', () => {
    it('flips an interrupted comment back to submitted, clearing the last round', () => {
        const { registry, repository } = setup()
        repository.upsert(NOTE, comment({ status: 'interrupted', error: 'gone' }))
        const next = registry.prepareRetry(NOTE, 'c1')
        expect(next?.status).toEqual('submitted')
        expect(next?.error).toBeUndefined()
        expect(repository.listFor(NOTE)[0]?.status).toEqual('submitted')
    })

    it('refuses to retry a comment that already has an answer', () => {
        const { registry, repository } = setup()
        repository.upsert(NOTE, comment({ status: 'done' }))
        expect(registry.prepareRetry(NOTE, 'c1')).toBeNull()
        expect(repository.listFor(NOTE)[0]?.status).toEqual('done')
    })

    it('refuses to retry a comment that is not there', () => {
        const { registry } = setup()
        expect(registry.prepareRetry(NOTE, 'nope')).toBeNull()
    })
})

describe('following the vault', () => {
    it('writes the answer to the comment even after the note was renamed mid-flight', async () => {
        const { registry, repository } = setup()
        const req = request()
        registry.launch({
            notePath: NOTE,
            comment: comment(),
            run: {
                request: req,
                editorId: 'editor-1',
                editorName: 'Fact Checker',
                execute: resultExecutor(req.runId, 'Still fine.')
            }
        })
        repository.noteRenamed(NOTE, 'Notes/Renamed.md')
        await settle()
        expect(repository.listFor(NOTE)).toHaveLength(0)
        expect(repository.listFor('Notes/Renamed.md')[0]?.status).toEqual('done')
    })

    it('cancels the in-flight runs of a deleted note instead of paying for them', async () => {
        const { registry, repository, runs } = setup()
        registry.launch({
            notePath: NOTE,
            comment: comment(),
            run: {
                request: request(),
                editorId: 'editor-1',
                editorName: 'Fact Checker',
                execute: hangingExecutor()
            }
        })
        await settle()
        expect(runs.get('c1')).not.toBeNull()
        registry.noteDeleted(NOTE)
        // The request is not left running: it would hold a permit from the
        // plugin-wide budget and deliver its answer to nothing.
        expect(runs.get('c1')).toBeNull()
        expect(repository.listFor(NOTE)).toHaveLength(0)
    })

    it('cancels every run under a deleted FOLDER', async () => {
        const { registry, runs } = setup()
        registry.launch({
            notePath: 'Drafts/Deep/One.md',
            comment: comment(),
            run: {
                request: request(),
                editorId: 'editor-1',
                editorName: 'Fact Checker',
                execute: hangingExecutor()
            }
        })
        await settle()
        registry.noteDeleted('Drafts')
        expect(runs.get('c1')).toBeNull()
    })

    it('reports how many comments a rename merge had to drop', () => {
        const { registry, repository } = setup()
        repository.upsert('A.md', comment({ id: 'moved' }))
        expect(registry.noteRenamed('A.md', 'B.md')).toEqual(0)
        expect(repository.listFor('B.md')).toHaveLength(1)
    })

    it('does not resurrect a comment whose note was deleted mid-flight', async () => {
        const { registry, repository } = setup()
        const req = request()
        registry.launch({
            notePath: NOTE,
            comment: comment(),
            run: {
                request: req,
                editorId: 'editor-1',
                editorName: 'Fact Checker',
                execute: resultExecutor(req.runId, 'Too late.')
            }
        })
        repository.noteDeleted(NOTE)
        await settle()
        expect(repository.listFor(NOTE)).toHaveLength(0)
        expect(repository.notePaths()).toEqual([])
    })
})
