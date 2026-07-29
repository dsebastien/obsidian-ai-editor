import { describe, expect, it } from 'bun:test'
import { ProviderError, redactSecret } from './types'

describe('redactSecret', () => {
    it('replaces every occurrence of the secret', () => {
        expect(redactSecret('key sk-1 then sk-1 again', 'sk-1')).toBe(
            'key [redacted] then [redacted] again'
        )
    })

    it('returns the message untouched for an empty secret', () => {
        expect(redactSecret('nothing to hide', '')).toBe('nothing to hide')
    })

    it('leaves messages without the secret unchanged', () => {
        expect(redactSecret('all clear', 'sk-1')).toBe('all clear')
    })
})

describe('ProviderError', () => {
    it('carries a typed code and a proper name', () => {
        const error = new ProviderError('invalid-output', 'boom')
        expect(error).toBeInstanceOf(Error)
        expect(error.name).toBe('ProviderError')
        expect(error.code).toBe('invalid-output')
        expect(error.message).toBe('boom')
    })
})
