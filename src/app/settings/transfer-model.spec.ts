import { describe, expect, it } from 'bun:test'
import { pluginSettingsSchema } from '../domain/settings/settings-schema'
import {
    ALL_SECTIONS,
    TRANSFER_SECTIONS,
    exportCounts,
    planImport
} from '../domain/settings/settings-transfer'
import type {
    ImportAdjustment,
    ImportError,
    ImportRejection,
    SettingsImportPlan
} from '../domain/settings/settings-transfer'
import {
    DEFAULT_EXPORT_PATH,
    adjustmentLine,
    exportSummaryLine,
    hasSelection,
    importErrorMessage,
    importSummaryLines,
    normalizeExportPath,
    rejectionLine,
    sectionTitle
} from './transfer-model'

const planOf = (raw: unknown): SettingsImportPlan => {
    const result = planImport(raw, pluginSettingsSchema.parse({}))
    if (!result.ok) {
        throw new Error(`Expected a plan, got ${result.error}`)
    }
    return result.plan
}

describe('normalizeExportPath', () => {
    it('appends .json, trims, and drops a leading slash', () => {
        expect(normalizeExportPath('  Backups/settings ')).toEqual('Backups/settings.json')
        expect(normalizeExportPath('/Backups/settings.json')).toEqual('Backups/settings.json')
        expect(normalizeExportPath('settings.JSON')).toEqual('settings.JSON')
    })

    it('falls back to the default name for empty or folder-only input', () => {
        expect(normalizeExportPath('   ')).toEqual(DEFAULT_EXPORT_PATH)
        expect(normalizeExportPath('/')).toEqual(DEFAULT_EXPORT_PATH)
        expect(normalizeExportPath('Backups/')).toEqual(`Backups/${DEFAULT_EXPORT_PATH}`)
    })
})

describe('export copy', () => {
    it('names every section', () => {
        for (const section of TRANSFER_SECTIONS) {
            expect(sectionTitle(section).length).toBeGreaterThan(0)
        }
    })

    it('says what will be exported, and says when nothing is selected', () => {
        const settings = pluginSettingsSchema.parse({
            editors: [{ id: 'e1', name: 'One' }],
            panels: [{ id: 'p1', name: 'Panel', memberEditorIds: ['e1'] }]
        })
        const none = { ...ALL_SECTIONS }
        for (const section of TRANSFER_SECTIONS) {
            none[section] = false
        }
        expect(hasSelection(none)).toBe(false)
        expect(exportSummaryLine(exportCounts(settings, none))).toEqual('Nothing selected.')

        const selection = { ...none, editors: true, panels: true }
        expect(hasSelection(selection)).toBe(true)
        expect(exportSummaryLine(exportCounts(settings, selection))).toEqual(
            'Will export: 1 editor, 1 panel.'
        )
    })
})

describe('importSummaryLines', () => {
    it('leads with the additions', () => {
        const plan = planOf({
            editors: [
                { id: 'e1', name: 'One' },
                { id: 'e2', name: 'Two' }
            ],
            panels: [{ id: 'p1', name: 'Panel', memberEditorIds: ['e1'] }]
        })
        expect(importSummaryLines(plan)[0]).toEqual('Will be added: 2 editors, 1 panel.')
    })

    it('states the voice-profile replacement separately from the additions', () => {
        const lines = importSummaryLines(planOf({ voiceProfile: { text: 'New.' } }))
        expect(lines).toEqual(['Your voice profile will be REPLACED by the imported one.'])
    })

    it('says when nothing would be added, and counts skipped entries', () => {
        expect(importSummaryLines(planOf({ editors: [] }))).toEqual(['Nothing would be added.'])
        const withSkips = importSummaryLines(planOf({ editors: [{ id: 'e1' }] }))
        expect(withSkips).toEqual(['Nothing would be added.', '1 entry will be skipped.'])
    })
})

describe('rejection and adjustment lines', () => {
    it('has a line for every reject reason, naming the entry when it can', () => {
        const reasons: ImportRejection['reason'][] = [
            'invalid',
            'no-member-editor',
            'already-bound',
            'section-full'
        ]
        for (const reason of reasons) {
            const named = rejectionLine({ section: 'editors', index: 2, label: 'Hater', reason })
            expect(named).toContain('Hater')
            expect(named.length).toBeGreaterThan('Hater'.length + 4)
            // Unnamed entries fall back to a 1-based position.
            expect(rejectionLine({ section: 'editors', index: 2, label: '', reason })).toContain(
                'entry 3'
            )
        }
    })

    it('has a line for every adjustment kind', () => {
        const adjustments: ImportAdjustment[] = [
            { kind: 'api-key-cleared', label: 'Claude' },
            { kind: 'backend-cleared', label: 'Concision' },
            { kind: 'target-cleared', label: 'Zing' },
            { kind: 'members-dropped', label: 'Duo', count: 1 },
            { kind: 'members-dropped', label: 'Duo', count: 2 },
            { kind: 'voice-profile-replaced' }
        ]
        for (const adjustment of adjustments) {
            expect(adjustmentLine(adjustment).length).toBeGreaterThan(0)
        }
        expect(adjustmentLine({ kind: 'members-dropped', label: 'Duo', count: 1 })).toContain(
            '1 member editor'
        )
        expect(adjustmentLine({ kind: 'members-dropped', label: 'Duo', count: 2 })).toContain(
            '2 member editors'
        )
    })

    it('explains every document-level import error', () => {
        const errors: ImportError[] = ['not-json', 'not-an-object', 'no-sections']
        for (const error of errors) {
            expect(importErrorMessage(error).length).toBeGreaterThan(0)
        }
    })
})
