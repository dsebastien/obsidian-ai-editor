import { describe, expect, it } from 'bun:test'
import { SseDecoder, parseSseJson, type SseEvent } from './sse'

function decodeAll(chunks: string[]): SseEvent[] {
    const decoder = new SseDecoder()
    const events: SseEvent[] = []
    for (const chunk of chunks) {
        events.push(...decoder.push(chunk))
    }
    events.push(...decoder.end())
    return events
}

describe('SseDecoder', () => {
    it('decodes a simple event', () => {
        const events = decodeAll(['data: hello\n\n'])
        expect(events).toEqual([{ event: 'message', data: 'hello' }])
    })

    it('decodes a named event', () => {
        const events = decodeAll(['event: content_block_delta\ndata: {"x":1}\n\n'])
        expect(events).toEqual([{ event: 'content_block_delta', data: '{"x":1}' }])
    })

    it('joins multi-line data per spec', () => {
        const events = decodeAll(['data: line1\ndata: line2\n\n'])
        expect(events).toEqual([{ event: 'message', data: 'line1\nline2' }])
    })

    it('ignores comment lines (keep-alives)', () => {
        const events = decodeAll([': ping\n\ndata: real\n\n'])
        expect(events).toEqual([{ event: 'message', data: 'real' }])
    })

    it('handles multiple events in one chunk', () => {
        const events = decodeAll(['data: a\n\ndata: b\n\n'])
        expect(events.map((event) => event.data)).toEqual(['a', 'b'])
    })

    it('survives chunk boundaries mid-line', () => {
        const events = decodeAll(['da', 'ta: hel', 'lo\n', '\n'])
        expect(events).toEqual([{ event: 'message', data: 'hello' }])
    })

    it('survives chunk boundaries mid-event (every char its own chunk)', () => {
        const raw = 'event: delta\ndata: {"a":"b"}\n\ndata: tail\n\n'
        const events = decodeAll([...raw])
        expect(events).toEqual([
            { event: 'delta', data: '{"a":"b"}' },
            { event: 'message', data: 'tail' }
        ])
    })

    it('handles CRLF line endings', () => {
        const events = decodeAll(['data: a\r\n\r\n'])
        expect(events).toEqual([{ event: 'message', data: 'a' }])
    })

    it('handles CRLF split across chunks', () => {
        const events = decodeAll(['data: a\r', '\n\r', '\n'])
        expect(events).toEqual([{ event: 'message', data: 'a' }])
    })

    it('resets the event type after dispatch', () => {
        const events = decodeAll(['event: special\ndata: 1\n\ndata: 2\n\n'])
        expect(events).toEqual([
            { event: 'special', data: '1' },
            { event: 'message', data: '2' }
        ])
    })

    it('flushes a truncated final event on end()', () => {
        const events = decodeAll(['data: incomplete'])
        expect(events).toEqual([{ event: 'message', data: 'incomplete' }])
    })

    it('emits nothing for an empty stream', () => {
        expect(decodeAll([])).toEqual([])
        expect(decodeAll([''])).toEqual([])
    })

    it('emits nothing for blank lines without data', () => {
        expect(decodeAll(['\n\n\n'])).toEqual([])
    })

    it('preserves colons inside data values', () => {
        const events = decodeAll(['data: {"url":"https://x.test/a?b=c"}\n\n'])
        expect(events[0]?.data).toEqual('{"url":"https://x.test/a?b=c"}')
    })
})

describe('parseSseJson', () => {
    it('parses valid JSON payloads', () => {
        expect(parseSseJson({ event: 'message', data: '{"a":1}' })).toEqual({ a: 1 })
    })

    it('returns null for the OpenAI [DONE] sentinel', () => {
        expect(parseSseJson({ event: 'message', data: '[DONE]' })).toBeNull()
    })

    it('returns null for malformed JSON instead of throwing', () => {
        expect(parseSseJson({ event: 'message', data: '{"a":' })).toBeNull()
    })
})
