/**
 * Incremental Server-Sent Events decoder.
 *
 * Streaming providers (Anthropic, OpenAI, compatibles) frame their stream as
 * SSE. Network chunks arrive at arbitrary boundaries — mid-line, mid-UTF-8
 * sequence, mid-event — so decoding must be stateful and boundary-safe
 * (adversarial chunking is covered by spec tests). Byte-level decoding
 * (UTF-8 seams) is handled by a streaming `TextDecoder` upstream; this
 * decoder consumes text chunks.
 *
 * Scope: the subset of the SSE spec the providers actually use — `event:`,
 * `data:` (multi-line), comment lines (`:`), blank-line dispatch. `id:` and
 * `retry:` fields are ignored.
 */

export interface SseEvent {
    /** The `event:` field, or 'message' when absent (SSE default). */
    readonly event: string
    /** Joined `data:` lines (newline-separated, per spec). */
    readonly data: string
}

export class SseDecoder {
    private buffer = ''
    private eventType = ''
    private dataLines: string[] = []

    /**
     * Feeds one chunk of text; returns every event completed by this chunk.
     */
    push(chunk: string): SseEvent[] {
        this.buffer += chunk
        const events: SseEvent[] = []

        for (;;) {
            const newlineIndex = this.findLineEnd()
            if (newlineIndex === null) {
                break
            }
            const { line, nextStart } = newlineIndex
            this.buffer = this.buffer.slice(nextStart)
            const completed = this.processLine(line)
            if (completed) {
                events.push(completed)
            }
        }
        return events
    }

    /**
     * Flushes any pending event at stream end (providers normally end with a
     * blank line, but a truncated stream should still surface its last data).
     */
    end(): SseEvent[] {
        const events: SseEvent[] = []
        if (this.buffer.length > 0) {
            const completed = this.processLine(this.buffer)
            this.buffer = ''
            if (completed) {
                events.push(completed)
            }
        }
        const final = this.dispatch()
        if (final) {
            events.push(final)
        }
        return events
    }

    private findLineEnd(): { line: string; nextStart: number } | null {
        for (let i = 0; i < this.buffer.length; i++) {
            const ch = this.buffer[i]
            if (ch === '\n') {
                return { line: this.buffer.slice(0, i), nextStart: i + 1 }
            }
            if (ch === '\r') {
                // CRLF may be split across chunks: if CR is the last char,
                // wait for the next chunk to know whether LF follows.
                if (i === this.buffer.length - 1) {
                    return null
                }
                const skip = this.buffer[i + 1] === '\n' ? 2 : 1
                return { line: this.buffer.slice(0, i), nextStart: i + skip }
            }
        }
        return null
    }

    private processLine(line: string): SseEvent | null {
        if (line.length === 0) {
            return this.dispatch()
        }
        if (line.startsWith(':')) {
            return null // comment / keep-alive
        }
        const colonIndex = line.indexOf(':')
        const field = colonIndex === -1 ? line : line.slice(0, colonIndex)
        let value = colonIndex === -1 ? '' : line.slice(colonIndex + 1)
        if (value.startsWith(' ')) {
            value = value.slice(1)
        }
        if (field === 'event') {
            this.eventType = value
        } else if (field === 'data') {
            this.dataLines.push(value)
        }
        return null
    }

    private dispatch(): SseEvent | null {
        if (this.dataLines.length === 0) {
            this.eventType = ''
            return null
        }
        const event: SseEvent = {
            event: this.eventType.length > 0 ? this.eventType : 'message',
            data: this.dataLines.join('\n')
        }
        this.eventType = ''
        this.dataLines = []
        return event
    }
}

/**
 * Parses an SSE event's data as JSON, returning `null` on malformed payloads
 * instead of throwing — a malformed frame must never take down a run; the
 * caller decides whether to skip or abort (and validates the parsed value
 * with the operation contract's Zod schemas).
 */
export function parseSseJson(event: SseEvent): unknown {
    if (event.data === '[DONE]') {
        return null
    }
    try {
        return JSON.parse(event.data) as unknown
    } catch {
        return null
    }
}
