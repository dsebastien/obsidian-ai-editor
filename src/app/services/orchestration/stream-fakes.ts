/**
 * Streams that never yield, for specs of how a run handles them. Built as
 * plain async iterables: a generator that never yields is what `require-yield`
 * reports, and here not yielding is the behaviour under test.
 */

function iterable<T>(next: () => Promise<IteratorResult<T>>): AsyncIterable<T> {
    return {
        [Symbol.asyncIterator]: (): AsyncIterator<T> => ({ next })
    }
}

/** Fails on the first read, before any event: a stream that dies at once. */
export function failingStream<T>(error: Error): AsyncIterable<T> {
    return iterable<T>(() => Promise.reject(error))
}

/** Ends without a single event (and so without a terminal one). */
export function endedStream<T>(): AsyncIterable<T> {
    return iterable<T>(() => Promise.resolve({ done: true, value: undefined }))
}

/** Never produces anything and never ends. */
export function hangingStream<T>(): AsyncIterable<T> {
    return iterable<T>(() => new Promise<IteratorResult<T>>(() => undefined))
}

/**
 * Produces nothing and ends only once `signal` aborts. `onFirstRead` runs when
 * the consumer first asks for an event, so a spec can tell a stream that was
 * read from one that was only created.
 */
export function streamEndingOnAbort<T>(
    signal: AbortSignal,
    onFirstRead: () => void = (): void => undefined
): AsyncIterable<T> {
    let read = false
    return iterable<T>(() => {
        if (!read) {
            read = true
            onFirstRead()
        }
        return new Promise<IteratorResult<T>>((resolve) => {
            signal.addEventListener('abort', () => resolve({ done: true, value: undefined }))
        })
    })
}
