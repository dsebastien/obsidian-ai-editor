import { describe, expect, it } from 'bun:test'
import {
    STARTER_ACTION_BINDINGS,
    STARTER_EDITOR_SPECS,
    STARTER_PANEL_MEMBER_NAMES,
    STARTER_PANEL_NAME,
    seedStarterPack
} from './starter-pack'
import { getBuiltInVerb } from '../actions/verb-registry'
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

    it('writes a charter that briefs the members instead of scripting the chairperson', () => {
        const seeded = seedStarterPack(freshSettings())
        const charter = seeded.panels[0]?.charter.text ?? ''
        // The charter reaches every member's prompt AND the aggregation call,
        // so it must state what the panel weighs...
        expect(charter).toMatch(/ready to publish/)
        expect(charter).toMatch(/load-bearing objection outweighs/)
        // ...and must NOT address one member as if it were the whole panel,
        // nor re-specify the output the operation contract already dictates.
        expect(charter).not.toMatch(/You are the chairperson/)
        expect(charter).not.toMatch(/missing-members list/)
        // A panel must not homogenize its members (plan M6).
        expect(charter).toMatch(/keeps its own mandate/)
    })

    it('binds the default action verbs to the matching personas', () => {
        const seeded = seedStarterPack(freshSettings())
        const nameById = new Map(seeded.editors.map((editor) => [editor.id, editor.name]))
        expect(seeded.actions).toHaveLength(STARTER_ACTION_BINDINGS.length)
        for (const [index, expected] of STARTER_ACTION_BINDINGS.entries()) {
            const action = seeded.actions[index]
            expect(action).toBeDefined()
            if (!action) {
                continue
            }
            // Verb id doubles as the binding entity id (stable command ids).
            expect(action.id).toEqual(expected.actionId)
            expect(action.actionId).toEqual(expected.actionId)
            expect(action.binding?.targetType).toEqual('editor')
            expect(nameById.get(action.binding?.targetId ?? '')).toEqual(expected.editorName)
        }
    })

    it('only binds verbs to personas holding the class-appropriate capability', () => {
        // Transform verbs need rewrite, review-class verbs need review —
        // every starter persona ships both, but pin the invariant so a
        // starter-pack edit cannot silently seed an undispatchable binding.
        const seeded = seedStarterPack(freshSettings())
        const editorById = new Map(seeded.editors.map((editor) => [editor.id, editor]))
        for (const action of seeded.actions) {
            const verb = getBuiltInVerb(action.actionId)
            expect(verb).not.toBeNull()
            const editor = editorById.get(action.binding?.targetId ?? '')
            expect(editor).toBeDefined()
            if (!verb || !editor) {
                continue
            }
            const capability =
                verb.verbClass === 'review'
                    ? editor.capabilities.review
                    : editor.capabilities.rewrite
            expect(capability).toEqual(true)
        }
    })

    it('leaves the generate verbs unbound (no authorial starter persona)', () => {
        const seeded = seedStarterPack(freshSettings())
        const boundVerbs = seeded.actions.map((action) => action.actionId)
        expect(boundVerbs).not.toContain('continue')
        expect(boundVerbs).not.toContain('say-more')
    })

    it('never overrides a verb the user already bound', () => {
        const base = freshSettings()
        const withUser = pluginSettingsSchema.parse({
            ...base,
            editors: [{ id: 'user-editor', name: 'Mine' }],
            actions: [
                {
                    id: 'humanize',
                    actionId: 'humanize',
                    binding: { targetType: 'editor', targetId: 'user-editor' }
                }
            ]
        })
        const seeded = seedStarterPack(withUser)
        const humanize = seeded.actions.filter((action) => action.actionId === 'humanize')
        expect(humanize).toHaveLength(1)
        expect(humanize[0]?.binding?.targetId).toEqual('user-editor')
        expect(seeded.actions).toHaveLength(STARTER_ACTION_BINDINGS.length)
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

    it('covers every default action binding persona name', () => {
        const editorNames = new Set(STARTER_EDITOR_SPECS.map((spec) => spec.name))
        for (const binding of STARTER_ACTION_BINDINGS) {
            expect(editorNames.has(binding.editorName)).toEqual(true)
        }
    })
})

describe('STARTER_ACTION_BINDINGS', () => {
    it('binds each verb at most once and only to real built-in verbs', () => {
        const verbs = STARTER_ACTION_BINDINGS.map((binding) => binding.actionId)
        expect(new Set(verbs).size).toEqual(verbs.length)
        for (const verb of verbs) {
            expect(getBuiltInVerb(verb)).not.toBeNull()
        }
    })
})
