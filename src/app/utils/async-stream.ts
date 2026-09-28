/**
 * The given items as an async stream, in order.
 *
 * For producers whose events are all known up front (a refusal, a test fake).
 * An async generator's `yield` already awaits the value it yields; spelling
 * that await out is what keeps `require-await` meaningful for the generators
 * that genuinely wait on something.
 */
export async function* streamOf<T>(items: Iterable<T>): AsyncGenerator<T> {
    for (const item of items) {
        yield await Promise.resolve(item)
    }
}
