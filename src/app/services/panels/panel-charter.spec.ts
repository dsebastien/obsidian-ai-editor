import { describe, expect, it } from 'bun:test'
import {
    behaviorSettingsSchema,
    panelConfigSchema,
    type BehaviorSettings,
    type PanelConfig
} from '../../domain/settings/settings-schema'
import type { NoteMetadata, VaultReader } from '../context/vault-reader.intf'
import { PANEL_CHARTER_MAX_CHARS, resolvePanelCharter } from './panel-charter'

class FakeVault implements VaultReader {
    readonly notes = new Map<string, string>()
    readonly metadata = new Map<string, NoteMetadata>()
    readonly links = new Map<string, readonly string[]>()
    readonly reads: string[] = []

    async readNote(path: string): Promise<string | null> {
        this.reads.push(path)
        return this.notes.get(path) ?? null
    }

    resolveLink(): string | null {
        return null
    }

    getOutgoingLinks(path: string): string[] {
        return [...(this.links.get(path) ?? [])]
    }

    getNoteMetadata(path: string): NoteMetadata | null {
        return this.metadata.get(path) ?? { tags: [], frontmatter: {} }
    }

    getNoteTypeIds(): readonly string[] {
        return []
    }
}

function makePanel(charter: Record<string, unknown>): PanelConfig {
    return panelConfigSchema.parse({
        id: 'panel-1',
        name: 'Pre-publish Review',
        memberEditorIds: ['editor-1'],
        charter
    })
}

function behavior(overrides: Record<string, unknown> = {}): BehaviorSettings {
    return behaviorSettingsSchema.parse(overrides)
}

describe('resolvePanelCharter', () => {
    it('returns the direct text as-is when no note is referenced', async () => {
        const panel = makePanel({ text: '  Weigh the reader first.  ', notePaths: [] })
        expect(await resolvePanelCharter(panel, new FakeVault(), behavior())).toBe(
            'Weigh the reader first.'
        )
    })

    it('is empty for a blank charter — a panel without a shared brief is valid', async () => {
        const panel = makePanel({ text: '   ', notePaths: [] })
        expect(await resolvePanelCharter(panel, new FakeVault(), behavior())).toBe('')
    })

    it('inlines referenced notes as charter blocks, after the direct text', async () => {
        const vault = new FakeVault()
        vault.notes.set('Panels/Brief.md', 'Publish bar: no embarrassment.')
        const panel = makePanel({ text: 'Direct brief.', notePaths: ['Panels/Brief.md'] })

        const resolved = await resolvePanelCharter(panel, vault, behavior())

        expect(resolved).toBe(
            'Direct brief.\n\n<charter-note path="Panels/Brief.md">\nPublish bar: no embarrassment.\n</charter-note>'
        )
    })

    it('never reads an excluded charter note (Business Rules #7)', async () => {
        const vault = new FakeVault()
        vault.notes.set('Private/Brief.md', 'secret')
        const panel = makePanel({ text: '', notePaths: ['Private/Brief.md'] })

        const resolved = await resolvePanelCharter(
            panel,
            vault,
            behavior({ excludedFolders: ['Private'] })
        )

        expect(resolved).toBe('')
        expect(vault.reads).toEqual([])
    })

    it('follows links one hop when the charter opts in, skipping excluded targets', async () => {
        const vault = new FakeVault()
        vault.notes.set('Panels/Brief.md', 'Brief')
        vault.notes.set('Panels/Detail.md', 'Detail')
        vault.notes.set('Private/Leak.md', 'Leak')
        vault.links.set('Panels/Brief.md', ['Panels/Detail.md', 'Private/Leak.md'])
        const panel = makePanel({ text: '', notePaths: ['Panels/Brief.md'], followLinks: true })

        const resolved = await resolvePanelCharter(
            panel,
            vault,
            behavior({ excludedFolders: ['Private'] })
        )

        expect(resolved).toContain('path="Panels/Brief.md"')
        expect(resolved).toContain('path="Panels/Detail.md"')
        expect(resolved).not.toContain('Leak')
        expect(vault.reads).toEqual(['Panels/Brief.md', 'Panels/Detail.md'])
    })

    it('truncates to the cap, keeping the direct brief intact', async () => {
        const vault = new FakeVault()
        vault.notes.set('Panels/Long.md', 'x'.repeat(PANEL_CHARTER_MAX_CHARS * 2))
        const panel = makePanel({ text: 'Keep me.', notePaths: ['Panels/Long.md'] })

        const resolved = await resolvePanelCharter(panel, vault, behavior())

        expect(resolved.length).toBe(PANEL_CHARTER_MAX_CHARS)
        expect(resolved.startsWith('Keep me.')).toBeTrue()
    })
})
