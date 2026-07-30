import { describe, expect, it } from 'bun:test'
import {
    apiBackendSchema,
    cliBackendSchema,
    editorConfigSchema,
    pluginSettingsSchema
} from '../domain/settings/settings-schema'
import type { ApiBackend, EditorConfig, PluginSettingsV1 } from '../domain/settings/settings-schema'
import { createSnapshot, hashText } from '../domain/snapshot'
import { RunController } from './orchestration/run-controller'
import { reviewGate } from './reviewability'
import type { NoteMetadata, VaultReader } from './context/vault-reader.intf'
import {
    augmentPanelCharter,
    augmentResponseLanguage,
    augmentSystemPrompt,
    buildEditorPrompt,
    composeSystemPrompt,
    countWords,
    createEditorSpec,
    isRequestedSelectionValid,
    resolveEditorBackend,
    skipReasonLabel,
    startReview
} from './review-service'
import type { AssembledContext } from './context/context-assembler'
import { reviewOperation } from './backends/providers/spec-fixtures'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const API_KEY = 'sk-review-secret-42'

function makeBackend(overrides: Partial<ApiBackend> = {}): ApiBackend {
    return apiBackendSchema.parse({
        id: 'backend-1',
        family: 'api',
        kind: 'anthropic',
        label: 'Claude',
        apiKey: API_KEY,
        defaultModel: 'claude-test-1',
        ...overrides
    })
}

function makeEditor(overrides: Record<string, unknown> = {}): EditorConfig {
    return editorConfigSchema.parse({
        id: 'editor-1',
        name: 'Hater',
        color: 'var(--color-red)',
        ...overrides
    })
}

function makeSettings(overrides: Record<string, unknown> = {}): PluginSettingsV1 {
    return pluginSettingsSchema.parse({
        backends: [makeBackend()],
        defaultBackend: { backendId: 'backend-1', model: '' },
        editors: [makeEditor()],
        ...overrides
    })
}

class FakeVault implements VaultReader {
    readonly notes = new Map<string, string>()
    readonly metadata = new Map<string, NoteMetadata>()
    readonly noteTypeIds = new Map<string, readonly string[]>()

    async readNote(path: string): Promise<string | null> {
        return this.notes.get(path) ?? null
    }

    resolveLink(): string | null {
        return null
    }

    getOutgoingLinks(): string[] {
        return []
    }

    getNoteMetadata(path: string): NoteMetadata | null {
        return this.metadata.get(path) ?? { tags: [], frontmatter: {} }
    }

    getNoteTypeIds(path: string): readonly string[] {
        return this.noteTypeIds.get(path) ?? []
    }
}

/**
 * Minimal `AssembledContext` for the pure prompt-composition tests. Sections
 * and the budget report are the preview's business (covered in
 * `context/context-assembler.spec.ts`); `composeSystemPrompt` reads neither.
 */
function assembled(overrides: Partial<AssembledContext> = {}): AssembledContext {
    return {
        systemPrompt: '',
        attachments: [],
        sections: [],
        budget: {
            budgetChars: 200_000,
            totalChars: 0,
            overBudgetChars: 0,
            truncatedPaths: [],
            droppedPaths: []
        },
        ...overrides
    }
}

const DOC_TEXT = 'Hello world. This is a test document about writing well.'

function makeSnapshot(text = DOC_TEXT, filePath = 'Notes/Test.md') {
    return createSnapshot({ filePath, text })
}

/**
 * Anthropic-shaped SSE stream carrying a valid review result. The executor
 * streams Anthropic backends (`capabilities().streaming`), so success bodies
 * must be SSE-framed — the accumulated payload is then validated through the
 * same `parseBufferedResponse` as the buffered path.
 */
function anthropicReviewBody(): string {
    const resultInput = {
        kind: 'review',
        findings: [
            {
                quote: 'Hello world',
                critique: 'Generic opening line',
                suggestion: 'Bonjour world',
                severity: 'suggestion'
            }
        ],
        summary: 'Solid draft'
    }
    const frames = [
        {
            type: 'content_block_start',
            index: 0,
            content_block: { type: 'tool_use', name: 'emit_result', input: {} }
        },
        {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'input_json_delta', partial_json: JSON.stringify(resultInput) }
        },
        { type: 'message_stop' }
    ]
    return frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join('')
}

function fetchReturning(body: string, status = 200): typeof fetch {
    return (() => Promise.resolve(new Response(body, { status }))) as unknown as typeof fetch
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe('countWords', () => {
    it('counts whitespace-delimited words', () => {
        expect(countWords('one two  three\nfour\t five')).toBe(5)
    })

    it('returns 0 for empty or whitespace-only text', () => {
        expect(countWords('')).toBe(0)
        expect(countWords('   \n\t ')).toBe(0)
    })
})

describe('skipReasonLabel', () => {
    it('labels every reason', () => {
        const reasons = [
            'no-review-capability',
            'no-backend-configured',
            'backend-not-found',
            'backend-disabled',
            'cli-consent-required',
            'no-model-configured',
            'editor-disabled',
            'editor-missing'
        ] as const
        for (const reason of reasons) {
            expect(skipReasonLabel(reason).length).toBeGreaterThan(0)
        }
    })
})

describe('isRequestedSelectionValid', () => {
    const fresh = { hash: hashText(DOC_TEXT), text: DOC_TEXT }

    it('accepts an ordered non-empty range inside the unchanged text', () => {
        expect(isRequestedSelectionValid({ from: 0, to: 11 }, fresh.hash, fresh)).toBe(true)
        expect(isRequestedSelectionValid({ from: 0, to: DOC_TEXT.length }, fresh.hash, fresh)).toBe(
            true
        )
    })

    it('rejects degenerate and inverted ranges', () => {
        expect(isRequestedSelectionValid({ from: 5, to: 5 }, fresh.hash, fresh)).toBe(false)
        expect(isRequestedSelectionValid({ from: 11, to: 3 }, fresh.hash, fresh)).toBe(false)
    })

    it('rejects out-of-bounds offsets', () => {
        expect(isRequestedSelectionValid({ from: -1, to: 5 }, fresh.hash, fresh)).toBe(false)
        expect(
            isRequestedSelectionValid({ from: 0, to: DOC_TEXT.length + 1 }, fresh.hash, fresh)
        ).toBe(false)
    })

    it('rejects when the text changed since capture, even with fitting bounds', () => {
        const capturedHash = hashText(`EDIT! ${DOC_TEXT}`)
        expect(isRequestedSelectionValid({ from: 0, to: 11 }, capturedHash, fresh)).toBe(false)
    })
})

describe('resolveEditorBackend', () => {
    it('inherits the global default backend and its default model', () => {
        const settings = makeSettings()
        const resolution = resolveEditorBackend(settings, settings.editors[0]!)
        expect(resolution).toEqual({
            ok: true,
            backend: settings.backends[0] as ApiBackend,
            model: 'claude-test-1'
        })
    })

    it('prefers the editor-level backend ref and model override', () => {
        const other = makeBackend({ id: 'backend-2', label: 'Other', defaultModel: 'other-model' })
        const settings = makeSettings({
            backends: [makeBackend(), other],
            editors: [makeEditor({ backend: { backendId: 'backend-2', model: 'override' } })]
        })
        const resolution = resolveEditorBackend(settings, settings.editors[0]!)
        expect(resolution).toEqual({ ok: true, backend: other, model: 'override' })
    })

    it('reports missing configuration as typed skips', () => {
        const editor = makeEditor()
        expect(resolveEditorBackend(makeSettings({ defaultBackend: null }), editor)).toEqual({
            ok: false,
            reason: 'no-backend-configured'
        })
        expect(
            resolveEditorBackend(
                makeSettings({ defaultBackend: { backendId: 'ghost', model: '' } }),
                editor
            )
        ).toEqual({ ok: false, reason: 'backend-not-found' })
        expect(
            resolveEditorBackend(
                makeSettings({ backends: [makeBackend({ enabled: false })] }),
                editor
            )
        ).toEqual({ ok: false, reason: 'backend-disabled' })
        expect(
            resolveEditorBackend(
                makeSettings({ backends: [makeBackend({ defaultModel: '' })] }),
                editor
            )
        ).toEqual({ ok: false, reason: 'no-model-configured' })
    })

    it('refuses an enabled CLI backend the user never consented to launching', () => {
        // `enabled` is not consent: a synced or hand-edited data.json can set
        // it without anyone having been shown what launching a program means.
        const cli = cliBackendSchema.parse({
            id: 'backend-1',
            family: 'cli',
            kind: 'claude-code',
            label: 'Claude Code',
            executablePath: '/usr/local/bin/claude',
            enabled: true
        })
        const settings = makeSettings({ backends: [cli] })
        expect(resolveEditorBackend(settings, settings.editors[0]!)).toEqual({
            ok: false,
            reason: 'cli-consent-required'
        })
    })

    it('refuses a CLI backend whose consent names a different executable', () => {
        const cli = cliBackendSchema.parse({
            id: 'backend-1',
            family: 'cli',
            kind: 'claude-code',
            label: 'Claude Code',
            executablePath: '/opt/new/claude',
            consent: { launchPath: '/usr/local/bin/claude', toolsPath: '' },
            enabled: true
        })
        const settings = makeSettings({ backends: [cli] })
        expect(resolveEditorBackend(settings, settings.editors[0]!)).toEqual({
            ok: false,
            reason: 'cli-consent-required'
        })
    })

    it('resolves a consented CLI backend, and lets an empty model mean the tool default', () => {
        const cli = cliBackendSchema.parse({
            id: 'backend-1',
            family: 'cli',
            kind: 'claude-code',
            label: 'Claude Code',
            executablePath: '/usr/local/bin/claude',
            consent: { launchPath: '/usr/local/bin/claude', toolsPath: '' },
            enabled: true
        })
        const settings = makeSettings({ backends: [cli] })
        expect(resolveEditorBackend(settings, settings.editors[0]!)).toEqual({
            ok: true,
            backend: cli,
            model: ''
        })
    })

    it('prefers the editor model override over the CLI backend default', () => {
        const cli = cliBackendSchema.parse({
            id: 'backend-1',
            family: 'cli',
            kind: 'claude-code',
            label: 'Claude Code',
            executablePath: '/usr/local/bin/claude',
            defaultModel: 'backend-default',
            consent: { launchPath: '/usr/local/bin/claude', toolsPath: '' },
            enabled: true
        })
        const settings = makeSettings({ backends: [cli] })
        const editor = {
            ...settings.editors[0]!,
            backend: { backendId: 'backend-1', model: 'opus' }
        }
        expect(resolveEditorBackend(settings, editor)).toMatchObject({ ok: true, model: 'opus' })
    })
})

describe('composeSystemPrompt', () => {
    it('returns the bare system prompt without attachments', () => {
        expect(composeSystemPrompt(assembled({ systemPrompt: 'Be harsh.' }))).toBe('Be harsh.')
    })

    it('appends attachments as delimited context blocks', () => {
        const prompt = composeSystemPrompt(
            assembled({
                systemPrompt: 'Be harsh.',
                attachments: [
                    { path: 'Voice "Profile".md', content: 'Voice rules', reason: 'prompt-ref' }
                ]
            })
        )
        expect(prompt).toStartWith('Be harsh.')
        expect(prompt).toContain('<context-note role="prompt-ref" path="Voice \'Profile\'.md">')
        expect(prompt).toContain('Voice rules')
        expect(prompt).toContain('</context-note>')
    })

    it('labels each block with WHY the note is attached', () => {
        const prompt = composeSystemPrompt(
            assembled({
                attachments: [
                    { path: 'Persona.md', content: 'p', reason: 'prompt-ref' },
                    { path: 'Linked.md', content: 'l', reason: 'linked-note' }
                ]
            })
        )
        expect(prompt).toContain('<context-note role="prompt-ref" path="Persona.md">')
        expect(prompt).toContain('<context-note role="linked-note" path="Linked.md">')
    })
})

// ---------------------------------------------------------------------------
// augmentSystemPrompt
// ---------------------------------------------------------------------------

describe('augmentSystemPrompt', () => {
    it('appends the instruction as a framed, delimited block after the base prompt', () => {
        const prompt = augmentSystemPrompt('Be harsh.', 'Is this argument convincing?')
        expect(prompt).toStartWith('Be harsh.')
        expect(prompt).toContain(
            '<user-instruction>\nIs this argument convincing?\n</user-instruction>'
        )
        // The framing subordinates the instruction to the output contract.
        expect(prompt).toContain('the required output format is unchanged')
    })

    it('trims the instruction and leaves the prompt untouched when blank', () => {
        expect(augmentSystemPrompt('Be harsh.', '   \n\t ')).toBe('Be harsh.')
        expect(augmentSystemPrompt('Be harsh.', '')).toBe('Be harsh.')
        expect(augmentSystemPrompt('Be harsh.', '  focus here  ')).toContain(
            '<user-instruction>\nfocus here\n</user-instruction>'
        )
    })

    it('yields only the block for an empty base prompt', () => {
        const prompt = augmentSystemPrompt('', 'focus here')
        expect(prompt).toStartWith('The user asked you')
        expect(prompt).toContain('focus here')
    })
})

// ---------------------------------------------------------------------------
// augmentPanelCharter (plan M6)
// ---------------------------------------------------------------------------

describe('augmentPanelCharter', () => {
    it('appends the charter as a framed block naming the panel', () => {
        const prompt = augmentPanelCharter('Be harsh.', 'Pre-publish Review', 'Weigh the reader.')
        expect(prompt).toStartWith('Be harsh.')
        expect(prompt).toContain('<panel-charter>\nWeigh the reader.\n</panel-charter>')
        expect(prompt).toContain('"Pre-publish Review" panel')
    })

    it('keeps the member in its own lane — a panel must not homogenize members', () => {
        const prompt = augmentPanelCharter('Be harsh.', 'Panel', 'Weigh the reader.')
        expect(prompt).toContain('does not replace your own mandate')
        expect(prompt).toContain('does not change the required output format')
    })

    it('trims the charter and leaves the prompt untouched when blank', () => {
        expect(augmentPanelCharter('Be harsh.', 'Panel', '  \n\t ')).toBe('Be harsh.')
        expect(augmentPanelCharter('Be harsh.', 'Panel', '')).toBe('Be harsh.')
        expect(augmentPanelCharter('Be harsh.', 'Panel', '  weigh  ')).toContain(
            '<panel-charter>\nweigh\n</panel-charter>'
        )
    })
})

// ---------------------------------------------------------------------------
// buildEditorPrompt — the one prompt-build entry point (plan §4d, M6)
// ---------------------------------------------------------------------------

describe('buildEditorPrompt', () => {
    const promptInput = (extra: Record<string, unknown>) => ({
        editor: makeEditor({ prompt: { text: 'Persona.', notePaths: [], followLinks: false } }),
        settings: makeSettings(),
        vault: new FakeVault(),
        notePath: 'Notes/Test.md',
        noteText: DOC_TEXT,
        ...extra
    })

    it('puts the charter after the persona and the instruction last', async () => {
        const built = await buildEditorPrompt(
            promptInput({
                panelCharter: { panelName: 'Pre-publish Review', text: 'Weigh the reader.' },
                instructionText: 'Focus on the opening.'
            })
        )

        const personaAt = built.systemPrompt.indexOf('Persona.')
        const charterAt = built.systemPrompt.indexOf('<panel-charter>')
        const instructionAt = built.systemPrompt.indexOf('<user-instruction>')
        expect(personaAt).toBeGreaterThanOrEqual(0)
        expect(charterAt).toBeGreaterThan(personaAt)
        expect(instructionAt).toBeGreaterThan(charterAt)
    })

    it('adds nothing for a member of a panel with a blank charter', async () => {
        const withCharter = await buildEditorPrompt(
            promptInput({ panelCharter: { panelName: 'Panel', text: '   ' } })
        )
        const solo = await buildEditorPrompt(promptInput({}))
        expect(withCharter.systemPrompt).toBe(solo.systemPrompt)
    })

    it('adds no language block by default', async () => {
        const built = await buildEditorPrompt(promptInput({}))
        expect(built.systemPrompt).not.toContain('<response-language>')
    })

    it('puts the configured response language last, after the instruction', async () => {
        const settings = makeSettings()
        const built = await buildEditorPrompt(
            promptInput({
                settings: {
                    ...settings,
                    behavior: { ...settings.behavior, responseLanguageOverride: 'French' }
                },
                panelCharter: { panelName: 'Pre-publish Review', text: 'Weigh the reader.' },
                instructionText: 'Focus on the opening.'
            })
        )
        const instructionAt = built.systemPrompt.indexOf('<user-instruction>')
        const languageAt = built.systemPrompt.indexOf('<response-language>')
        expect(languageAt).toBeGreaterThan(instructionAt)
        expect(built.systemPrompt).toContain('French')
    })
})

describe('augmentResponseLanguage', () => {
    it('is inert for an empty or blank value', () => {
        expect(augmentResponseLanguage('Be harsh.', '')).toBe('Be harsh.')
        expect(augmentResponseLanguage('Be harsh.', '  \n\t ')).toBe('Be harsh.')
    })

    it('delimits the value and keeps quotes in the document language', () => {
        const prompt = augmentResponseLanguage('Be harsh.', '  Nederlands  ')
        expect(prompt.startsWith('Be harsh.\n\n')).toBeTrue()
        expect(prompt).toContain('<response-language>\nNederlands\n</response-language>')
        expect(prompt).toContain('verbatim')
    })
})

// ---------------------------------------------------------------------------
// createEditorSpec (transport/protocol behavior is covered by
// backends/api-editor-backend.spec.ts — this seam binds identity + redaction)
// ---------------------------------------------------------------------------

describe('createEditorSpec', () => {
    it('binds editor identity and the key-redaction seam', () => {
        const spec = createEditorSpec({
            editor: makeEditor(),
            backend: makeBackend(),
            model: 'claude-test-1',
            systemPrompt: 'Be harsh.',
            behavior: makeSettings().behavior,
            fetchImpl: fetchReturning(anthropicReviewBody())
        })
        expect(spec.editorId).toBe('editor-1')
        expect(spec.editorName).toBe('Hater')
        expect(spec.redactError?.(`401 body echoing ${API_KEY}`)).toBe(
            '401 body echoing [redacted]'
        )
    })

    it('threads timeoutMs into the transport; expiry names the setting', async () => {
        // A fetch that never resolves until its signal aborts — the only way
        // the executor can terminate is the transport-level timeout.
        const hangingFetch = ((_url: string | URL, init?: RequestInit) =>
            new Promise<Response>((_resolve, reject) => {
                init?.signal?.addEventListener(
                    'abort',
                    () => {
                        reject(new DOMException('The operation was aborted.', 'AbortError'))
                    },
                    { once: true }
                )
            })) as unknown as typeof fetch
        const spec = createEditorSpec({
            editor: makeEditor(),
            backend: makeBackend(),
            model: 'claude-test-1',
            systemPrompt: 'Be harsh.',
            // Sub-second on purpose: the spec exercises the timeout path, not the
            // setting's UI range.
            behavior: { ...makeSettings().behavior, requestTimeoutSeconds: 0.02 },
            fetchImpl: hangingFetch
        })

        const events = []
        for await (const event of spec.execute(reviewOperation(), new AbortController().signal)) {
            events.push(event)
        }

        const terminal = events.at(-1)
        if (terminal?.type !== 'error') {
            throw new Error('expected a terminal error event')
        }
        expect(terminal.error.code).toBe('timeout')
        expect(terminal.error.message).toContain("raise 'Request timeout' in settings")
    })
})

// ---------------------------------------------------------------------------
// startReview
// ---------------------------------------------------------------------------

describe('startReview', () => {
    it('refuses an excluded target before anything else', async () => {
        const settings = makeSettings({
            behavior: { excludedFolders: ['Private'] }
        })
        const result = await startReview({
            settings,
            snapshot: makeSnapshot(DOC_TEXT, 'Private/Secret.md'),
            vault: new FakeVault(),
            runController: new RunController(),
            fetchImpl: fetchReturning(anthropicReviewBody())
        })
        expect(result).toEqual({ status: 'excluded', notePath: 'Private/Secret.md' })
    })

    describe('binding rules (plan §4b)', () => {
        const disableRule = {
            id: 'r1',
            name: 'No AI in daily notes',
            match: { matchType: 'tag', value: 'private' },
            effect: 'disabled'
        }

        it('refuses a kill-switched note BEFORE the size guard', async () => {
            const settings = makeSettings({
                rules: [disableRule],
                behavior: { sizeWarningWords: 100 }
            })
            const oversized = Array.from({ length: 101 }, (_, index) => `word${index}`).join(' ')
            const vault = new FakeVault()
            vault.metadata.set('Notes/Test.md', { tags: ['private'], frontmatter: {} })
            const result = await startReview({
                settings,
                snapshot: makeSnapshot(oversized),
                vault,
                runController: new RunController(),
                fetchImpl: fetchReturning(anthropicReviewBody())
            })
            expect(result).toEqual({
                status: 'rule-disabled',
                notePath: 'Notes/Test.md',
                ruleLabel: 'No AI in daily notes'
            })
        })

        it('narrows the default pool to the editor an assign rule names', async () => {
            const settings = makeSettings({
                editors: [makeEditor({ id: 'e-1', name: 'Chosen' }), makeEditor({ id: 'e-2' })],
                rules: [
                    {
                        id: 'r1',
                        match: { matchType: 'folder', value: 'Notes' },
                        effect: 'assign',
                        defaultTarget: { targetType: 'editor', targetId: 'e-1' }
                    }
                ]
            })
            const result = await startReview({
                settings,
                snapshot: makeSnapshot(),
                vault: new FakeVault(),
                runController: new RunController(),
                fetchImpl: fetchReturning(anthropicReviewBody())
            })
            if (result.status !== 'started') {
                throw new Error(`Expected started, got ${result.status}`)
            }
            expect(result.run.getEditorStates().map((state) => state.editorId)).toEqual(['e-1'])
        })

        it('expands a panel target to every member and reports disabled members', async () => {
            const settings = makeSettings({
                editors: [
                    makeEditor({ id: 'e-1', name: 'Member one' }),
                    makeEditor({ id: 'e-2', name: 'Member two', enabled: false }),
                    makeEditor({ id: 'e-3', name: 'Outsider' })
                ],
                panels: [{ id: 'p-1', name: 'Pre-publish', memberEditorIds: ['e-1', 'e-2'] }],
                rules: [
                    {
                        id: 'r1',
                        match: { matchType: 'folder', value: '/' },
                        effect: 'assign',
                        defaultTarget: { targetType: 'panel', targetId: 'p-1' }
                    }
                ]
            })
            const result = await startReview({
                settings,
                snapshot: makeSnapshot(),
                vault: new FakeVault(),
                runController: new RunController(),
                fetchImpl: fetchReturning(anthropicReviewBody())
            })
            if (result.status !== 'started') {
                throw new Error(`Expected started, got ${result.status}`)
            }
            expect(result.run.getEditorStates().map((state) => state.editorId)).toEqual(['e-1'])
            expect(result.skips).toEqual([
                { editorId: 'e-2', editorName: 'Member two', reason: 'editor-disabled' }
            ])
        })

        it('refuses a rule whose panel no longer exists instead of reviewing with everyone', async () => {
            const settings = makeSettings({
                rules: [
                    {
                        id: 'r1',
                        name: 'Blog panel',
                        match: { matchType: 'folder', value: '/' },
                        effect: 'assign',
                        defaultTarget: { targetType: 'panel', targetId: 'gone' }
                    }
                ]
            })
            const result = await startReview({
                settings,
                snapshot: makeSnapshot(),
                vault: new FakeVault(),
                runController: new RunController(),
                fetchImpl: fetchReturning(anthropicReviewBody())
            })
            expect(result).toEqual({
                status: 'no-editors',
                skips: [
                    { editorId: 'gone', editorName: 'Blog panel', reason: 'rule-target-missing' }
                ]
            })
        })

        it('refuses a rule whose EDITOR no longer exists, naming the rule', async () => {
            const settings = makeSettings({
                rules: [
                    {
                        id: 'r1',
                        name: 'Blog editor',
                        match: { matchType: 'folder', value: '/' },
                        effect: 'assign',
                        defaultTarget: { targetType: 'editor', targetId: 'gone' }
                    }
                ]
            })
            const result = await startReview({
                settings,
                snapshot: makeSnapshot(),
                vault: new FakeVault(),
                runController: new RunController(),
                fetchImpl: fetchReturning(anthropicReviewBody())
            })
            // Used to come back as an anonymous `editor-missing` against an id
            // nobody recognizes, with no mention of the rule that caused it.
            expect(result).toEqual({
                status: 'no-editors',
                skips: [
                    { editorId: 'gone', editorName: 'Blog editor', reason: 'rule-target-missing' }
                ]
            })
        })

        it('never lets a surface offer a review this note would refuse', async () => {
            // The invariant the gate exists for: whatever the rule assigns, the
            // gate and the dispatch agree. Anything else means an enabled
            // command, an enabled panel button, and an error Notice per click.
            const targets = [
                { targetType: 'editor' as const, targetId: 'gone' },
                { targetType: 'editor' as const, targetId: 'e-off' },
                { targetType: 'editor' as const, targetId: 'e-1' }
            ]
            for (const target of targets) {
                const settings = makeSettings({
                    editors: [
                        makeEditor({ id: 'e-1' }),
                        makeEditor({ id: 'e-off', name: 'Off', enabled: false })
                    ],
                    rules: [
                        {
                            id: 'r1',
                            name: 'Blog',
                            match: { matchType: 'folder', value: '/' },
                            effect: 'assign',
                            defaultTarget: target
                        }
                    ]
                })
                const vault = new FakeVault()
                const gate = reviewGate('Notes/Test.md', vault, settings)
                const result = await startReview({
                    settings,
                    snapshot: makeSnapshot(),
                    vault,
                    runController: new RunController(),
                    fetchImpl: fetchReturning(anthropicReviewBody())
                })
                expect(gate.status === 'ok').toBe(result.status === 'started')
                if (result.status === 'started') {
                    await result.run.settled
                }
            }
        })

        it('lets an explicit instruction win over an assign rule', async () => {
            const settings = makeSettings({
                editors: [makeEditor({ id: 'e-1' }), makeEditor({ id: 'e-2', name: 'Asked' })],
                rules: [
                    {
                        id: 'r1',
                        match: { matchType: 'folder', value: '/' },
                        effect: 'assign',
                        defaultTarget: { targetType: 'editor', targetId: 'e-1' }
                    }
                ]
            })
            const result = await startReview({
                settings,
                snapshot: makeSnapshot(),
                vault: new FakeVault(),
                runController: new RunController(),
                fetchImpl: fetchReturning(anthropicReviewBody()),
                instruction: { editorIds: ['e-2'], text: 'Focus on the opening' }
            })
            if (result.status !== 'started') {
                throw new Error(`Expected started, got ${result.status}`)
            }
            expect(result.run.getEditorStates().map((state) => state.editorId)).toEqual(['e-2'])
        })

        it('lets an explicit editorIds re-dispatch win over an assign rule, silently', async () => {
            const settings = makeSettings({
                editors: [
                    makeEditor({ id: 'e-1' }),
                    makeEditor({ id: 'e-2', name: 'Previous' }),
                    makeEditor({ id: 'e-3', name: 'Turned off', enabled: false })
                ],
                rules: [
                    {
                        id: 'r1',
                        match: { matchType: 'folder', value: '/' },
                        effect: 'assign',
                        defaultTarget: { targetType: 'editor', targetId: 'e-1' }
                    }
                ]
            })
            const result = await startReview({
                settings,
                snapshot: makeSnapshot(),
                vault: new FakeVault(),
                runController: new RunController(),
                fetchImpl: fetchReturning(anthropicReviewBody()),
                editorIds: ['e-2', 'e-3']
            })
            if (result.status !== 'started') {
                throw new Error(`Expected started, got ${result.status}`)
            }
            expect(result.run.getEditorStates().map((state) => state.editorId)).toEqual(['e-2'])
            expect(result.skips).toEqual([])
        })
    })

    it('requires confirmation above the size warning threshold', async () => {
        const settings = makeSettings({ behavior: { sizeWarningWords: 100 } })
        const bigText = Array.from({ length: 101 }, (_, i) => `word${i}`).join(' ')
        const input = {
            settings,
            snapshot: makeSnapshot(bigText),
            vault: new FakeVault(),
            runController: new RunController(),
            fetchImpl: fetchReturning(anthropicReviewBody())
        }
        const refused = await startReview(input)
        expect(refused).toEqual({ status: 'needs-confirmation', wordCount: 101, limit: 100 })

        const confirmed = await startReview({ ...input, confirmedLargeNote: true })
        expect(confirmed.status).toBe('started')
    })

    it('returns no-editors with a full skip report when nobody can run', async () => {
        const settings = makeSettings({
            editors: [
                makeEditor({ id: 'e-1', name: 'No capability', capabilities: { review: false } }),
                makeEditor({ id: 'e-2', name: 'No backend', backend: { backendId: 'ghost' } }),
                makeEditor({ id: 'e-3', name: 'Disabled editor', enabled: false })
            ],
            defaultBackend: null
        })
        const result = await startReview({
            settings,
            snapshot: makeSnapshot(),
            vault: new FakeVault(),
            runController: new RunController(),
            fetchImpl: fetchReturning(anthropicReviewBody())
        })
        if (result.status !== 'no-editors') {
            throw new Error(`Expected no-editors, got ${result.status}`)
        }
        expect(result.skips).toEqual([
            { editorId: 'e-1', editorName: 'No capability', reason: 'no-review-capability' },
            { editorId: 'e-2', editorName: 'No backend', reason: 'backend-not-found' }
        ])
    })

    it('runs the full pipeline: context, backend call, anchored findings', async () => {
        const settings = makeSettings()
        const runController = new RunController()
        const result = await startReview({
            settings,
            snapshot: makeSnapshot(),
            vault: new FakeVault(),
            runController,
            fetchImpl: fetchReturning(anthropicReviewBody())
        })
        if (result.status !== 'started') {
            throw new Error(`Expected started, got ${result.status}`)
        }
        expect(result.skips).toEqual([])
        await result.run.settled
        const state = result.run.getEditorState('editor-1')
        expect(state?.status).toBe('done')
        expect(state?.summary).toBe('Solid draft')
        const findings = result.run.findings.list()
        expect(findings).toHaveLength(1)
        expect(findings[0]?.anchor).toEqual({
            from: DOC_TEXT.indexOf('Hello world'),
            to: DOC_TEXT.indexOf('Hello world') + 'Hello world'.length,
            state: 'anchored'
        })
        expect(runController.getRun('Notes/Test.md')).toBe(result.run)
    })

    it('starts the run on the refreshed snapshot taken right before startRun', async () => {
        // Simulates the user typing while context assembly awaited vault
        // reads: the refreshed text has a prefix inserted before the quoted
        // passage, so anchors must land on the SHIFTED offsets.
        const editedText = `EDIT! ${DOC_TEXT}`
        const runController = new RunController()
        const result = await startReview({
            settings: makeSettings(),
            snapshot: makeSnapshot(),
            vault: new FakeVault(),
            runController,
            fetchImpl: fetchReturning(anthropicReviewBody()),
            refreshSnapshot: () => makeSnapshot(editedText)
        })
        if (result.status !== 'started') {
            throw new Error(`Expected started, got ${result.status}`)
        }
        expect(result.run.snapshot.text).toBe(editedText)
        await result.run.settled
        const findings = result.run.findings.list()
        expect(findings).toHaveLength(1)
        expect(findings[0]?.anchor).toEqual({
            from: editedText.indexOf('Hello world'),
            to: editedText.indexOf('Hello world') + 'Hello world'.length,
            state: 'anchored'
        })
    })

    it('falls back to the original snapshot when the refresh is null or foreign', async () => {
        const original = makeSnapshot()
        for (const refreshSnapshot of [
            (): null => null,
            (): ReturnType<typeof makeSnapshot> => makeSnapshot('other text', 'Notes/Other.md')
        ]) {
            const result = await startReview({
                settings: makeSettings(),
                snapshot: original,
                vault: new FakeVault(),
                runController: new RunController(),
                fetchImpl: fetchReturning(anthropicReviewBody()),
                refreshSnapshot
            })
            if (result.status !== 'started') {
                throw new Error(`Expected started, got ${result.status}`)
            }
            expect(result.run.snapshot).toBe(original)
            await result.run.settled
        }
    })

    it('reports skipped editors while running the usable ones', async () => {
        const settings = makeSettings({
            editors: [
                makeEditor(),
                makeEditor({ id: 'editor-2', name: 'Orphan', backend: { backendId: 'ghost' } })
            ]
        })
        const result = await startReview({
            settings,
            snapshot: makeSnapshot(),
            vault: new FakeVault(),
            runController: new RunController(),
            fetchImpl: fetchReturning(anthropicReviewBody())
        })
        if (result.status !== 'started') {
            throw new Error(`Expected started, got ${result.status}`)
        }
        expect(result.skips).toEqual([
            { editorId: 'editor-2', editorName: 'Orphan', reason: 'backend-not-found' }
        ])
        await result.run.settled
        expect(result.run.getEditorStates()).toHaveLength(1)
    })

    it('narrows an instruction run to the chosen editor with an augmented prompt', async () => {
        const captured: string[] = []
        const fetchImpl = ((url: string, init: { body: string }) => {
            captured.push(init.body)
            void url
            return Promise.resolve(new Response(anthropicReviewBody(), { status: 200 }))
        }) as unknown as typeof fetch
        const settings = makeSettings({
            editors: [
                makeEditor({ prompt: { text: 'Persona one.', notePaths: [] } }),
                makeEditor({
                    id: 'editor-2',
                    name: 'Mentor',
                    prompt: { text: 'Persona two.', notePaths: [] }
                })
            ]
        })
        const result = await startReview({
            settings,
            snapshot: makeSnapshot(),
            vault: new FakeVault(),
            runController: new RunController(),
            fetchImpl,
            instruction: { editorIds: ['editor-2'], text: 'Is this argument convincing?' }
        })
        if (result.status !== 'started') {
            throw new Error(`Expected started, got ${result.status}`)
        }
        // The un-asked editor is neither run nor reported as a skip.
        expect(result.skips).toEqual([])
        expect(result.run.getEditorStates().map((state) => state.editorId)).toEqual(['editor-2'])
        await result.run.settled
        expect(captured).toHaveLength(1)
        const body = captured[0] ?? ''
        expect(body).toContain('Persona two.')
        expect(body).toContain('Is this argument convincing?')
        expect(body).toContain('user-instruction')
        expect(body).not.toContain('Persona one.')
        // Findings still flow through the unchanged operation contract.
        expect(result.run.findings.list()).toHaveLength(1)
    })

    it('runs an instruction against every named editor with each prompt augmented (panel dispatch)', async () => {
        const captured: string[] = []
        const fetchImpl = ((url: string, init: { body: string }) => {
            captured.push(init.body)
            void url
            return Promise.resolve(new Response(anthropicReviewBody(), { status: 200 }))
        }) as unknown as typeof fetch
        const settings = makeSettings({
            editors: [
                makeEditor({ prompt: { text: 'Persona one.', notePaths: [] } }),
                makeEditor({
                    id: 'editor-2',
                    name: 'Mentor',
                    prompt: { text: 'Persona two.', notePaths: [] }
                }),
                makeEditor({
                    id: 'editor-3',
                    name: 'Bystander',
                    prompt: { text: 'Persona three.', notePaths: [] }
                })
            ]
        })
        const result = await startReview({
            settings,
            snapshot: makeSnapshot(),
            vault: new FakeVault(),
            runController: new RunController(),
            fetchImpl,
            instruction: { editorIds: ['editor-1', 'editor-2'], text: 'Check the argument.' }
        })
        if (result.status !== 'started') {
            throw new Error(`Expected started, got ${result.status}`)
        }
        // Editors outside the set are neither run nor reported as skips.
        expect(result.skips).toEqual([])
        expect(result.run.getEditorStates().map((state) => state.editorId)).toEqual([
            'editor-1',
            'editor-2'
        ])
        await result.run.settled
        expect(captured).toHaveLength(2)
        for (const body of captured) {
            expect(body).toContain('Check the argument.')
            expect(body).toContain('user-instruction')
            expect(body).not.toContain('Persona three.')
        }
    })

    it('returns no-editors when the instruction names an unknown or disabled editor', async () => {
        const settings = makeSettings({
            editors: [makeEditor(), makeEditor({ id: 'editor-2', name: 'Off', enabled: false })]
        })
        const cases = [
            {
                editorId: 'ghost',
                skip: { editorId: 'ghost', editorName: 'Unknown editor', reason: 'editor-missing' }
            },
            {
                editorId: 'editor-2',
                skip: { editorId: 'editor-2', editorName: 'Off', reason: 'editor-disabled' }
            }
        ] as const
        for (const { editorId, skip } of cases) {
            const result = await startReview({
                settings,
                snapshot: makeSnapshot(),
                vault: new FakeVault(),
                runController: new RunController(),
                fetchImpl: fetchReturning(anthropicReviewBody()),
                instruction: { editorIds: [editorId], text: 'focus' }
            })
            if (result.status !== 'no-editors') {
                throw new Error(`Expected no-editors, got ${result.status}`)
            }
            // Editors the instruction NAMES are candidates by definition:
            // the refusal says why each one could not run ("say why").
            expect(result.skips).toEqual([skip])
        }
    })

    it('reports disabled and deleted instruction members as skips while running the rest (panel dispatch)', async () => {
        const settings = makeSettings({
            editors: [
                makeEditor({ id: 'e-1', name: 'Runner' }),
                makeEditor({ id: 'e-2', name: 'Benched', enabled: false })
            ]
        })
        const result = await startReview({
            settings,
            snapshot: makeSnapshot(),
            vault: new FakeVault(),
            runController: new RunController(),
            fetchImpl: fetchReturning(anthropicReviewBody()),
            // A panel binding passes every member id — including one that
            // was disabled and one that was deleted after binding.
            instruction: { editorIds: ['e-1', 'e-2', 'e-gone'], text: 'Check it.' }
        })
        if (result.status !== 'started') {
            throw new Error(`Expected started, got ${result.status}`)
        }
        // The panel never silently shrinks: each undispatchable member is a
        // typed skip (the `ResolvedAction.editorIds` contract).
        expect(result.skips).toEqual([
            { editorId: 'e-gone', editorName: 'Unknown editor', reason: 'editor-missing' },
            { editorId: 'e-2', editorName: 'Benched', reason: 'editor-disabled' }
        ])
        expect(result.run.getEditorStates().map((state) => state.editorId)).toEqual(['e-1'])
        await result.run.settled
    })

    it('restricts the pool to the requested editorIds (daemon editor-set redispatch)', async () => {
        const settings = makeSettings({
            editors: [
                makeEditor({ id: 'e-1', name: 'One' }),
                makeEditor({ id: 'e-2', name: 'Two' }),
                makeEditor({ id: 'e-3', name: 'Broken', backend: { backendId: 'ghost' } })
            ]
        })
        const result = await startReview({
            settings,
            snapshot: makeSnapshot(),
            vault: new FakeVault(),
            runController: new RunController(),
            fetchImpl: fetchReturning(anthropicReviewBody()),
            editorIds: ['e-2', 'e-3']
        })
        if (result.status !== 'started') {
            throw new Error(`Expected started, got ${result.status}`)
        }
        // Outside the set: not a candidate — neither run nor a skip. Inside
        // the set but undispatchable: a reported skip like any review.
        expect(result.run.getEditorStates().map((state) => state.editorId)).toEqual(['e-2'])
        expect(result.skips).toEqual([
            { editorId: 'e-3', editorName: 'Broken', reason: 'backend-not-found' }
        ])
        await result.run.settled
    })

    it('returns no-editors when the requested editorIds cannot dispatch', async () => {
        const settings = makeSettings({
            editors: [makeEditor(), makeEditor({ id: 'e-2', name: 'Off', enabled: false })]
        })
        for (const editorIds of [['ghost'], ['e-2'], []]) {
            const result = await startReview({
                settings,
                snapshot: makeSnapshot(),
                vault: new FakeVault(),
                runController: new RunController(),
                fetchImpl: fetchReturning(anthropicReviewBody()),
                editorIds
            })
            expect(result.status).toBe('no-editors')
        }
    })

    it('aborts without starting a run when abortWhen fires (daemon vs user summon)', async () => {
        // The guard runs in the same synchronous block as startRun: a user
        // run that appeared during the context-assembly awaits must win —
        // startRun would cancel it otherwise.
        const runController = new RunController()
        const settings = makeSettings()
        const userRun = runController.startRun({ snapshot: makeSnapshot(), editors: [] })
        const result = await startReview({
            settings,
            snapshot: makeSnapshot(),
            vault: new FakeVault(),
            runController,
            fetchImpl: fetchReturning(anthropicReviewBody()),
            abortWhen: () => true
        })
        expect(result).toEqual({ status: 'aborted' })
        // The pre-existing run was neither cancelled nor replaced.
        expect(runController.getRun('Notes/Test.md')).toBe(userRun)
    })

    it('proceeds normally when abortWhen stays false', async () => {
        const result = await startReview({
            settings: makeSettings(),
            snapshot: makeSnapshot(),
            vault: new FakeVault(),
            runController: new RunController(),
            fetchImpl: fetchReturning(anthropicReviewBody()),
            abortWhen: () => false
        })
        expect(result.status).toBe('started')
    })

    it('excludes attached context notes without failing the run', async () => {
        const vault = new FakeVault()
        vault.notes.set('Voice.md', 'Voice rules here')
        vault.notes.set('Private/Persona.md', 'secret persona')
        vault.metadata.set('Private/Persona.md', { tags: ['private'], frontmatter: {} })
        const captured: string[] = []
        const fetchImpl = ((url: string, init: { body: string }) => {
            captured.push(init.body)
            void url
            return Promise.resolve(new Response(anthropicReviewBody(), { status: 200 }))
        }) as unknown as typeof fetch
        const settings = makeSettings({
            voiceProfile: { text: 'Sound like me.', notePaths: ['Voice.md'] },
            editors: [
                makeEditor({ prompt: { text: 'Be harsh.', notePaths: ['Private/Persona.md'] } })
            ],
            behavior: { excludedTags: ['private'] }
        })
        const result = await startReview({
            settings,
            snapshot: makeSnapshot(),
            vault,
            runController: new RunController(),
            fetchImpl
        })
        expect(result.status).toBe('started')
        if (result.status === 'started') {
            await result.run.settled
        }
        const body = captured[0] ?? ''
        expect(body).toContain('Voice rules here')
        expect(body).not.toContain('secret persona')
    })

    it('maps HTTP auth failures to typed errors without leaking the key', async () => {
        const fetchImpl = fetchReturning(`{"error":"bad key ${API_KEY}"}`, 401)
        const result = await startReview({
            settings: makeSettings(),
            snapshot: makeSnapshot(),
            vault: new FakeVault(),
            runController: new RunController(),
            fetchImpl
        })
        if (result.status !== 'started') {
            throw new Error(`Expected started, got ${result.status}`)
        }
        await result.run.settled
        const state = result.run.getEditorState('editor-1')
        expect(state?.status).toBe('error')
        expect(state?.error?.code).toBe('auth')
        expect(state?.error?.message ?? '').not.toContain(API_KEY)
    })

    it('surfaces invalid backend configuration without touching the network', async () => {
        let fetchCalls = 0
        const fetchImpl = ((): Promise<Response> => {
            fetchCalls += 1
            return Promise.resolve(new Response(anthropicReviewBody(), { status: 200 }))
        }) as unknown as typeof fetch
        const result = await startReview({
            settings: makeSettings({ backends: [makeBackend({ apiKey: '' })] }),
            snapshot: makeSnapshot(),
            vault: new FakeVault(),
            runController: new RunController(),
            fetchImpl
        })
        if (result.status !== 'started') {
            throw new Error(`Expected started, got ${result.status}`)
        }
        await result.run.settled
        const state = result.run.getEditorState('editor-1')
        expect(state?.status).toBe('error')
        expect(state?.error?.code).toBe('unknown')
        expect(state?.error?.message).toContain('no API key')
        expect(fetchCalls).toBe(0)
    })

    it('cancelling the run aborts the in-flight request', async () => {
        let sawAbort = false
        const fetchImpl = ((url: string, init: { signal: AbortSignal }) => {
            void url
            return new Promise<Response>((_, reject) => {
                const onAbort = (): void => {
                    sawAbort = true
                    reject(new DOMException('aborted', 'AbortError'))
                }
                if (init.signal.aborted) {
                    onAbort()
                } else {
                    init.signal.addEventListener('abort', onAbort)
                }
            })
        }) as unknown as typeof fetch
        const result = await startReview({
            settings: makeSettings(),
            snapshot: makeSnapshot(),
            vault: new FakeVault(),
            runController: new RunController(),
            fetchImpl
        })
        if (result.status !== 'started') {
            throw new Error(`Expected started, got ${result.status}`)
        }
        result.run.cancelRun()
        await result.run.settled
        expect(sawAbort).toBe(true)
        expect(result.run.getEditorState('editor-1')?.status).toBe('cancelled')
    })

    // -- Selection scope (requestedSelection contract) -----------------------

    it('scopes the run to a valid requested selection', async () => {
        const result = await startReview({
            settings: makeSettings(),
            snapshot: makeSnapshot(),
            vault: new FakeVault(),
            runController: new RunController(),
            fetchImpl: fetchReturning(anthropicReviewBody()),
            requestedSelection: { from: 0, to: 11, capturedHash: hashText(DOC_TEXT) }
        })
        if (result.status !== 'started') {
            throw new Error(`Expected started, got ${result.status}`)
        }
        expect(result.selectionFallback).toBe(false)
        expect(result.run.snapshot.selection).toEqual({ from: 0, to: 11 })
        await result.run.settled
    })

    it('applies the requested selection to an unchanged refreshed snapshot', async () => {
        // The refresh recaptured the same text (hash equal) but a DIFFERENT
        // live selection — the synchronously captured range must win.
        const result = await startReview({
            settings: makeSettings(),
            snapshot: makeSnapshot(),
            vault: new FakeVault(),
            runController: new RunController(),
            fetchImpl: fetchReturning(anthropicReviewBody()),
            refreshSnapshot: () =>
                createSnapshot({
                    filePath: 'Notes/Test.md',
                    text: DOC_TEXT,
                    selection: { from: 3, to: 7 }
                }),
            requestedSelection: { from: 0, to: 11, capturedHash: hashText(DOC_TEXT) }
        })
        if (result.status !== 'started') {
            throw new Error(`Expected started, got ${result.status}`)
        }
        expect(result.selectionFallback).toBe(false)
        expect(result.run.snapshot.selection).toEqual({ from: 0, to: 11 })
        await result.run.settled
    })

    it('falls back to whole-note scope when the requested selection is out of bounds', async () => {
        const result = await startReview({
            settings: makeSettings(),
            snapshot: makeSnapshot(),
            vault: new FakeVault(),
            runController: new RunController(),
            fetchImpl: fetchReturning(anthropicReviewBody()),
            requestedSelection: {
                from: 0,
                to: DOC_TEXT.length + 50,
                capturedHash: hashText(DOC_TEXT)
            }
        })
        if (result.status !== 'started') {
            throw new Error(`Expected started, got ${result.status}`)
        }
        expect(result.selectionFallback).toBe(true)
        expect(result.run.snapshot.selection).toBeUndefined()
        await result.run.settled
    })

    it('falls back to whole-note scope on a degenerate (empty) requested selection', async () => {
        const result = await startReview({
            settings: makeSettings(),
            snapshot: makeSnapshot(),
            vault: new FakeVault(),
            runController: new RunController(),
            fetchImpl: fetchReturning(anthropicReviewBody()),
            requestedSelection: { from: 5, to: 5, capturedHash: hashText(DOC_TEXT) }
        })
        if (result.status !== 'started') {
            throw new Error(`Expected started, got ${result.status}`)
        }
        expect(result.selectionFallback).toBe(true)
        expect(result.run.snapshot.selection).toBeUndefined()
        await result.run.settled
    })

    it('falls back when the document changed between capture and run start', async () => {
        // Bounds still fit the edited text, but the hash mismatch proves the
        // offsets refer to stale content — whole note, stale live selection
        // stripped, and the run opens on the FRESH text.
        const editedText = `EDIT! ${DOC_TEXT}`
        const result = await startReview({
            settings: makeSettings(),
            snapshot: makeSnapshot(),
            vault: new FakeVault(),
            runController: new RunController(),
            fetchImpl: fetchReturning(anthropicReviewBody()),
            refreshSnapshot: () =>
                createSnapshot({
                    filePath: 'Notes/Test.md',
                    text: editedText,
                    selection: { from: 2, to: 8 }
                }),
            requestedSelection: { from: 0, to: 11, capturedHash: hashText(DOC_TEXT) }
        })
        if (result.status !== 'started') {
            throw new Error(`Expected started, got ${result.status}`)
        }
        expect(result.selectionFallback).toBe(true)
        expect(result.run.snapshot.selection).toBeUndefined()
        expect(result.run.snapshot.text).toBe(editedText)
        await result.run.settled
    })

    it('falls back across a size-confirmation round trip when the note was edited meanwhile', async () => {
        // Round-trip shape: the selection was captured against the ORIGINAL
        // text, the size modal delayed the run, the user edited, and the
        // caller re-snapshots AFTER the modal — so the input snapshot is
        // already the post-edit text. Validating against `snapshot.hash`
        // would compare the fresh hash with itself and pass; only the carried
        // `capturedHash` proves the offsets are stale (bounds still fit).
        const originalText = `${DOC_TEXT} tail`
        const postEditSnapshot = createSnapshot({ filePath: 'Notes/Test.md', text: DOC_TEXT })
        const result = await startReview({
            settings: makeSettings(),
            snapshot: postEditSnapshot,
            vault: new FakeVault(),
            runController: new RunController(),
            fetchImpl: fetchReturning(anthropicReviewBody()),
            requestedSelection: { from: 0, to: 11, capturedHash: hashText(originalText) }
        })
        if (result.status !== 'started') {
            throw new Error(`Expected started, got ${result.status}`)
        }
        expect(result.selectionFallback).toBe(true)
        expect(result.run.snapshot.selection).toBeUndefined()
        await result.run.settled
    })

    it('keeps the legacy snapshot-carried selection when none is requested', async () => {
        const snapshot = createSnapshot({
            filePath: 'Notes/Test.md',
            text: DOC_TEXT,
            selection: { from: 0, to: 5 }
        })
        const result = await startReview({
            settings: makeSettings(),
            snapshot,
            vault: new FakeVault(),
            runController: new RunController(),
            fetchImpl: fetchReturning(anthropicReviewBody())
        })
        if (result.status !== 'started') {
            throw new Error(`Expected started, got ${result.status}`)
        }
        expect(result.selectionFallback).toBe(false)
        expect(result.run.snapshot).toBe(snapshot)
        expect(result.run.snapshot.selection).toEqual({ from: 0, to: 5 })
        await result.run.settled
    })
})

// ---------------------------------------------------------------------------
// Panel runs (plan M6): one run, the charter on every member, one scorecard
// ---------------------------------------------------------------------------

/** Anthropic-shaped SSE stream carrying a valid panel scorecard. */
function anthropicPanelBody(): string {
    const resultInput = {
        kind: 'aggregate-panel',
        recommendation: 'needs-work',
        memberVerdicts: [{ editorName: 'Member one', verdict: 'needs-work' }],
        topFixes: [{ action: 'Tighten the opening' }],
        missingMembers: []
    }
    const frames = [
        {
            type: 'content_block_start',
            index: 0,
            content_block: { type: 'tool_use', name: 'emit_result', input: {} }
        },
        {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'input_json_delta', partial_json: JSON.stringify(resultInput) }
        },
        { type: 'message_stop' }
    ]
    return frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join('')
}

/**
 * Records every outbound request body and answers each one with the payload
 * matching the operation it carries (review vs aggregation).
 */
function recordingFetch(bodies: string[]): typeof fetch {
    return ((_url: string, init?: RequestInit) => {
        const body = typeof init?.body === 'string' ? init.body : ''
        bodies.push(body)
        return Promise.resolve(
            new Response(
                body.includes('aggregate-panel') ? anthropicPanelBody() : anthropicReviewBody(),
                { status: 200 }
            )
        )
    }) as unknown as typeof fetch
}

describe('startReview panel runs', () => {
    const CHARTER = 'Weigh the reader above the prose.'

    function panelSettings(overrides: Record<string, unknown> = {}): PluginSettingsV1 {
        return makeSettings({
            editors: [
                makeEditor({ id: 'e-1', name: 'Member one' }),
                makeEditor({ id: 'e-2', name: 'Member two' }),
                makeEditor({ id: 'e-3', name: 'Outsider' })
            ],
            panels: [
                {
                    id: 'p-1',
                    name: 'Pre-publish Review',
                    memberEditorIds: ['e-1', 'e-2'],
                    charter: { text: CHARTER, notePaths: [] }
                }
            ],
            ...overrides
        })
    }

    it('runs only the members, briefs every one of them with the charter', async () => {
        const bodies: string[] = []
        const result = await startReview({
            settings: panelSettings(),
            snapshot: makeSnapshot(),
            vault: new FakeVault(),
            runController: new RunController(),
            fetchImpl: recordingFetch(bodies),
            panel: { panelId: 'p-1' }
        })

        if (result.status !== 'started') {
            throw new Error(`Expected started, got ${result.status}`)
        }
        expect(result.run.getEditorStates().map((state) => state.editorId)).toEqual(['e-1', 'e-2'])
        await result.run.settled

        const memberRequests = bodies.filter((body) => !body.includes('aggregate-panel'))
        expect(memberRequests).toHaveLength(2)
        // Every member carries the charter, and it names the panel it serves.
        for (const body of memberRequests) {
            expect(body).toContain(CHARTER)
            expect(body).toContain('Pre-publish Review')
        }
    })

    it('is a first-class panel run, and aggregates once the members settle', async () => {
        const bodies: string[] = []
        const result = await startReview({
            settings: panelSettings(),
            snapshot: makeSnapshot(),
            vault: new FakeVault(),
            runController: new RunController(),
            fetchImpl: recordingFetch(bodies),
            panel: { panelId: 'p-1' }
        })

        if (result.status !== 'started') {
            throw new Error(`Expected started, got ${result.status}`)
        }
        expect(result.run.getPanelState()?.panelName).toBe('Pre-publish Review')
        await result.run.panelSettled

        const state = result.run.getPanelState()
        expect(state?.status).toBe('done')
        expect(state?.result?.recommendation).toBe('needs-work')
        // The charter is the chairperson's system prompt too — one field, both
        // roles (see services/panels/panel-charter.ts).
        const aggregation = bodies.find((body) => body.includes('aggregate-panel'))
        expect(aggregation).toBeDefined()
        expect(aggregation).toContain(CHARTER)
        // Findings keep their per-member identity — a panel does not merge them.
        expect([...new Set(result.run.findings.list().map((f) => f.editorId))].sort()).toEqual([
            'e-1',
            'e-2'
        ])
    })

    it('makes an enabled panel assigned by a binding rule a panel run', async () => {
        const settings = panelSettings({
            rules: [
                {
                    id: 'r1',
                    match: { matchType: 'folder', value: '/' },
                    effect: 'assign',
                    defaultTarget: { targetType: 'panel', targetId: 'p-1' }
                }
            ]
        })
        const bodies: string[] = []
        const result = await startReview({
            settings,
            snapshot: makeSnapshot(),
            vault: new FakeVault(),
            runController: new RunController(),
            fetchImpl: recordingFetch(bodies)
        })

        if (result.status !== 'started') {
            throw new Error(`Expected started, got ${result.status}`)
        }
        expect(result.run.getPanelState()?.panelId).toBe('p-1')
        await result.run.panelSettled
        expect(result.run.getPanelState()?.status).toBe('done')
    })

    it('runs a rule-assigned DISABLED panel as loose editors, with no scorecard', async () => {
        const settings = makeSettings({
            editors: [makeEditor({ id: 'e-1' }), makeEditor({ id: 'e-2' })],
            panels: [
                {
                    id: 'p-1',
                    name: 'Off',
                    memberEditorIds: ['e-1', 'e-2'],
                    charter: { text: CHARTER, notePaths: [] },
                    enabled: false
                }
            ],
            rules: [
                {
                    id: 'r1',
                    match: { matchType: 'folder', value: '/' },
                    effect: 'assign',
                    defaultTarget: { targetType: 'panel', targetId: 'p-1' }
                }
            ]
        })
        const bodies: string[] = []
        const result = await startReview({
            settings,
            snapshot: makeSnapshot(),
            vault: new FakeVault(),
            runController: new RunController(),
            fetchImpl: recordingFetch(bodies)
        })

        if (result.status !== 'started') {
            throw new Error(`Expected started, got ${result.status}`)
        }
        // The members still review — the flag drops the aggregation identity.
        expect(result.run.getEditorStates()).toHaveLength(2)
        expect(result.run.getPanelState()).toBeNull()
        await result.run.settled
        expect(bodies.some((body) => body.includes(CHARTER))).toBeFalse()
    })

    it('refuses a requested panel that is gone or disabled, naming the panel', async () => {
        const base = {
            snapshot: makeSnapshot(),
            vault: new FakeVault(),
            runController: new RunController(),
            fetchImpl: fetchReturning(anthropicReviewBody())
        }
        expect(
            await startReview({ ...base, settings: panelSettings(), panel: { panelId: 'gone' } })
        ).toEqual({ status: 'panel-unavailable', panelId: 'gone', reason: 'panel-missing' })

        const disabled = makeSettings({
            editors: [makeEditor({ id: 'e-1' })],
            panels: [{ id: 'p-1', name: 'Off', memberEditorIds: ['e-1'], enabled: false }]
        })
        expect(
            await startReview({ ...base, settings: disabled, panel: { panelId: 'p-1' } })
        ).toEqual({ status: 'panel-unavailable', panelId: 'p-1', reason: 'panel-disabled' })
    })

    it('refuses an unavailable panel before the size guard can ask for confirmation', async () => {
        // Same ordering rule as the rule kill switch: a run that is going to
        // be refused outright must not pop a confirmation dialog on its way.
        const bigText = Array.from({ length: 101 }, (_, i) => `word${i}`).join(' ')
        expect(
            await startReview({
                settings: panelSettings({ behavior: { sizeWarningWords: 100 } }),
                snapshot: makeSnapshot(bigText),
                vault: new FakeVault(),
                runController: new RunController(),
                fetchImpl: fetchReturning(anthropicReviewBody()),
                panel: { panelId: 'gone' }
            })
        ).toEqual({ status: 'panel-unavailable', panelId: 'gone', reason: 'panel-missing' })
    })

    it('still runs the panel when its aggregation backend cannot resolve', async () => {
        const settings = panelSettings({
            panels: [
                {
                    id: 'p-1',
                    name: 'Pre-publish Review',
                    memberEditorIds: ['e-1', 'e-2'],
                    charter: { text: CHARTER, notePaths: [] },
                    aggregationBackend: { backendId: 'gone', model: '' }
                }
            ]
        })
        const bodies: string[] = []
        const result = await startReview({
            settings,
            snapshot: makeSnapshot(),
            vault: new FakeVault(),
            runController: new RunController(),
            fetchImpl: recordingFetch(bodies),
            panel: { panelId: 'p-1' }
        })

        if (result.status !== 'started') {
            throw new Error(`Expected started, got ${result.status}`)
        }
        await result.run.panelSettled
        // The members' reviews are the bulk of the value: a misconfigured
        // scorecard backend must not throw them away.
        expect(result.run.getEditorStates()).toHaveLength(2)
        expect(result.run.getPanelState()?.status).toBe('unavailable')
        expect(bodies.some((body) => body.includes('aggregate-panel'))).toBeFalse()
    })

    it('completes with the survivors when a member fails, naming the missing one', async () => {
        const settings = panelSettings()
        const bodies: string[] = []
        // The second member's backend answers 401; the first succeeds.
        let memberCalls = 0
        const fetchImpl = ((_url: string, init?: RequestInit) => {
            const body = typeof init?.body === 'string' ? init.body : ''
            bodies.push(body)
            if (body.includes('aggregate-panel')) {
                return Promise.resolve(new Response(anthropicPanelBody(), { status: 200 }))
            }
            memberCalls += 1
            return Promise.resolve(
                memberCalls === 1
                    ? new Response(anthropicReviewBody(), { status: 200 })
                    : new Response('nope', { status: 401 })
            )
        }) as unknown as typeof fetch

        const result = await startReview({
            settings,
            snapshot: makeSnapshot(),
            vault: new FakeVault(),
            runController: new RunController(() => 1),
            fetchImpl,
            panel: { panelId: 'p-1' }
        })

        if (result.status !== 'started') {
            throw new Error(`Expected started, got ${result.status}`)
        }
        await result.run.panelSettled

        expect(result.run.getPanelState()?.status).toBe('done')
        expect(result.run.getPanelState()?.missingMembers).toEqual(['Member two'])
        // The failed member is still there, still retryable inside the run.
        expect(result.run.getEditorState('e-2')?.status).toBe('error')
    })
})

describe('startReview — one view of the vault per run', () => {
    /** Counts every question the run asks the vault. */
    class CountingVault implements VaultReader {
        reads = 0
        metadataReads = 0
        outgoingReads = 0
        readonly notes = new Map<string, string>()
        readonly links = new Map<string, string[]>()

        readNote(path: string): Promise<string | null> {
            this.reads += 1
            return Promise.resolve(this.notes.get(path) ?? null)
        }

        resolveLink(): string | null {
            return null
        }

        getOutgoingLinks(path: string): string[] {
            this.outgoingReads += 1
            return this.links.get(path) ?? []
        }

        getNoteMetadata(): NoteMetadata | null {
            this.metadataReads += 1
            return { tags: [], frontmatter: {} }
        }

        getNoteTypeIds(): readonly string[] {
            return []
        }
    }

    it('reads each linked note ONCE however many editors attach it', async () => {
        const vault = new CountingVault()
        vault.links.set('Notes/Test.md', ['Refs/One.md', 'Refs/Two.md'])
        vault.notes.set('Refs/One.md', 'one')
        vault.notes.set('Refs/Two.md', 'two')
        const settings = makeSettings({
            editors: [
                makeEditor({ id: 'e-1', includeLinkedNotes: true }),
                makeEditor({ id: 'e-2', includeLinkedNotes: true }),
                makeEditor({ id: 'e-3', includeLinkedNotes: true }),
                makeEditor({ id: 'e-4', includeLinkedNotes: true })
            ]
        })
        const result = await startReview({
            settings,
            snapshot: makeSnapshot(),
            vault,
            runController: new RunController(),
            fetchImpl: fetchReturning(anthropicReviewBody())
        })
        if (result.status !== 'started') {
            throw new Error(`Expected started, got ${result.status}`)
        }
        // Four editors, two linked notes each: two reads, not eight.
        expect(vault.reads).toBe(2)
        expect(vault.outgoingReads).toBe(1)
    })

    it('still attaches the linked notes to EVERY editor', async () => {
        // The cache must not be observable in the output — a run that read
        // less and sent less would be a bug wearing a benchmark's clothes.
        const vault = new CountingVault()
        vault.links.set('Notes/Test.md', ['Refs/One.md'])
        vault.notes.set('Refs/One.md', 'REFERENCE CONTENT')
        const settings = makeSettings({
            editors: [
                makeEditor({ id: 'e-1', includeLinkedNotes: true }),
                makeEditor({ id: 'e-2', includeLinkedNotes: true })
            ]
        })
        const bodies: string[] = []
        const result = await startReview({
            settings,
            snapshot: makeSnapshot(),
            vault,
            runController: new RunController(),
            fetchImpl: ((input: RequestInfo | URL, init?: RequestInit) => {
                const body = init?.body
                bodies.push(typeof body === 'string' ? body : '')
                return fetchReturning(anthropicReviewBody())(input, init)
            }) as typeof fetch
        })
        if (result.status !== 'started') {
            throw new Error(`Expected started, got ${result.status}`)
        }
        await result.run.settled
        expect(bodies).toHaveLength(2)
        for (const body of bodies) {
            expect(body).toContain('REFERENCE CONTENT')
        }
    })
})
