import { describe, expect, it } from 'bun:test'
import { builtInActionIdSchema, verbClassSchema } from '../settings/settings-schema'
import { BUILT_IN_VERBS, getBuiltInVerb, resolveActionVerb, verbClassLabel } from './verb-registry'

describe('verb registry', () => {
    it('covers every built-in action id exactly once', () => {
        const schemaIds = [...builtInActionIdSchema.options].sort()
        const registryIds = BUILT_IN_VERBS.map((verb) => verb.id)
        expect([...registryIds].sort()).toEqual(schemaIds)
        expect(new Set(registryIds).size).toBe(registryIds.length)
    })

    it('classifies transform, generate, and review verbs as designed', () => {
        const byClass = (verbClass: string): string[] =>
            BUILT_IN_VERBS.filter((verb) => verb.verbClass === verbClass)
                .map((verb) => verb.id)
                .sort()
        expect(byClass('transform')).toEqual(['humanize', 'rephrase', 'simplify', 'summarize'])
        expect(byClass('generate')).toEqual([
            'continue',
            'continue-note',
            'expand-section',
            'say-more'
        ])
        expect(byClass('review')).toEqual([
            'critique',
            'find-evidence',
            'find-references',
            'identify-assumptions'
        ])
    })

    it('gives every verb a sentence-case label and a substantial instruction', () => {
        for (const verb of BUILT_IN_VERBS) {
            expect(verb.label.length).toBeGreaterThan(0)
            // Sentence case: leading capital, no SHOUTING, no trailing space.
            expect(verb.label[0]).toBe(verb.label[0]?.toUpperCase() ?? '')
            expect(verb.label).toBe(verb.label.trim())
            expect(verb.label.toUpperCase()).not.toBe(verb.label)
            // Instructions are real prompts, not placeholders.
            expect(verb.instruction.length).toBeGreaterThan(100)
        }
        const labels = BUILT_IN_VERBS.map((verb) => verb.label)
        expect(new Set(labels).size).toBe(labels.length)
        const instructions = BUILT_IN_VERBS.map((verb) => verb.instruction)
        expect(new Set(instructions).size).toBe(instructions.length)
    })

    it('keeps transform/generate instructions free of output-format directives', () => {
        // The prompt serializer appends the kind-level output rules; verb
        // instructions must not fight it with their own JSON/format demands.
        for (const verb of BUILT_IN_VERBS) {
            if (verb.verbClass === 'review') {
                continue
            }
            expect(verb.instruction.toLowerCase()).not.toContain('json')
            expect(verb.instruction.toLowerCase()).not.toContain('output format')
        }
    })

    it('resolves verbs by id and returns null for unknown ids', () => {
        const rephrase = getBuiltInVerb('rephrase')
        expect(rephrase?.verbClass).toBe('transform')
        expect(rephrase?.label).toBe('Rephrase')
        expect(getBuiltInVerb('not-a-verb')).toBeNull()
        expect(getBuiltInVerb('4f2b7a9e-0000-0000-0000-000000000000')).toBeNull()
    })
})

describe('resolveActionVerb', () => {
    const custom = {
        label: 'Make a checklist',
        verbClass: 'generate' as const,
        instruction: 'Turn this into a checklist.'
    }

    it('resolves a built-in id from the registry, ignoring any supplied custom verb', () => {
        // A persisted binding must never redefine what "Humanize" does.
        expect(resolveActionVerb('humanize', custom)).toEqual(getBuiltInVerb('humanize') as never)
    })

    it('resolves a custom verb for a non-registry id, class included', () => {
        const verb = resolveActionVerb('4f2b7a9e-0000-0000-0000-000000000000', custom)
        expect(verb).toEqual(custom)
    })

    it('returns null without a custom verb, or when its instruction is blank', () => {
        expect(resolveActionVerb('4f2b7a9e-0000-0000-0000-000000000000')).toBeNull()
        expect(
            resolveActionVerb('4f2b7a9e-0000-0000-0000-000000000000', {
                ...custom,
                instruction: '   \n'
            })
        ).toBeNull()
    })
})

describe('verbClassLabel', () => {
    it('labels every class distinctly in sentence case', () => {
        const labels = verbClassSchema.options.map((option) => verbClassLabel(option))
        for (const label of labels) {
            expect(label.length).toBeGreaterThan(0)
            expect(label).toBe(label.trim())
            expect(label[0]).toBe(label[0]?.toUpperCase() ?? '')
        }
        expect(new Set(labels).size).toBe(labels.length)
    })
})
