import { describe, expect, it } from 'bun:test'
import { daemonToggleNotice } from './daemon-commands'

describe('daemonToggleNotice', () => {
    it('names the cost and the delay when switching on', () => {
        const notice = daemonToggleNotice(true, 45)
        expect(notice).toContain('on')
        expect(notice).toContain('45s')
        // "On" is the direction that spends money; the command skips the
        // settings copy that says so, so the Notice has to carry it.
        expect(notice).toMatch(/calls your backends/i)
    })

    it('says what off means rather than only that it is off', () => {
        const notice = daemonToggleNotice(false, 30)
        expect(notice).toMatch(/only when you summon/i)
        expect(notice).not.toMatch(/\d+s/)
    })
})
