import { describe, expect, it } from 'bun:test'
import {
    applyRetention,
    clip,
    HISTORY_MAX_PER_FILE,
    HISTORY_MAX_TOTAL,
    HISTORY_QUOTE_MAX
} from '../../domain/history/history-entry'
import type { HistoryEntry } from '../../domain/history/history-entry'
import { HistoryService } from './history-service'

const NOW = 1_700_000_000_000
const DAY = 24 * 60 * 60 * 1_000

function service(overrides: { recordable?: boolean; now?: () => number } = {}): {
    history: HistoryService
    changes: () => number
} {
    let changes = 0
    const history = new HistoryService({
        isRecordable: () => overrides.recordable ?? true,
        now: overrides.now ?? ((): number => NOW),
        onChange: () => {
            changes += 1
        }
    })
    return { history, changes: () => changes }
}

function entry(at: number, filePath = 'a.md', id = String(at)): HistoryEntry {
    return {
        id,
        at,
        filePath,
        editorId: 'e1',
        editorName: 'Editor',
        kind: 'finding',
        key: '',
        quote: 'q',
        text: 't',
        edits: [],
        label: ''
    }
}

describe('history retention (issue #21 — decided up front)', () => {
    it('drops entries older than the age limit', () => {
        const kept = applyRetention([entry(NOW - 91 * DAY), entry(NOW - DAY)], NOW)
        expect(kept.map((e) => e.at)).toEqual([NOW - DAY])
    })

    it('keeps only the newest N per file and the newest M overall', () => {
        const many = Array.from({ length: HISTORY_MAX_PER_FILE + 10 }, (_, i) =>
            entry(NOW - i, 'a.md', `a${String(i)}`)
        )
        const kept = applyRetention(many, NOW)
        expect(kept).toHaveLength(HISTORY_MAX_PER_FILE)
        expect(kept[0]?.at).toEqual(NOW) // newest first

        const files = Array.from({ length: HISTORY_MAX_TOTAL + 50 }, (_, i) =>
            entry(NOW - i, `f${String(i)}.md`, `f${String(i)}`)
        )
        expect(applyRetention(files, NOW)).toHaveLength(HISTORY_MAX_TOTAL)
    })
})

describe('HistoryService (issue #21)', () => {
    it('records with hard clips and lists newest first', () => {
        const { history } = service()
        const long = 'x'.repeat(HISTORY_QUOTE_MAX * 2)
        history.record({
            filePath: 'a.md',
            editorId: 'e1',
            editorName: 'Editor',
            kind: 'finding',
            quote: long,
            text: 'critique'
        })
        const [only] = history.listForFile('a.md')
        expect(only?.quote.length).toBe(HISTORY_QUOTE_MAX)
        expect(only?.quote.endsWith('…')).toBeTrue()
        expect(clip('short', 10)).toBe('short')
    })

    it('never records for a non-recordable note (BR #7 applies to history)', () => {
        const { history, changes } = service({ recordable: false })
        history.record({ filePath: 'x.md', editorId: 'e', editorName: 'E', kind: 'finding' })
        expect(history.size()).toBe(0)
        expect(changes()).toBe(0)
    })

    it('skips a VERBATIM repeat of the most recent same-key entry, keeps reworded ones', () => {
        const { history } = service()
        const base = {
            filePath: 'a.md',
            editorId: 'e1',
            editorName: 'Editor',
            kind: 'finding' as const,
            key: 'obs-1',
            quote: 'quote',
            text: 'critique'
        }
        history.record(base)
        history.record(base) // verbatim repeat — skipped
        expect(history.size()).toBe(1)
        history.record({ ...base, text: 'sharper critique' }) // reworded — kept
        expect(history.size()).toBe(2)
    })

    it('follows renames and dies with deletions, per file and per folder', () => {
        const { history } = service()
        history.record({ filePath: 'dir/a.md', editorId: 'e', editorName: 'E', kind: 'finding' })
        history.record({ filePath: 'dir/b.md', editorId: 'e', editorName: 'E', kind: 'finding' })
        history.renameFile('dir/a.md', 'dir/c.md')
        expect(history.listForFile('dir/c.md')).toHaveLength(1)
        expect(history.listForFile('dir/a.md')).toHaveLength(0)
        history.deleteUnder('dir')
        expect(history.size()).toBe(0)
    })

    it('clearFile and clearAll notify once and only when something changed', () => {
        const { history, changes } = service()
        history.record({ filePath: 'a.md', editorId: 'e', editorName: 'E', kind: 'finding' })
        const after = changes()
        history.clearFile('other.md')
        expect(changes()).toBe(after)
        history.clearFile('a.md')
        expect(changes()).toBe(after + 1)
        history.clearAll()
        expect(changes()).toBe(after + 1) // already empty — no notify
    })

    it('hydrate merges persisted entries under retention', () => {
        const { history } = service()
        history.record({ filePath: 'a.md', editorId: 'e', editorName: 'E', kind: 'finding' })
        history.hydrate([entry(NOW - DAY, 'a.md', 'old'), entry(NOW - 91 * DAY, 'a.md', 'ancient')])
        expect(history.listForFile('a.md')).toHaveLength(2) // ancient evicted
    })
})

describe('hydrate is non-destructive (adversarial review round 3, 2026-08-02)', () => {
    it('keeps persisted entries even when isRecordable says no at load time', () => {
        // isRecordable mixes privacy with editor availability and cold-start
        // metadata; a transient "no" (backend down, metadata not indexed yet)
        // must not eat durable history. BR #19: the DISPLAY side gates —
        // hydration never filters.
        const history = new HistoryService({
            isRecordable: () => false,
            now: () => NOW
        })
        history.hydrate([entry(NOW - DAY, 'a.md', 'keep'), entry(NOW - DAY, 'b.md', 'also-keep')])
        expect(history.listForFile('a.md')).toHaveLength(1)
        expect(history.listForFile('b.md')).toHaveLength(1)
        // The round-trip preserves them too: serialize() must not lose what
        // hydrate() admitted, or the loss would be written back to disk.
        expect(history.serialize()).toHaveLength(2)
    })
})
