import { describe, expect, it } from 'bun:test'
import { THREAD_MAX_TURNS } from '../../domain/operations/thread'
import type { ThreadMessage } from '../../domain/operations/thread'
import {
    CARD_GAP,
    acceptControl,
    computeCardPosition,
    replyInputValue,
    selectFindingsAtPos,
    threadRefusalNotice,
    threadView
} from './finding-card'
import type { CardAnchorRect, CardSize, CardViewport, FindingSpanCandidate } from './finding-card'
import { cardMaxWidth, paneCardViewport } from './layout-mode'
import type { LayoutBox } from './layout-mode'

const viewport: CardViewport = { left: 8, top: 8, right: 1008, bottom: 708 }
const card: CardSize = { width: 300, height: 200 }

function anchor(overrides: Partial<CardAnchorRect> = {}): CardAnchorRect {
    return { left: 100, top: 100, bottom: 120, ...overrides }
}

describe('computeCardPosition', () => {
    it('places the card below the anchor, left-aligned, when it fits', () => {
        const position = computeCardPosition(anchor(), card, viewport)
        expect(position).toEqual({ left: 100, top: 120 + CARD_GAP })
    })

    it('honors a custom gap', () => {
        const position = computeCardPosition(anchor(), card, viewport, 20)
        expect(position.top).toBe(140)
    })

    it('clamps the left edge to the viewport left', () => {
        const position = computeCardPosition(anchor({ left: -50 }), card, viewport)
        expect(position.left).toBe(viewport.left)
    })

    it('clamps the right edge so the card stays inside the viewport', () => {
        const position = computeCardPosition(anchor({ left: 990 }), card, viewport)
        expect(position.left).toBe(viewport.right - card.width)
    })

    it('flips above the anchor when there is no room below', () => {
        const position = computeCardPosition(anchor({ top: 600, bottom: 620 }), card, viewport)
        expect(position.top).toBe(600 - CARD_GAP - card.height)
    })

    it('clamps to the viewport bottom when the card fits on neither side', () => {
        const tallCard: CardSize = { width: 300, height: 650 }
        const position = computeCardPosition(anchor({ top: 350, bottom: 370 }), tallCard, viewport)
        expect(position.top).toBe(viewport.bottom - tallCard.height)
    })

    it('pins to the viewport top when the card is taller than the viewport', () => {
        const hugeCard: CardSize = { width: 300, height: 5_000 }
        const position = computeCardPosition(anchor(), hugeCard, viewport)
        expect(position.top).toBe(viewport.top)
    })

    it('pins to the viewport left when the card is wider than the viewport', () => {
        const wideCard: CardSize = { width: 5_000, height: 200 }
        const position = computeCardPosition(anchor(), wideCard, viewport)
        expect(position.left).toBe(viewport.left)
    })
})

describe('card positioning inside a pane (adaptive layout)', () => {
    // What `positionCard` composes: the window box, the view's pane rect, the
    // width cap, then the position.
    const windowBox: LayoutBox = { left: 8, top: 8, right: 1_592, bottom: 892 }
    const rightPane: LayoutBox = { left: 800, top: 40, right: 1_600, bottom: 900 }

    it('keeps a card anchored in a split inside that split', () => {
        const box = paneCardViewport(rightPane, windowBox, 8)
        const size: CardSize = { width: cardMaxWidth(box), height: 200 }
        // Anchor near the pane's left edge: without the pane box the card
        // would be left-aligned at 810 and run to 1370 — fine. The real
        // hazard is the RIGHT edge, so also check a late anchor.
        const early = computeCardPosition({ left: 810, top: 100, bottom: 120 }, size, box)
        expect(early.left).toBeGreaterThanOrEqual(box.left)
        expect(early.left + size.width).toBeLessThanOrEqual(box.right)

        const late = computeCardPosition({ left: 1_500, top: 100, bottom: 120 }, size, box)
        expect(late.left).toBe(box.right - size.width)
        expect(late.left).toBeGreaterThanOrEqual(rightPane.left)
    })

    it('caps the card width to the pane, not the window', () => {
        const box = paneCardViewport(rightPane, windowBox, 8)
        expect(cardMaxWidth(box)).toBe(1_592 - 808)
        expect(cardMaxWidth(box)).toBeLessThan(windowBox.right - windowBox.left)
    })

    it('never places a card above the pane top', () => {
        const box = paneCardViewport(rightPane, windowBox, 8)
        const tall: CardSize = { width: 300, height: 700 }
        const position = computeCardPosition({ left: 900, top: 500, bottom: 520 }, tall, box)
        expect(position.top).toBeGreaterThanOrEqual(box.top)
    })
})

function candidate(findingId: string, from: number, to: number): FindingSpanCandidate {
    return { findingId, from, to }
}

describe('selectFindingsAtPos', () => {
    it('returns nothing when no span covers the position', () => {
        expect(selectFindingsAtPos([candidate('f-1', 0, 5)], 10)).toEqual([])
    })

    it('returns the single covering finding', () => {
        expect(selectFindingsAtPos([candidate('f-1', 0, 5)], 3)).toEqual(['f-1'])
    })

    it('treats span boundaries as covering (inclusive)', () => {
        const candidates = [candidate('f-1', 5, 10)]
        expect(selectFindingsAtPos(candidates, 5)).toEqual(['f-1'])
        expect(selectFindingsAtPos(candidates, 10)).toEqual(['f-1'])
    })

    it('stacks overlapping findings innermost-first', () => {
        const candidates = [
            candidate('outer', 0, 100),
            candidate('inner', 40, 50),
            candidate('middle', 20, 80)
        ]
        expect(selectFindingsAtPos(candidates, 45)).toEqual(['inner', 'middle', 'outer'])
    })

    it('breaks equal-length ties by start position, then id', () => {
        const byFrom = [candidate('b', 10, 20), candidate('a', 12, 22)]
        expect(selectFindingsAtPos(byFrom, 15)).toEqual(['b', 'a'])
        const byId = [candidate('b', 10, 20), candidate('a', 10, 20)]
        expect(selectFindingsAtPos(byId, 15)).toEqual(['a', 'b'])
    })

    it('dedupes duplicate finding ids', () => {
        const candidates = [candidate('f-1', 0, 10), candidate('f-1', 2, 8)]
        expect(selectFindingsAtPos(candidates, 5)).toEqual(['f-1'])
    })

    it('ignores empty spans', () => {
        expect(selectFindingsAtPos([candidate('empty', 5, 5)], 5)).toEqual([])
    })
})

// ---------------------------------------------------------------------------
// Push-back thread block
// ---------------------------------------------------------------------------

function exchanges(count: number): ThreadMessage[] {
    const thread: ThreadMessage[] = []
    for (let index = 0; index < count; index++) {
        thread.push({ role: 'user', content: `push ${index}` })
        thread.push({ role: 'editor', content: `reply ${index}` })
    }
    return thread
}

describe('threadView', () => {
    it('offers an empty input on a finding with no thread', () => {
        expect(threadView({ editorName: 'Hater', thread: [], threadTurn: null })).toEqual({
            rows: [],
            failure: null,
            inputEnabled: true,
            placeholder: 'Push back, ask for evidence…',
            restoreDraft: null
        })
    })

    it('renders completed exchanges in order', () => {
        const view = threadView({ editorName: 'Hater', thread: exchanges(2), threadTurn: null })
        expect(view.rows).toEqual([
            { role: 'user', content: 'push 0', state: 'settled' },
            { role: 'editor', content: 'reply 0', state: 'settled' },
            { role: 'user', content: 'push 1', state: 'settled' },
            { role: 'editor', content: 'reply 1', state: 'settled' }
        ])
        expect(view.inputEnabled).toBeTrue()
    })

    it('shows the in-flight message and locks the input', () => {
        const view = threadView({
            editorName: 'Hater',
            thread: exchanges(1),
            threadTurn: { status: 'pending', message: 'still wrong' }
        })
        expect(view.rows[2]).toEqual({ role: 'user', content: 'still wrong', state: 'pending' })
        expect(view.inputEnabled).toBeFalse()
        expect(view.placeholder).toEqual('Waiting for Hater…')
        expect(view.failure).toBeNull()
        expect(view.restoreDraft).toBeNull()
    })

    it('shows a failed turn with its reason and restores the message', () => {
        const view = threadView({
            editorName: 'Hater',
            thread: [],
            threadTurn: { status: 'failed', message: 'why?', reason: 'Request timed out' }
        })
        expect(view.rows).toEqual([{ role: 'user', content: 'why?', state: 'failed' }])
        expect(view.failure).toEqual('Request timed out')
        expect(view.inputEnabled).toBeTrue()
        expect(view.restoreDraft).toEqual('why?')
    })

    it('locks the input at the turn cap', () => {
        const view = threadView({
            editorName: 'Hater',
            thread: exchanges(THREAD_MAX_TURNS),
            threadTurn: null
        })
        expect(view.inputEnabled).toBeFalse()
        expect(view.placeholder).toEqual('Push-back limit reached for this finding')
        expect(view.rows).toHaveLength(THREAD_MAX_TURNS * 2)
    })
})

describe('replyInputValue', () => {
    it('shows the user’s own draft when there is one', () => {
        expect(replyInputValue('half typed', 'failed message')).toEqual('half typed')
    })

    it('restores a failed turn’s message when the draft is empty or absent', () => {
        // Sending clears the input, so the rebuild that follows captures an
        // empty value — it must not shadow the restore (the user would have to
        // retype the message their turn failed on).
        expect(replyInputValue('', 'failed message')).toEqual('failed message')
        expect(replyInputValue(undefined, 'failed message')).toEqual('failed message')
    })

    it('falls back to an empty input', () => {
        expect(replyInputValue(undefined, null)).toEqual('')
        expect(replyInputValue('', null)).toEqual('')
    })
})

describe('threadRefusalNotice', () => {
    it('words every refusal reason', () => {
        expect(threadRefusalNotice('not-found', 'Hater')).toContain('no longer available')
        expect(threadRefusalNotice('invalid-status', 'Hater')).toContain('already resolved')
        expect(threadRefusalNotice('in-flight', 'Hater')).toEqual(
            'Hater is still answering your previous message.'
        )
        expect(threadRefusalNotice('cap-reached', 'Hater')).toContain(String(THREAD_MAX_TURNS))
        expect(threadRefusalNotice('blank-message', 'Hater')).toContain('before sending')
    })
})

describe('acceptControl', () => {
    const edit = { op: 'replace' as const, target: 'old', text: 'new' }

    it('offers nothing for a proposal-less finding, stale marker or not', () => {
        expect(acceptControl({ edits: [], staleProposal: false, carryover: false })).toEqual('none')
        expect(acceptControl({ edits: [], staleProposal: true, carryover: false })).toEqual('none')
    })

    it('offers the regular Accept while no stale marker is set', () => {
        expect(acceptControl({ edits: [edit], staleProposal: false, carryover: false })).toEqual(
            'accept'
        )
        // Carryover alone does not change the accept area.
        expect(acceptControl({ edits: [edit], staleProposal: false, carryover: true })).toEqual(
            'accept'
        )
    })

    it('replaces a stale proposal’s dead Accept with badge + Regenerate', () => {
        expect(acceptControl({ edits: [edit], staleProposal: true, carryover: false })).toEqual(
            'regenerate'
        )
    })

    it('shows the badge alone for a stale carryover (no Regenerate)', () => {
        expect(acceptControl({ edits: [edit], staleProposal: true, carryover: true })).toEqual(
            'stale-badge-only'
        )
    })
})
