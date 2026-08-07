import { describe, expect, test } from 'bun:test'
import {
    COLOR_PRESETS,
    colorAnnouncement,
    isHexColor,
    presetLabel,
    rgbStringToHex
} from './color-field-model'

describe('isHexColor', () => {
    test('accepts 6-digit hex in any case', () => {
        expect(isHexColor('#a1B2c3')).toBe(true)
        expect(isHexColor('#000000')).toBe(true)
        expect(isHexColor('#FFFFFF')).toBe(true)
    })

    test('rejects 3-digit shorthand', () => {
        expect(isHexColor('#fff')).toBe(false)
    })

    test('rejects 8-digit hex (alpha)', () => {
        expect(isHexColor('#a1b2c3ff')).toBe(false)
    })

    test('rejects named colors and theme variables', () => {
        expect(isHexColor('red')).toBe(false)
        expect(isHexColor('var(--color-red)')).toBe(false)
    })

    test('rejects injection strings', () => {
        expect(isHexColor('#fff;}')).toBe(false)
        expect(isHexColor('#a1b2c3;background:url(x)')).toBe(false)
        expect(isHexColor('')).toBe(false)
    })
})

describe('presetLabel', () => {
    test('maps each of the 8 presets to its label', () => {
        expect(presetLabel('var(--color-red)')).toBe('red')
        expect(presetLabel('var(--color-orange)')).toBe('orange')
        expect(presetLabel('var(--color-yellow)')).toBe('yellow')
        expect(presetLabel('var(--color-green)')).toBe('green')
        expect(presetLabel('var(--color-cyan)')).toBe('cyan')
        expect(presetLabel('var(--color-blue)')).toBe('blue')
        expect(presetLabel('var(--color-purple)')).toBe('purple')
        expect(presetLabel('var(--color-pink)')).toBe('pink')
    })

    test('returns null for unknown values', () => {
        expect(presetLabel('var(--color-accent)')).toBeNull()
        expect(presetLabel('#ff0000')).toBeNull()
        expect(presetLabel('')).toBeNull()
    })
})

describe('rgbStringToHex', () => {
    test('parses rgb()', () => {
        expect(rgbStringToHex('rgb(255, 0, 0)')).toBe('#ff0000')
        expect(rgbStringToHex('rgb(0, 0, 0)')).toBe('#000000')
    })

    test('parses rgba() dropping alpha', () => {
        expect(rgbStringToHex('rgba(0, 128, 255, 0.5)')).toBe('#0080ff')
        expect(rgbStringToHex('rgba(18, 52, 86, 1)')).toBe('#123456')
    })

    test('tolerates whitespace variants', () => {
        expect(rgbStringToHex('rgb(255,0,0)')).toBe('#ff0000')
        expect(rgbStringToHex('  rgb( 12 , 34 , 56 )  ')).toBe('#0c2238')
    })

    test('returns null for out-of-range channels', () => {
        expect(rgbStringToHex('rgb(300,0,0)')).toBeNull()
        expect(rgbStringToHex('rgb(0,256,0)')).toBeNull()
    })

    test('returns null for non-rgb inputs', () => {
        expect(rgbStringToHex('')).toBeNull()
        expect(rgbStringToHex('oklch(0.7 0.1 30)')).toBeNull()
        expect(rgbStringToHex('#ff0000')).toBeNull()
        expect(rgbStringToHex('var(--color-red)')).toBeNull()
        expect(rgbStringToHex('rgb(1,2)')).toBeNull()
    })
})

describe('colorAnnouncement', () => {
    test('uses the human label for presets', () => {
        expect(colorAnnouncement('var(--color-red)')).toBe('Color set to red')
        expect(colorAnnouncement('var(--color-pink)')).toBe('Color set to pink')
    })

    test('uses the hex for custom colors', () => {
        expect(colorAnnouncement('#a1b2c3')).toBe('Color set to #a1b2c3')
    })

    test('falls back for anything else', () => {
        expect(colorAnnouncement('var(--color-accent)')).toBe('Color set')
        expect(colorAnnouncement('garbage')).toBe('Color set')
        expect(colorAnnouncement('')).toBe('Color set')
    })
})

describe('COLOR_PRESETS invariants', () => {
    test('has 8 entries, all theme color variables', () => {
        expect(COLOR_PRESETS).toHaveLength(8)
        for (const preset of COLOR_PRESETS) {
            expect(preset.value).toMatch(/^var\(--color-[a-z]+\)$/)
        }
    })

    test('values and labels are unique', () => {
        const values = COLOR_PRESETS.map((preset) => preset.value)
        const labels = COLOR_PRESETS.map((preset) => preset.label)
        expect(new Set(values).size).toBe(COLOR_PRESETS.length)
        expect(new Set(labels).size).toBe(COLOR_PRESETS.length)
    })
})
