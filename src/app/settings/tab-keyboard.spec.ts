import { describe, expect, test } from 'bun:test'

import { isTabNavigationKey, nextTabIndex } from './tab-keyboard'

describe('isTabNavigationKey', () => {
    test('claims only the four keys the tabs pattern defines', () => {
        expect(isTabNavigationKey('ArrowLeft')).toBe(true)
        expect(isTabNavigationKey('ArrowRight')).toBe(true)
        expect(isTabNavigationKey('Home')).toBe(true)
        expect(isTabNavigationKey('End')).toBe(true)
    })

    test('leaves everything else to the browser', () => {
        for (const key of ['Enter', ' ', 'Tab', 'ArrowUp', 'ArrowDown', 'Escape', 'a']) {
            expect(isTabNavigationKey(key)).toBe(false)
        }
    })
})

describe('nextTabIndex', () => {
    test('arrows step through the bar', () => {
        expect(nextTabIndex('ArrowRight', 0, 7)).toBe(1)
        expect(nextTabIndex('ArrowLeft', 3, 7)).toBe(2)
    })

    test('arrows wrap at both ends', () => {
        expect(nextTabIndex('ArrowRight', 6, 7)).toBe(0)
        expect(nextTabIndex('ArrowLeft', 0, 7)).toBe(6)
    })

    test('Home and End jump', () => {
        expect(nextTabIndex('Home', 4, 7)).toBe(0)
        expect(nextTabIndex('End', 4, 7)).toBe(6)
    })

    test('a single tab stays put on every key', () => {
        for (const key of ['ArrowLeft', 'ArrowRight', 'Home', 'End'] as const) {
            expect(nextTabIndex(key, 0, 1)).toBe(0)
        }
    })

    test('an empty bar has nothing to move to', () => {
        expect(nextTabIndex('ArrowRight', 0, 0)).toBe(0)
        expect(nextTabIndex('End', -1, 0)).toBe(-1)
    })

    test('an out-of-range current index is treated as the first tab', () => {
        expect(nextTabIndex('ArrowRight', -1, 7)).toBe(1)
        expect(nextTabIndex('ArrowLeft', 99, 7)).toBe(6)
    })
})
