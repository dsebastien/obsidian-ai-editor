import { describe, expect, it } from 'bun:test'
import {
    STARTER_EDITOR_SPECS,
    STARTER_PANEL_MEMBER_NAMES,
    STARTER_PANEL_NAME,
    seedStarterPack
} from './starter-pack'
import {
    checkReferentialIntegrity,
    pluginSettingsSchema,
    type PluginSettingsV1
} from './settings-schema'

const freshSettings = (): PluginSettingsV1 => pluginSettingsSchema.parse({})

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

const wordCount = (text: string): number => text.trim().split(/\s+/).length

describe('seedStarterPack', () => {
    it('appends 6 editors and 1 panel and sets the seeded flag', () => {
        const seeded = seedStarterPack(freshSettings())
        expect(seeded.editors).toHaveLength(6)
        expect(seeded.panels).toHaveLength(1)
        expect(seeded.starterPackSeeded).toEqual(true)
    })

    it('produces settings that satisfy the plugin settings schema', () => {
        const seeded = seedStarterPack(freshSettings())
        expect(pluginSettingsSchema.safeParse(seeded).success).toEqual(true)
    })

    it('leaves follow-links OFF on starter prompts and the panel charter', () => {
        const seeded = seedStarterPack(freshSettings())
        for (const editor of seeded.editors) {
            expect(editor.prompt.followLinks).toEqual(false)
        }
        expect(seeded.panels[0]?.charter.followLinks).toEqual(false)
    })

    it('does not mutate the input settings', () => {
        const input = freshSettings()
        seedStarterPack(input)
        expect(input.editors).toHaveLength(0)
        expect(input.panels).toHaveLength(0)
        expect(input.starterPackSeeded).toEqual(false)
    })

    it('is idempotent: seeded settings pass through unchanged', () => {
        const seeded = seedStarterPack(freshSettings())
        const again = seedStarterPack(seeded)
        expect(again).toBe(seeded)
        expect(again.editors).toHaveLength(6)
        expect(again.panels).toHaveLength(1)
    })

    it('never duplicates when the flag is set, even with entities removed', () => {
        const seeded = seedStarterPack(freshSettings())
        const pruned: PluginSettingsV1 = { ...seeded, editors: [], panels: [] }
        const again = seedStarterPack(pruned)
        expect(again.editors).toHaveLength(0)
        expect(again.panels).toHaveLength(0)
    })

    it('preserves pre-existing user editors and panels', () => {
        const base = freshSettings()
        const withUser = pluginSettingsSchema.parse({
            ...base,
            editors: [{ id: 'user-editor', name: 'Mine' }]
        })
        const seeded = seedStarterPack(withUser)
        expect(seeded.editors).toHaveLength(7)
        expect(seeded.editors[0]?.id).toEqual('user-editor')
    })

    it('generates unique UUID v4 ids for every seeded entity', () => {
        const seeded = seedStarterPack(freshSettings())
        const panel = seeded.panels[0]
        expect(panel).toBeDefined()
        const ids = [...seeded.editors.map((editor) => editor.id), panel?.id ?? '']
        expect(new Set(ids).size).toEqual(ids.length)
        for (const id of ids) {
            expect(id).toMatch(UUID_PATTERN)
        }
    })

    it('generates fresh ids on every seeding (no fixed ids)', () => {
        const first = seedStarterPack(freshSettings())
        const second = seedStarterPack(freshSettings())
        expect(first.editors[0]?.id).not.toEqual(second.editors[0]?.id)
    })

    it('ships the six planned personas in order', () => {
        const seeded = seedStarterPack(freshSettings())
        expect(seeded.editors.map((editor) => editor.name)).toEqual([
            'Concision Editor',
            "Devil's Advocate",
            'Fact Checker',
            'Flow & Structure Editor',
            'Humanizer',
            'Beginner Reader'
        ])
    })

    it('gives every persona a distinct Obsidian palette color', () => {
        const seeded = seedStarterPack(freshSettings())
        const colors = seeded.editors.map((editor) => editor.color)
        expect(new Set(colors).size).toEqual(colors.length)
        for (const color of colors) {
            expect(color).toMatch(/^var\(--color-[a-z]+\)$/)
        }
    })

    it('gives every persona a substantial prompt that instructs verbatim quoting', () => {
        const seeded = seedStarterPack(freshSettings())
        for (const editor of seeded.editors) {
            const words = wordCount(editor.prompt.text)
            expect(words).toBeGreaterThanOrEqual(200)
            // Upper bound is a sanity rail against runaway prompt bloat, not a
            // style target — the Humanizer's taxonomy legitimately runs long.
            expect(words).toBeLessThanOrEqual(700)
            expect(editor.prompt.text).toMatch(/verbatim/i)
            expect(editor.prompt.notePaths).toEqual([])
        }
    })

    it('grants research capability to the Fact Checker only', () => {
        const seeded = seedStarterPack(freshSettings())
        for (const editor of seeded.editors) {
            expect(editor.capabilities.review).toEqual(true)
            expect(editor.capabilities.research).toEqual(editor.name === 'Fact Checker')
        }
    })

    it('wires the Pre-publish Review panel to the four planned members', () => {
        const seeded = seedStarterPack(freshSettings())
        const panel = seeded.panels[0]
        expect(panel).toBeDefined()
        if (!panel) {
            return
        }
        expect(panel.name).toEqual(STARTER_PANEL_NAME)
        expect(panel.memberEditorIds).toHaveLength(4)
        const nameById = new Map(seeded.editors.map((editor) => [editor.id, editor.name]))
        const memberNames = panel.memberEditorIds.map((id) => nameById.get(id))
        expect(memberNames).toEqual([...STARTER_PANEL_MEMBER_NAMES])
    })

    it('writes a charter that produces verdicts, top fixes, and dissent', () => {
        const seeded = seedStarterPack(freshSettings())
        const charter = seeded.panels[0]?.charter.text ?? ''
        expect(charter).toMatch(/publish, needs-work, or kill/)
        expect(charter).toMatch(/[Tt]op fixes/)
        expect(charter).toMatch(/[Dd]issent/)
    })

    it('passes referential integrity after seeding', () => {
        const seeded = seedStarterPack(freshSettings())
        expect(checkReferentialIntegrity(seeded)).toEqual([])
    })
})

describe('STARTER_EDITOR_SPECS', () => {
    it('covers every panel member name', () => {
        const editorNames = new Set(STARTER_EDITOR_SPECS.map((spec) => spec.name))
        for (const memberName of STARTER_PANEL_MEMBER_NAMES) {
            expect(editorNames.has(memberName)).toEqual(true)
        }
    })
})
