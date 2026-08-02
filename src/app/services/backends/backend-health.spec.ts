import { describe, expect, it } from 'bun:test'
import { BackendHealthRegistry, UNHEALTHY_AFTER } from './backend-health'

describe('BackendHealthRegistry (issue #23)', () => {
    it('reads healthy until the consecutive-failure threshold', () => {
        const registry = new BackendHealthRegistry()
        for (let i = 1; i < UNHEALTHY_AFTER; i++) {
            registry.recordFailure('b1', 'auth')
            expect(registry.isUnhealthy('b1')).toBeFalse()
        }
        registry.recordFailure('b1', 'auth')
        expect(registry.isUnhealthy('b1')).toBeTrue()
        expect(registry.lastFailure('b1')).toEqual({ code: 'auth', count: UNHEALTHY_AFTER })
    })

    it('any success resets the streak — the manual summon is the try-again gesture', () => {
        const registry = new BackendHealthRegistry()
        registry.recordFailure('b1', 'network')
        registry.recordFailure('b1', 'network')
        registry.recordFailure('b1', 'network')
        expect(registry.isUnhealthy('b1')).toBeTrue()
        registry.recordSuccess('b1')
        expect(registry.isUnhealthy('b1')).toBeFalse()
        expect(registry.lastFailure('b1')).toBeNull()
    })

    it('tracks backends independently and keeps the LAST failure code', () => {
        const registry = new BackendHealthRegistry()
        registry.recordFailure('b1', 'network')
        registry.recordFailure('b1', 'auth')
        expect(registry.lastFailure('b1')).toEqual({ code: 'auth', count: 2 })
        expect(registry.lastFailure('b2')).toBeNull()
        expect(registry.isUnhealthy('b2')).toBeFalse()
    })

    it('resetAll clears every verdict (settings changed)', () => {
        const registry = new BackendHealthRegistry()
        registry.recordFailure('b1', 'auth')
        registry.recordFailure('b1', 'auth')
        registry.recordFailure('b1', 'auth')
        registry.resetAll()
        expect(registry.isUnhealthy('b1')).toBeFalse()
    })
})
