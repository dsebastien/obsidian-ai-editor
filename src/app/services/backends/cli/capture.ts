/**
 * Bounded capture of a child process's two output streams.
 *
 * A CLI agent is a program the plugin does not control. It can loop, it can
 * echo its input back forever, and it can do so faster than anyone notices.
 * Reading its output into an unbounded string would let a misbehaving tool
 * take the renderer down with it, so both streams are capped and the caps are
 * enforced as bytes arrive rather than checked afterwards.
 *
 * The two streams get DIFFERENT policies, because they carry different
 * things:
 *
 * - **stdout is the protocol.** A truncated JSON document is not a smaller
 *   answer, it is a corrupt one, and silently parsing a prefix would be the
 *   worst possible outcome. Exceeding the cap therefore stops the capture and
 *   fails the run with a typed error, and the caller kills the process tree.
 * - **stderr is diagnostics.** Nothing downstream depends on it being
 *   complete, and a chatty tool that logs progress there should not lose its
 *   result over it. Exceeding the cap drops the OLDEST bytes and keeps the
 *   tail — where the error that matters is — with `truncated` set so no
 *   reader mistakes a fragment for the whole.
 *
 * Both policies bound memory, which is the actual requirement.
 */

/** Generous enough for a long agent transcript, small enough to be survivable. */
export const DEFAULT_MAX_STDOUT_BYTES = 8 * 1024 * 1024

/** Diagnostics only — the tail is what anyone reads. */
export const DEFAULT_MAX_STDERR_BYTES = 64 * 1024

export type OverflowPolicy = 'stop' | 'keep-tail'

/**
 * Accumulates bytes under a cap.
 *
 * Bytes, not characters: the cap has to mean something in memory terms, and a
 * multi-byte-heavy stream would blow past a character count. The decode to
 * text happens once, at the end.
 */
export class BoundedCapture {
    private readonly chunks: Uint8Array[] = []
    private retained = 0
    private seen = 0
    private overflowed = false

    constructor(
        readonly limitBytes: number,
        readonly policy: OverflowPolicy
    ) {}

    /**
     * Appends a chunk.
     *
     * Returns false once the 'stop' cap has been exceeded — the signal for the
     * caller to terminate the process. Under 'keep-tail' it always returns
     * true; the stream is allowed to continue, older bytes are discarded.
     */
    push(chunk: Uint8Array): boolean {
        this.seen += chunk.byteLength
        if (this.policy === 'stop') {
            if (this.overflowed) {
                return false
            }
            if (this.retained + chunk.byteLength > this.limitBytes) {
                this.overflowed = true
                return false
            }
            this.chunks.push(chunk)
            this.retained += chunk.byteLength
            return true
        }

        this.chunks.push(chunk)
        this.retained += chunk.byteLength
        while (this.retained > this.limitBytes && this.chunks.length > 0) {
            const oldest = this.chunks[0]
            if (oldest === undefined) {
                break
            }
            this.overflowed = true
            const excess = this.retained - this.limitBytes
            if (oldest.byteLength <= excess) {
                this.chunks.shift()
                this.retained -= oldest.byteLength
                continue
            }
            this.chunks[0] = oldest.subarray(excess)
            this.retained -= excess
        }
        return true
    }

    /** Total bytes the stream produced, including any that were dropped. */
    get bytesSeen(): number {
        return this.seen
    }

    /** True once the cap changed what is retained. */
    get isTruncated(): boolean {
        return this.overflowed
    }

    /**
     * Decodes what was retained.
     *
     * A dropped prefix can cut a multi-byte sequence in half; the decoder
     * replaces the fragment rather than throwing, which is the right call for
     * a diagnostics tail and irrelevant for stdout (which never drops bytes —
     * it fails instead).
     */
    text(): string {
        const total = new Uint8Array(this.retained)
        let offset = 0
        for (const chunk of this.chunks) {
            total.set(chunk, offset)
            offset += chunk.byteLength
        }
        return new TextDecoder().decode(total)
    }
}

/**
 * What the boundary hands back for stderr.
 *
 * A CLI tool's stderr routinely echoes its own configuration, and its
 * configuration routinely contains the API key it was given (Business Rules
 * #12 — keys and prompts are redacted from anything the user is shown). So
 * the content is deliberately awkward to reach: `summary` is a status-only
 * sentence safe for a Notice, the content is behind a `reveal()` call, and
 * both `toString` and `toJSON` return the summary so that interpolating this
 * object into a message or serializing it into an error report cannot leak
 * the transcript by accident.
 */
export interface StderrDiagnostics {
    readonly bytesSeen: number
    readonly truncated: boolean
    /** Status only — no content. Safe to show the user. */
    readonly summary: string
    /**
     * The captured text. For the developer console and for `console.debug`
     * only: it may contain credentials the tool echoed. Never route this into
     * a Notice, a settings message, or an error report.
     */
    reveal(): string
    toString(): string
    toJSON(): string
}

/** Builds the diagnostics view over a finished stderr capture. */
export function toStderrDiagnostics(capture: BoundedCapture): StderrDiagnostics {
    const bytesSeen = capture.bytesSeen
    const truncated = capture.isTruncated
    const summary =
        bytesSeen === 0
            ? 'The tool wrote nothing to its error stream.'
            : truncated
              ? `The tool wrote ${bytesSeen} bytes to its error stream (only the last ${capture.limitBytes} were kept).`
              : `The tool wrote ${bytesSeen} bytes to its error stream.`
    const text = capture.text()
    return {
        bytesSeen,
        truncated,
        summary,
        reveal: () => text,
        toString: () => summary,
        toJSON: () => summary
    }
}
