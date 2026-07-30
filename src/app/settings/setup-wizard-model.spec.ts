import { describe, expect, it } from 'bun:test'
import { SETUP_WIZARD_STEPS } from '../domain/settings/setup-wizard'
import type { SetupOutcome } from '../domain/settings/setup-wizard'
import type { BackendHealthResult } from '../services/backends/health-check'
import {
    DAEMON_COST_WARNING,
    KEY_STORAGE_DISCLOSURE,
    SETUP_POINTERS,
    healthCheckBlock,
    healthResultClass,
    healthResultLine,
    nextButtonLabel,
    setupSummaryLines,
    stepBody,
    stepProgressLabel,
    stepTitle
} from './setup-wizard-model'

const OUTCOME: SetupOutcome = {
    backendAdded: true,
    becameDefaultBackend: true,
    enabledEditorCount: 3,
    voiceNoteCount: 0,
    daemonMode: false
}

describe('step copy', () => {
    it('titles and describes every step', () => {
        for (const step of SETUP_WIZARD_STEPS) {
            expect(stepTitle(step).length).toBeGreaterThan(0)
            expect(stepBody(step).length).toBeGreaterThan(0)
        }
    })

    it('numbers the steps from one', () => {
        expect(stepProgressLabel('welcome')).toBe('Step 1 of 6')
        expect(stepProgressLabel('done')).toBe('Step 6 of 6')
    })

    it('labels the forward button for where it leads', () => {
        expect(nextButtonLabel('welcome')).toBe('Get started')
        expect(nextButtonLabel('backend')).toBe('Next')
        expect(nextButtonLabel('done')).toBe('Finish')
    })
})

describe('the two disclosures that must be right', () => {
    it('says keys are stored in plain text inside the vault', () => {
        expect(KEY_STORAGE_DISCLOSURE).toContain('plain text')
        expect(KEY_STORAGE_DISCLOSURE).toContain('data.json')
        expect(KEY_STORAGE_DISCLOSURE).toContain('vault')
    })

    it('states the cost implication of daemon mode (Business Rule #1)', () => {
        expect(DAEMON_COST_WARNING).toContain('paid request')
        expect(DAEMON_COST_WARNING).toContain('off by default')
    })

    it('points at the review command, the panel and the send preview', () => {
        const all = SETUP_POINTERS.join(' ')
        expect(all).toContain('Review current note')
        expect(all).toContain('Open review panel')
        expect(all).toContain('Preview what will be sent')
    })
})

describe('healthCheckBlock', () => {
    it('needs a model before spending a request', () => {
        expect(healthCheckBlock(false)).toContain('model')
        expect(healthCheckBlock(true)).toBeNull()
    })
})

describe('health result copy', () => {
    const result = (
        status: BackendHealthResult['status'],
        message: string
    ): BackendHealthResult => ({
        status,
        code: status === 'ok' ? '' : 'x',
        message
    })

    it('reports success without hedging', () => {
        expect(healthResultLine(result('ok', 'Connection works.'))).toContain('works')
    })

    it('keeps "reached but unusable" distinct from a failure, in words and in class', () => {
        const unusable = result('unusable', 'the model ignored the structure')
        const failed = result('failed', 'Provider rejected the credentials (HTTP 401)')
        expect(healthResultLine(unusable)).toContain('Reached')
        expect(healthResultLine(failed)).toContain('Failed')
        expect(healthResultClass(unusable)).not.toBe(healthResultClass(failed))
    })

    it('carries the underlying message through, whatever it is', () => {
        expect(healthResultLine(result('failed', 'Provider is unavailable (HTTP 503)'))).toContain(
            'HTTP 503'
        )
    })
})

describe('setupSummaryLines', () => {
    it('leads with the fact that nothing will run, when nothing will', () => {
        const lines = setupSummaryLines({ ...OUTCOME, enabledEditorCount: 0 }, false)
        expect(lines[0]).toContain('No editor is enabled')
    })

    it('blames the missing backend when editors are enabled but cannot run', () => {
        const lines = setupSummaryLines({ ...OUTCOME, backendAdded: false }, false)
        expect(lines[0]).toContain('No usable backend')
    })

    it('says nothing alarming when the setup can run', () => {
        const lines = setupSummaryLines(OUTCOME, true)
        expect(lines.join(' ')).not.toContain('nothing will run')
    })

    it('says whether an added backend became the default', () => {
        expect(setupSummaryLines(OUTCOME, true).join(' ')).toContain('set as the default')
        expect(
            setupSummaryLines({ ...OUTCOME, becameDefaultBackend: false }, true).join(' ')
        ).toContain('existing default backend is unchanged')
    })

    it('counts editors and voice notes, singular and plural', () => {
        expect(setupSummaryLines({ ...OUTCOME, enabledEditorCount: 1 }, true)).toContain(
            '1 editor enabled.'
        )
        expect(setupSummaryLines({ ...OUTCOME, enabledEditorCount: 4 }, true)).toContain(
            '4 editors enabled.'
        )
        expect(setupSummaryLines({ ...OUTCOME, voiceNoteCount: 1 }, true).join(' ')).toContain(
            '1 voice profile note '
        )
        expect(setupSummaryLines({ ...OUTCOME, voiceNoteCount: 2 }, true).join(' ')).toContain(
            '2 voice profile notes '
        )
    })

    it('omits the voice line when no note was picked', () => {
        expect(setupSummaryLines(OUTCOME, true).join(' ')).not.toContain('voice profile')
    })

    it('states the run mode either way', () => {
        expect(setupSummaryLines(OUTCOME, true).join(' ')).toContain('wait to be summoned')
        expect(setupSummaryLines({ ...OUTCOME, daemonMode: true }, true).join(' ')).toContain(
            'Daemon mode on'
        )
    })
})
