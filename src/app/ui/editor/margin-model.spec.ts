import { describe, expect, it } from 'bun:test'
import { commentJobView } from '../../domain/comments/comment-job'
import type { MarginComment } from '../../domain/comments/margin-comment'
import type { CommentAnchorOutcome } from '../../domain/comments/reanchor'
import {
    clusterChipLabel,
    isMarginVisible,
    marginCardView,
    marginColumnModel,
    marginCardStatusText,
    marginModelKey,
    marginRenderedCards,
    orphanHeading,
    MARGIN_BODY_MAX
} from './margin-model'
import type { MarginCommentInput } from './margin-model'

const comment = (overrides: Partial<MarginComment> = {}): MarginComment => ({
    id: 'c1',
    quote: 'the quoted span',
    instruction: 'Is this claim supported?',
    editorId: 'e1',
    editorName: 'Fact Checker',
    status: 'done',
    createdAt: 1_000,
    updatedAt: 2_000,
    findings: [],
    ...overrides
})

const entry = (
    overrides: Partial<MarginComment> = {},
    outcome: CommentAnchorOutcome = 'exact',
    extra: Partial<MarginCommentInput> = {}
): MarginCommentInput => {
    const value = comment(overrides)
    return {
        comment: value,
        view: commentJobView({ comment: value, startedAt: null, now: 10_000 }),
        outcome,
        color: '#ff0000',
        editorName: 'Fact Checker',
        expanded: false,
        ...extra
    }
}

describe('isMarginVisible', () => {
    it('keeps every live status', () => {
        for (const status of ['submitted', 'running', 'interrupted', 'failed', 'done'] as const) {
            expect(isMarginVisible(comment({ status }))).toBe(true)
        }
    })

    it('drops resolved comments — the store keeps them, the margin does not', () => {
        expect(isMarginVisible(comment({ status: 'dismissed' }))).toBe(false)
    })
})

describe('marginCardView', () => {
    it('shows the note-level reply as the body', () => {
        const card = marginCardView(entry({ reply: 'The claim checks out.' }))
        expect(card.body).toBe('The claim checks out.')
        expect(card.truncated).toBe(false)
        expect(card.statusLabel).toBe('Answered')
    })

    it('joins pinned critiques when there is no reply', () => {
        const card = marginCardView(
            entry({
                findings: [
                    { quote: 'a', critique: 'First problem', severity: 'warning', evidence: [] },
                    { quote: 'b', critique: 'Second problem', severity: 'warning', evidence: [] }
                ]
            })
        )
        expect(card.body).toBe('First problem\n\nSecond problem')
        expect(card.statusLabel).toBe('2 findings')
    })

    it('says nothing while the job has nothing to say', () => {
        expect(marginCardView(entry({ status: 'running' })).body).toBeNull()
        expect(marginCardView(entry({ status: 'interrupted' })).body).toBeNull()
    })

    it('shows the redacted failure reason for a failed job', () => {
        const card = marginCardView(entry({ status: 'failed', error: 'The request timed out.' }))
        expect(card.body).toBe('The request timed out.')
    })

    it('truncates a long body and offers the expansion', () => {
        const long = 'x'.repeat(MARGIN_BODY_MAX + 50)
        const card = marginCardView(entry({ reply: long }))
        expect(card.truncated).toBe(true)
        expect(card.expanded).toBe(false)
        expect(card.body?.endsWith('…')).toBe(true)
        expect(card.body?.length).toBe(MARGIN_BODY_MAX + 1)
    })

    it('shows the whole body once expanded', () => {
        const long = 'x'.repeat(MARGIN_BODY_MAX + 50)
        const card = marginCardView(entry({ reply: long }, 'exact', { expanded: true }))
        expect(card.body).toBe(long)
        expect(card.expanded).toBe(true)
    })

    it('does not report whitespace collapsing as truncation', () => {
        const card = marginCardView(entry({ reply: 'two    spaces   collapse' }))
        expect(card.body).toBe('two spaces collapse')
        expect(card.truncated).toBe(false)
        expect(card.expanded).toBe(false)
    })

    it('keeps paragraphs in the body but flattens the question', () => {
        const card = marginCardView(
            entry({ reply: 'one\n\ntwo', instruction: 'a question\nover two lines' })
        )
        expect(card.body).toBe('one\n\ntwo')
        expect(card.question).toBe('a question over two lines')
    })

    it('offers every action on an anchored answered comment', () => {
        expect(marginCardView(entry()).actions).toEqual({
            canReveal: true,
            canRetry: false,
            canCancel: false,
            canResolve: true,
            canDelete: true
        })
    })

    it('offers retry on an interrupted comment that still has a span', () => {
        const card = marginCardView(entry({ status: 'interrupted' }))
        expect(card.actions.canRetry).toBe(true)
        expect(card.actions.canCancel).toBe(false)
    })

    it('never offers retry or reveal on an orphan, but keeps its quote', () => {
        const card = marginCardView(entry({ status: 'failed', error: 'boom' }, 'orphaned'))
        expect(card.orphaned).toBe(true)
        expect(card.quote).toBe('the quoted span')
        expect(card.actions.canRetry).toBe(false)
        expect(card.actions.canReveal).toBe(false)
        // It can still be closed or taken back — nothing is stuck.
        expect(card.actions.canResolve).toBe(true)
        expect(card.actions.canDelete).toBe(true)
    })

    it('offers cancel while the job is in flight', () => {
        const value = comment({ status: 'running' })
        const card = marginCardView({
            ...entry({ status: 'running' }),
            comment: value,
            view: commentJobView({ comment: value, startedAt: 4_000, now: 10_000 })
        })
        expect(card.actions.canCancel).toBe(true)
        expect(card.timer).toBe('0:06')
    })

    it('flags a drifted (fuzzy) anchor without hiding the quote of an exact one', () => {
        expect(marginCardView(entry({}, 'fuzzy')).drifted).toBe(true)
        expect(marginCardView(entry({}, 'fuzzy')).quote).toBeNull()
        expect(marginCardView(entry({}, 'exact')).drifted).toBe(false)
    })

    it('announces editor, state, question and the anchoring problem as one sentence', () => {
        expect(marginCardView(entry({}, 'orphaned')).accessibleName).toBe(
            'Fact Checker — Nothing to report — Is this claim supported? — the text it was about is no longer in the note'
        )
        expect(marginCardView(entry({}, 'fuzzy')).accessibleName).toBe(
            'Fact Checker — Nothing to report — Is this claim supported? — the text it was about has changed slightly'
        )
        expect(marginCardView(entry({}, 'exact')).accessibleName).toBe(
            'Fact Checker — Nothing to report — Is this claim supported?'
        )
    })
})

describe('marginColumnModel', () => {
    it('renders nothing when there is nothing to render', () => {
        const model = marginColumnModel({ groups: [], orphans: [], orphansExpanded: false })
        expect(model.groups).toEqual([])
        // No empty orphan group, ever — and no `empty` flag either: a column
        // with nothing in view is the normal case while the note is scrolled
        // past its comments, not a column that should disappear.
        expect(model.orphans).toBeNull()
    })

    it('never collapses a single comment into a chip', () => {
        const model = marginColumnModel({
            groups: [{ key: 'c1', anchorTop: 40, expanded: false, comments: [entry()] }],
            orphans: [],
            orphansExpanded: false
        })
        const group = model.groups[0]
        expect(group?.collapsed).toBe(false)
        expect(group?.chipLabel).toBeNull()
        expect(group?.cards).toHaveLength(1)
    })

    it('collapses several comments on one line into a chip', () => {
        const model = marginColumnModel({
            groups: [
                {
                    key: 'c1',
                    anchorTop: 40,
                    expanded: false,
                    comments: [
                        entry({ id: 'c1' }),
                        entry({ id: 'c2' }, 'exact', { editorName: 'Humanizer' })
                    ]
                }
            ],
            orphans: [],
            orphansExpanded: false
        })
        const group = model.groups[0]
        expect(group?.collapsed).toBe(true)
        expect(group?.chipLabel).toBe('2 comments')
        expect(group?.chipAccessibleName).toBe(
            '2 comments on this line, from Fact Checker, Humanizer'
        )
        expect(group?.cards).toEqual([])
    })

    it('expands a chip into its cards, in stored order', () => {
        const model = marginColumnModel({
            groups: [
                {
                    key: 'c1',
                    anchorTop: 40,
                    expanded: true,
                    comments: [entry({ id: 'c1' }), entry({ id: 'c2' })]
                }
            ],
            orphans: [],
            orphansExpanded: false
        })
        expect(model.groups[0]?.collapsed).toBe(false)
        expect(model.groups[0]?.cards.map((card) => card.commentId)).toEqual(['c1', 'c2'])
    })

    it('collects orphans into one collapsed group with a plain-language heading', () => {
        const model = marginColumnModel({
            groups: [],
            orphans: [entry({ id: 'o1' }, 'orphaned'), entry({ id: 'o2' }, 'orphaned')],
            orphansExpanded: false
        })
        expect(model.orphans?.heading).toBe('2 comments lost their text')
        expect(model.orphans?.expanded).toBe(false)
        // Collapsed: nothing rendered, but the group itself is visible.
        expect(model.orphans?.cards).toEqual([])
    })

    it('renders the orphan cards once expanded', () => {
        const model = marginColumnModel({
            groups: [],
            orphans: [entry({ id: 'o1' }, 'orphaned')],
            orphansExpanded: true
        })
        expect(model.orphans?.heading).toBe('1 comment lost its text')
        expect(model.orphans?.cards.map((card) => card.commentId)).toEqual(['o1'])
    })
})

describe('the live text a rebuild would otherwise be needed for', () => {
    it('composes the status line with the elapsed time when one is running', () => {
        const value = comment({ status: 'running' })
        const card = marginCardView({
            comment: value,
            view: commentJobView({ comment: value, startedAt: 1_000, now: 8_000 }),
            outcome: 'exact',
            color: '#ff0000',
            editorName: 'Fact Checker',
            expanded: false
        })
        expect(marginCardStatusText(card)).toBe(`${card.statusLabel} ${card.timer ?? ''}`)
        expect(marginCardStatusText(marginCardView(entry()))).toBe('Nothing to report')
    })

    it('lists every rendered card, orphans first, and skips collapsed ones', () => {
        const model = marginColumnModel({
            groups: [
                { key: 'c1', anchorTop: 10, expanded: false, comments: [entry({ id: 'c1' })] },
                {
                    key: 'c2',
                    anchorTop: 20,
                    expanded: false,
                    comments: [entry({ id: 'c2' }), entry({ id: 'c3' })]
                }
            ],
            orphans: [entry({ id: 'o1' }, 'orphaned')],
            orphansExpanded: true
        })
        expect(marginRenderedCards(model).map((card) => card.commentId)).toEqual(['o1', 'c1'])
    })
})

describe('marginModelKey', () => {
    const modelWith = (
        overrides: Partial<MarginComment>,
        anchorTop: number,
        expanded = false
    ): ReturnType<typeof marginColumnModel> =>
        marginColumnModel({
            groups: [
                {
                    key: 'c1',
                    anchorTop,
                    expanded: false,
                    comments: [entry(overrides, 'exact', { expanded })]
                }
            ],
            orphans: [],
            orphansExpanded: false
        })

    it('ignores anchor movement — scrolling must reposition, never re-render', () => {
        expect(marginModelKey(modelWith({}, 40))).toBe(marginModelKey(modelWith({}, 900)))
    })

    it('changes when the job state changes', () => {
        expect(marginModelKey(modelWith({ status: 'running' }, 40))).not.toBe(
            marginModelKey(modelWith({ status: 'interrupted' }, 40))
        )
    })

    it('ignores the elapsed timer — a running job must not rebuild the column every second', () => {
        // The timer ticks once a second for as long as a job runs, and a
        // rebuild takes the keyboard user's focus with it. `marginCardStatusText`
        // is what the column writes in place instead.
        const running = (now: number): ReturnType<typeof marginColumnModel> => {
            const value = comment({ status: 'running' })
            return marginColumnModel({
                groups: [
                    {
                        key: 'c1',
                        anchorTop: 40,
                        expanded: false,
                        comments: [
                            {
                                comment: value,
                                view: commentJobView({ comment: value, startedAt: 1_000, now }),
                                outcome: 'exact',
                                color: '#ff0000',
                                editorName: 'Fact Checker',
                                expanded: false
                            }
                        ]
                    }
                ],
                orphans: [],
                orphansExpanded: false
            })
        }
        const first = running(4_000)
        const later = running(48_000)
        expect(first.groups[0]?.cards[0]?.timer).not.toBe(later.groups[0]?.cards[0]?.timer)
        expect(marginModelKey(first)).toBe(marginModelKey(later))
    })

    it('changes when the answer arrives', () => {
        expect(marginModelKey(modelWith({ reply: 'yes' }, 40))).not.toBe(
            marginModelKey(modelWith({ reply: 'no' }, 40))
        )
    })

    it('changes when a card is expanded', () => {
        const long = 'x'.repeat(MARGIN_BODY_MAX + 10)
        expect(marginModelKey(modelWith({ reply: long }, 40, false))).not.toBe(
            marginModelKey(modelWith({ reply: long }, 40, true))
        )
    })

    it('changes when a line group collapses or expands', () => {
        const group = (expanded: boolean): ReturnType<typeof marginColumnModel> =>
            marginColumnModel({
                groups: [
                    {
                        key: 'c1',
                        anchorTop: 40,
                        expanded,
                        comments: [entry({ id: 'c1' }), entry({ id: 'c2' })]
                    }
                ],
                orphans: [],
                orphansExpanded: false
            })
        expect(marginModelKey(group(false))).not.toBe(marginModelKey(group(true)))
    })

    it('changes when the orphan group appears or expands', () => {
        const orphans = (expanded: boolean): ReturnType<typeof marginColumnModel> =>
            marginColumnModel({
                groups: [],
                orphans: [entry({ id: 'o1' }, 'orphaned')],
                orphansExpanded: expanded
            })
        expect(marginModelKey(orphans(false))).not.toBe(marginModelKey(orphans(true)))
        expect(
            marginModelKey(marginColumnModel({ groups: [], orphans: [], orphansExpanded: false }))
        ).toBe('')
    })
})

describe('labels', () => {
    it('counts comments in a chip', () => {
        expect(clusterChipLabel(1)).toBe('1 comment')
        expect(clusterChipLabel(4)).toBe('4 comments')
    })

    it('words the orphan heading for one and for many', () => {
        expect(orphanHeading(1)).toBe('1 comment lost its text')
        expect(orphanHeading(3)).toBe('3 comments lost their text')
    })
})
