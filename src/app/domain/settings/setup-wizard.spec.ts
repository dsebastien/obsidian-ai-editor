import { describe, expect, it } from 'bun:test'
import {
    SETUP_STEP_COUNT,
    SETUP_WIZARD_STEPS,
    advanceSetup,
    applySetupWizard,
    initialSetupDraft,
    nextSetupStep,
    previousSetupStep,
    retreatSetup,
    setupAdvanceBlock,
    setupOutcome,
    setupStepIndex
} from './setup-wizard'
import type { SetupWizardDraft, SetupWizardState } from './setup-wizard'
import { apiBackendSchema, editorConfigSchema, pluginSettingsSchema } from './settings-schema'
import type { ApiBackend, PluginSettingsV1 } from './settings-schema'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeBackend(overrides: Record<string, unknown> = {}): ApiBackend {
    return apiBackendSchema.parse({
        id: 'backend-new',
        family: 'api',
        kind: 'anthropic',
        label: 'Claude',
        apiKey: 'sk-test',
        defaultModel: 'claude-test-1',
        ...overrides
    })
}

function makeSettings(overrides: Record<string, unknown> = {}): PluginSettingsV1 {
    return pluginSettingsSchema.parse({
        editors: [
            editorConfigSchema.parse({ id: 'e1', name: 'Concision Editor' }),
            editorConfigSchema.parse({ id: 'e2', name: 'Humanizer', enabled: false })
        ],
        ...overrides
    })
}

function stateAt(stepId: SETUP_STEP, draft: SetupWizardDraft): SetupWizardState {
    return { stepId, draft }
}
type SETUP_STEP = (typeof SETUP_WIZARD_STEPS)[number]

// ---------------------------------------------------------------------------
// Step order
// ---------------------------------------------------------------------------

describe('setup wizard steps', () => {
    it('runs welcome → backend → editors → voice → mode → done', () => {
        expect([...SETUP_WIZARD_STEPS]).toEqual([
            'welcome',
            'backend',
            'editors',
            'voice',
            'mode',
            'done'
        ])
        expect(SETUP_STEP_COUNT).toBe(6)
    })

    it('indexes every step', () => {
        SETUP_WIZARD_STEPS.forEach((step, index) => {
            expect(setupStepIndex(step)).toBe(index)
        })
    })

    it('has no next step after the last one and no previous before the first', () => {
        expect(nextSetupStep('done')).toBeNull()
        expect(previousSetupStep('welcome')).toBeNull()
        expect(nextSetupStep('welcome')).toBe('backend')
        expect(previousSetupStep('done')).toBe('mode')
    })
})

// ---------------------------------------------------------------------------
// Draft seeding
// ---------------------------------------------------------------------------

describe('initialSetupDraft', () => {
    it('starts from the current settings, so a re-run edits rather than resets', () => {
        const settings = makeSettings({
            voiceProfile: { text: '', notePaths: ['Voice.md'], followLinks: true },
            behavior: { daemonAlwaysOn: true }
        })
        const draft = initialSetupDraft(settings)
        expect(draft.editors).toEqual([
            { id: 'e1', name: 'Concision Editor', enabled: true },
            { id: 'e2', name: 'Humanizer', enabled: false }
        ])
        expect(draft.voiceNotePaths).toEqual(['Voice.md'])
        expect(draft.voiceFollowLinks).toBe(true)
        expect(draft.daemonAlwaysOn).toBe(true)
    })

    it('starts with no backend — the wizard adds one, it never edits an existing one', () => {
        const settings = makeSettings({ backends: [makeBackend({ id: 'existing' })] })
        expect(initialSetupDraft(settings).backend).toBeNull()
    })
})

// ---------------------------------------------------------------------------
// Advancing
// ---------------------------------------------------------------------------

describe('setupAdvanceBlock', () => {
    const draft = initialSetupDraft(makeSettings())

    it('never blocks a step other than the backend step', () => {
        for (const step of SETUP_WIZARD_STEPS) {
            if (step === 'backend') {
                continue
            }
            expect(setupAdvanceBlock(stateAt(step, draft))).toBeNull()
        }
    })

    it('lets an untouched backend step through — skipping is allowed', () => {
        expect(setupAdvanceBlock(stateAt('backend', { ...draft, backend: null }))).toBeNull()
    })

    it('lets a complete backend through', () => {
        expect(
            setupAdvanceBlock(stateAt('backend', { ...draft, backend: makeBackend() }))
        ).toBeNull()
    })

    it('blocks a half-filled backend and says what is missing', () => {
        const block = setupAdvanceBlock(
            stateAt('backend', { ...draft, backend: makeBackend({ label: '  ' }) })
        )
        expect(block?.code).toBe('backend-incomplete')
        expect(block?.message).toBe('A label is required.')
    })

    it('refuses a backend with no model — the half-filled case the plan names', () => {
        // The Backends tab allows it (a user may set the model per editor); the
        // wizard cannot, because it wires what it adds as the GLOBAL default,
        // and every editor inheriting it would resolve `no-model-configured`.
        const block = setupAdvanceBlock(
            stateAt('backend', { ...draft, backend: makeBackend({ defaultModel: '  ' }) })
        )
        expect(block?.code).toBe('backend-model-required')
        expect(block?.message).toContain('model')
    })

    it('applies the same per-kind rules the Backends tab applies', () => {
        const block = setupAdvanceBlock(
            stateAt('backend', {
                ...draft,
                backend: makeBackend({ kind: 'openai-compatible', baseUrl: '' })
            })
        )
        expect(block?.message).toContain('base URL')
    })
})

describe('advanceSetup / retreatSetup', () => {
    const draft = initialSetupDraft(makeSettings())

    it('walks forward through every step and stops on the last', () => {
        let state = stateAt('welcome', draft)
        const visited = [state.stepId]
        for (let i = 0; i < 10; i += 1) {
            state = advanceSetup(state)
            visited.push(state.stepId)
        }
        expect(visited.slice(0, 6)).toEqual([...SETUP_WIZARD_STEPS])
        expect(state.stepId).toBe('done')
    })

    it('walks back to the first step and stops there', () => {
        let state = stateAt('done', draft)
        for (let i = 0; i < 10; i += 1) {
            state = retreatSetup(state)
        }
        expect(state.stepId).toBe('welcome')
    })

    it('refuses to advance a blocked step, returning the same state', () => {
        const blocked = stateAt('backend', {
            ...draft,
            backend: { ...makeBackend(), label: '' }
        })
        expect(advanceSetup(blocked)).toBe(blocked)
    })

    it('never mutates the draft while navigating', () => {
        const state = stateAt('welcome', draft)
        expect(advanceSetup(state).draft).toBe(draft)
        expect(retreatSetup(stateAt('mode', draft)).draft).toBe(draft)
    })
})

// ---------------------------------------------------------------------------
// Applying
// ---------------------------------------------------------------------------

describe('applySetupWizard', () => {
    it('marks the plugin onboarded', () => {
        const settings = makeSettings()
        expect(settings.onboarded).toBe(false)
        expect(applySetupWizard(settings, initialSetupDraft(settings)).onboarded).toBe(true)
    })

    it('adds the configured backend and makes it the default when there is none', () => {
        const settings = makeSettings()
        const next = applySetupWizard(settings, {
            ...initialSetupDraft(settings),
            backend: makeBackend()
        })
        expect(next.backends.map((backend) => backend.id)).toEqual(['backend-new'])
        expect(next.defaultBackend).toEqual({ backendId: 'backend-new', model: '' })
    })

    it('never repoints an existing default backend', () => {
        const settings = makeSettings({
            backends: [makeBackend({ id: 'existing' })],
            defaultBackend: { backendId: 'existing', model: '' }
        })
        const next = applySetupWizard(settings, {
            ...initialSetupDraft(settings),
            backend: makeBackend()
        })
        expect(next.backends).toHaveLength(2)
        expect(next.defaultBackend).toEqual({ backendId: 'existing', model: '' })
    })

    it('adds no backend when the step was skipped', () => {
        const settings = makeSettings()
        const next = applySetupWizard(settings, initialSetupDraft(settings))
        expect(next.backends).toEqual([])
        expect(next.defaultBackend).toBeNull()
    })

    it('applies editor enablement to the offered editors', () => {
        const settings = makeSettings()
        const next = applySetupWizard(settings, {
            ...initialSetupDraft(settings),
            editors: [
                { id: 'e1', name: 'Concision Editor', enabled: false },
                { id: 'e2', name: 'Humanizer', enabled: true }
            ]
        })
        expect(next.editors.map((editor) => editor.enabled)).toEqual([false, true])
    })

    it('leaves editors the wizard never offered untouched', () => {
        const settings = makeSettings()
        const draft = initialSetupDraft(settings)
        // A third editor appeared after the wizard opened.
        const grown = pluginSettingsSchema.parse({
            ...settings,
            editors: [
                ...settings.editors,
                editorConfigSchema.parse({ id: 'e3', name: 'Later', enabled: true })
            ]
        })
        const next = applySetupWizard(grown, {
            ...draft,
            editors: draft.editors.map((choice) => ({ ...choice, enabled: false }))
        })
        expect(next.editors.map((editor) => [editor.id, editor.enabled])).toEqual([
            ['e1', false],
            ['e2', false],
            ['e3', true]
        ])
    })

    it('writes the voice profile notes and follow-links choice, keeping the text', () => {
        const settings = makeSettings({
            voiceProfile: { text: 'Short sentences.', notePaths: ['Old.md'], followLinks: false }
        })
        const next = applySetupWizard(settings, {
            ...initialSetupDraft(settings),
            voiceNotePaths: ['New.md', 'Also.md'],
            voiceFollowLinks: true
        })
        expect(next.voiceProfile.notePaths).toEqual(['New.md', 'Also.md'])
        expect(next.voiceProfile.followLinks).toBe(true)
        expect(next.voiceProfile.text).toBe('Short sentences.')
    })

    it('writes the daemon choice', () => {
        const settings = makeSettings()
        expect(
            applySetupWizard(settings, { ...initialSetupDraft(settings), daemonAlwaysOn: true })
                .behavior.daemonAlwaysOn
        ).toBe(true)
    })

    it('changes nothing else and never mutates the input', () => {
        const settings = makeSettings({
            behavior: { excludedFolders: ['Private'], sizeWarningWords: 1_234 },
            rules: [
                { id: 'r1', match: { matchType: 'folder', value: 'Journal' }, effect: 'disabled' }
            ]
        })
        const before = structuredClone(settings)
        const next = applySetupWizard(settings, {
            ...initialSetupDraft(settings),
            backend: makeBackend()
        })
        expect(settings).toEqual(before)
        expect(next.behavior.excludedFolders).toEqual(['Private'])
        expect(next.behavior.sizeWarningWords).toBe(1_234)
        expect(next.rules).toEqual(settings.rules)
    })

    it('persists the VALIDATED backend, not the draft the user typed', () => {
        // `setupAdvanceBlock` normalized a copy and threw it away, so a pasted
        // base URL kept its whitespace: `http://localhost:11434 ` becomes
        // `http://localhost:11434 /api/chat`, which `new URL()` rejects — every
        // review failing on a backend whose settings field looks correct.
        const settings = makeSettings()
        const next = applySetupWizard(settings, {
            ...initialSetupDraft(settings),
            backend: makeBackend({
                kind: 'ollama',
                label: '  Local Ollama  ',
                baseUrl: 'http://localhost:11434 ',
                extraBodyJson: '  {"think": true}  '
            })
        })
        const added = next.backends[next.backends.length - 1]
        expect(added).toMatchObject({
            label: 'Local Ollama',
            baseUrl: 'http://localhost:11434',
            extraBodyJson: '{"think": true}'
        })
    })

    it('produces a schema-valid settings value', () => {
        const settings = makeSettings()
        const next = applySetupWizard(settings, {
            ...initialSetupDraft(settings),
            backend: makeBackend(),
            daemonAlwaysOn: true,
            voiceNotePaths: ['V.md']
        })
        expect(pluginSettingsSchema.safeParse(next).success).toBe(true)
    })
})

// ---------------------------------------------------------------------------
// Outcome
// ---------------------------------------------------------------------------

describe('setupOutcome', () => {
    it('counts what the wizard is about to change', () => {
        const settings = makeSettings()
        const outcome = setupOutcome(settings, {
            ...initialSetupDraft(settings),
            backend: makeBackend(),
            voiceNotePaths: ['A.md', 'B.md'],
            daemonAlwaysOn: true
        })
        expect(outcome).toEqual({
            backendAdded: true,
            becameDefaultBackend: true,
            hasBackend: true,
            enabledEditorCount: 1,
            voiceNoteCount: 2,
            daemonAlwaysOn: true
        })
    })

    it('reports that an added backend does NOT become the default when one exists', () => {
        const settings = makeSettings({
            backends: [makeBackend({ id: 'existing' })],
            defaultBackend: { backendId: 'existing', model: '' }
        })
        const outcome = setupOutcome(settings, {
            ...initialSetupDraft(settings),
            backend: makeBackend()
        })
        expect(outcome.backendAdded).toBe(true)
        expect(outcome.becameDefaultBackend).toBe(false)
    })

    it('counts zero enabled editors', () => {
        const settings = makeSettings()
        const draft = initialSetupDraft(settings)
        const outcome = setupOutcome(settings, {
            ...draft,
            editors: draft.editors.map((choice) => ({ ...choice, enabled: false }))
        })
        expect(outcome.enabledEditorCount).toBe(0)
    })
})
