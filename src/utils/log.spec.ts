import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test'
import { log } from './log'

/**
 * `ReturnType<typeof spyOn>` widens to `any`, which trips the reviewer's
 * `no-unsafe-*` rules on every `.mockRestore()`. Only restoration is needed
 * here, so name exactly that.
 */
type RestorableSpy = { mockRestore: () => void }

describe('log', () => {
    let debugSpy: RestorableSpy
    let infoSpy: RestorableSpy
    let warnSpy: RestorableSpy
    let errorSpy: RestorableSpy
    let logSpy: RestorableSpy

    beforeEach(() => {
        debugSpy = spyOn(console, 'debug').mockImplementation(() => {})
        infoSpy = spyOn(console, 'info').mockImplementation(() => {})
        warnSpy = spyOn(console, 'warn').mockImplementation(() => {})
        errorSpy = spyOn(console, 'error').mockImplementation(() => {})
        logSpy = spyOn(console, 'log').mockImplementation(() => {})
    })

    afterEach(() => {
        debugSpy.mockRestore()
        infoSpy.mockRestore()
        warnSpy.mockRestore()
        errorSpy.mockRestore()
        logSpy.mockRestore()
    })

    it('does not produce console output at any level (catalog scorecard)', () => {
        log('test message')
        log('debug msg', 'debug')
        log('info msg', 'info')
        log('warn msg', 'warn')
        log('error msg', 'error')
        log('with data', 'error', { foo: 1 }, 'extra')

        expect(debugSpy).not.toHaveBeenCalled()
        expect(infoSpy).not.toHaveBeenCalled()
        expect(warnSpy).not.toHaveBeenCalled()
        expect(errorSpy).not.toHaveBeenCalled()
        expect(logSpy).not.toHaveBeenCalled()
    })

    it('does not throw at any level', () => {
        expect(() => log('x')).not.toThrow()
        expect(() => log('x', 'debug')).not.toThrow()
        expect(() => log('x', 'info')).not.toThrow()
        expect(() => log('x', 'warn')).not.toThrow()
        expect(() => log('x', 'error')).not.toThrow()
    })
})
