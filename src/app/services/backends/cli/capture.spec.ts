import { describe, expect, it } from 'bun:test'
import { BoundedCapture, toStderrDiagnostics } from './capture'

const encode = (value: string): Uint8Array => new TextEncoder().encode(value)

describe('BoundedCapture — stdout policy (stop)', () => {
    it('accumulates chunks under the cap', () => {
        const capture = new BoundedCapture(64, 'stop')
        expect(capture.push(encode('hello '))).toBe(true)
        expect(capture.push(encode('world'))).toBe(true)
        expect(capture.text()).toBe('hello world')
        expect(capture.isTruncated).toBe(false)
        expect(capture.bytesSeen).toBe(11)
    })

    it('refuses the chunk that would cross the cap and keeps refusing', () => {
        const capture = new BoundedCapture(8, 'stop')
        expect(capture.push(encode('12345'))).toBe(true)
        expect(capture.push(encode('67890'))).toBe(false)
        expect(capture.push(encode('x'))).toBe(false)
        expect(capture.isTruncated).toBe(true)
        // Nothing partial is retained: a half-written JSON document would be
        // worse than none.
        expect(capture.text()).toBe('12345')
    })

    it('counts every byte the stream produced, including the refused ones', () => {
        const capture = new BoundedCapture(4, 'stop')
        capture.push(encode('abcd'))
        capture.push(encode('efghij'))
        expect(capture.bytesSeen).toBe(10)
    })

    it('measures bytes, not characters', () => {
        const capture = new BoundedCapture(4, 'stop')
        // Four emoji = 16 bytes.
        expect(capture.push(encode('🙂🙂🙂🙂'))).toBe(false)
    })
})

describe('BoundedCapture — stderr policy (keep-tail)', () => {
    it('keeps the tail and drops the oldest bytes', () => {
        const capture = new BoundedCapture(10, 'keep-tail')
        expect(capture.push(encode('0123456789'))).toBe(true)
        expect(capture.push(encode('ABCDE'))).toBe(true)
        expect(capture.text()).toBe('56789ABCDE')
        expect(capture.isTruncated).toBe(true)
        expect(capture.bytesSeen).toBe(15)
    })

    it('trims across chunk boundaries and never grows past the cap', () => {
        const capture = new BoundedCapture(6, 'keep-tail')
        for (const chunk of ['aa', 'bb', 'cc', 'dd', 'ee']) {
            capture.push(encode(chunk))
        }
        expect(capture.text()).toBe('ccddee')
        expect(capture.text().length).toBeLessThanOrEqual(6)
    })

    it('survives a single chunk larger than the cap', () => {
        const capture = new BoundedCapture(4, 'keep-tail')
        capture.push(encode('abcdefghij'))
        expect(capture.text()).toBe('ghij')
    })

    it('never asks the caller to stop the process', () => {
        const capture = new BoundedCapture(2, 'keep-tail')
        expect(capture.push(encode('aaaaaaaa'))).toBe(true)
    })
})

describe('toStderrDiagnostics', () => {
    it('reports status only, and keeps the content behind reveal()', () => {
        const capture = new BoundedCapture(1_024, 'keep-tail')
        capture.push(encode('Authorization: Bearer sk-super-secret'))
        const diagnostics = toStderrDiagnostics(capture)

        expect(diagnostics.summary).not.toContain('sk-super-secret')
        expect(diagnostics.summary).toContain('37 bytes')
        expect(diagnostics.reveal()).toContain('sk-super-secret')
    })

    it('cannot leak the transcript through interpolation or serialization', () => {
        const capture = new BoundedCapture(1_024, 'keep-tail')
        capture.push(encode('key=sk-super-secret'))
        const diagnostics = toStderrDiagnostics(capture)

        // `${diagnostics}` in product code is itself a lint error here
        // (`restrict-template-expressions`), which is the first line of
        // defence; this pins the second — coercion yields the status line.
        expect(String(diagnostics)).toBe(diagnostics.summary)
        expect(JSON.stringify({ stderr: diagnostics })).not.toContain('sk-super-secret')
        expect(JSON.stringify(diagnostics)).toBe(JSON.stringify(diagnostics.summary))
    })

    it('says so when the capture was truncated', () => {
        const capture = new BoundedCapture(4, 'keep-tail')
        capture.push(encode('abcdefghij'))
        const diagnostics = toStderrDiagnostics(capture)
        expect(diagnostics.truncated).toBe(true)
        expect(diagnostics.summary).toContain('last 4')
    })

    it('has a summary for silence', () => {
        const diagnostics = toStderrDiagnostics(new BoundedCapture(4, 'keep-tail'))
        expect(diagnostics.bytesSeen).toBe(0)
        expect(diagnostics.summary).toContain('nothing')
    })
})
