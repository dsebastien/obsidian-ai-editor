import { describe, expect, it } from 'bun:test'
import type { App } from 'obsidian'
import { isStarterKitAvailable, normalizeOskNoteType, readOskNoteTypes } from './osk-note-types'
import { STARTER_KIT_PLUGIN_IDS } from './osk-note-types'

/**
 * The adapter only touches `app.plugins.plugins[<id>].api.listNoteTypes`, so a
 * structural fake covers it entirely (obsidian imports are type-only).
 */
function fakeApp(api: unknown): App {
    return {
        plugins: { plugins: { [STARTER_KIT_PLUGIN_IDS[0]]: { api } } }
    } as unknown as App
}

const PERSONAL = {
    id: 'nt-0001',
    name: 'Personal Notes',
    mappings: [
        { type: 'tag', value: 'type/personal', enabled: true },
        { type: 'regex', value: '.* \\(Personal\\)$', enabled: true }
    ]
}

describe('isStarterKitAvailable', () => {
    it('is false without the plugin, without an api, or without the method', () => {
        expect(isStarterKitAvailable({} as unknown as App)).toBe(false)
        expect(isStarterKitAvailable(fakeApp(undefined))).toBe(false)
        expect(isStarterKitAvailable(fakeApp({}))).toBe(false)
    })

    it('is true once the api exposes listNoteTypes', () => {
        expect(isStarterKitAvailable(fakeApp({ listNoteTypes: () => [] }))).toBe(true)
    })
})

describe('normalizeOskNoteType', () => {
    it('keeps the name and every usable mapping', () => {
        expect(normalizeOskNoteType(PERSONAL)).toEqual({
            name: 'Personal Notes',
            mappings: [
                { type: 'tag', value: 'type/personal', enabled: true },
                { type: 'regex', value: '.* \\(Personal\\)$', enabled: true }
            ]
        })
    })

    it('treats an absent enabled flag as enabled', () => {
        expect(
            normalizeOskNoteType({ name: 'X', mappings: [{ type: 'tag', value: 'a' }] })
        ).toEqual({ name: 'X', mappings: [{ type: 'tag', value: 'a', enabled: true }] })
    })

    it('drops entries without a usable name', () => {
        expect(normalizeOskNoteType({ mappings: [] })).toBeNull()
        expect(normalizeOskNoteType({ name: '   ' })).toBeNull()
        expect(normalizeOskNoteType('Personal Notes')).toBeNull()
        expect(normalizeOskNoteType(null)).toBeNull()
    })

    it('drops malformed mappings but keeps the type', () => {
        expect(
            normalizeOskNoteType({
                name: 'X',
                mappings: [{ type: 'tag' }, 'nope', null, { value: 'a' }]
            })
        ).toEqual({ name: 'X', mappings: [] })
    })

    it('keeps a type whose mappings are missing entirely', () => {
        expect(normalizeOskNoteType({ name: 'X' })).toEqual({ name: 'X', mappings: [] })
    })
})

describe('readOskNoteTypes', () => {
    it('reads a plain array', () => {
        const types = readOskNoteTypes(fakeApp({ listNoteTypes: () => [PERSONAL] }))
        expect(types.map((type) => type.name)).toEqual(['Personal Notes'])
    })

    it('unwraps an ApiResult envelope', () => {
        const types = readOskNoteTypes(
            fakeApp({ listNoteTypes: () => ({ success: true, data: [PERSONAL] }) })
        )
        expect(types).toHaveLength(1)
    })

    it('returns [] for a failed envelope', () => {
        expect(readOskNoteTypes(fakeApp({ listNoteTypes: () => ({ success: false }) }))).toEqual([])
    })

    it('returns [] when the plugin is absent or the shape is unexpected', () => {
        expect(readOskNoteTypes({} as unknown as App)).toEqual([])
        expect(readOskNoteTypes(fakeApp({ listNoteTypes: () => 'nope' }))).toEqual([])
        expect(readOskNoteTypes(fakeApp({ listNoteTypes: () => null }))).toEqual([])
    })

    it('returns [] instead of throwing when the api throws', () => {
        expect(
            readOskNoteTypes(
                fakeApp({
                    listNoteTypes: () => {
                        throw new Error('boom')
                    }
                })
            )
        ).toEqual([])
    })
})

describe('plugin id probing', () => {
    const api = { listNoteTypes: () => [{ name: 'Personal Notes', mappings: [] }] }

    it('finds the Starter Kit under its manifest id', () => {
        const app = { plugins: { plugins: { 'obsidian-starter-kit': { api } } } } as unknown as App
        expect(isStarterKitAvailable(app)).toBe(true)
        expect(readOskNoteTypes(app).map((t) => t.name)).toEqual(['Personal Notes'])
    })

    it('also finds it under the folder-shaped id', () => {
        // The vault folder is `obsidian-starter-kit-plugin` while the manifest
        // id is `obsidian-starter-kit`; probing only the folder spelling was
        // the bug that reported "not detected" in a vault that had it enabled.
        const app = {
            plugins: { plugins: { 'obsidian-starter-kit-plugin': { api } } }
        } as unknown as App
        expect(isStarterKitAvailable(app)).toBe(true)
    })

    it('stays unavailable when neither id is present', () => {
        const app = { plugins: { plugins: { 'some-other-plugin': { api } } } } as unknown as App
        expect(isStarterKitAvailable(app)).toBe(false)
        expect(readOskNoteTypes(app)).toEqual([])
    })
})
