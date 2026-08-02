import { describe, expect, it } from 'bun:test'
import { PersonaRail } from './rail'
import type { RailEditorState, RailState } from './rail-model'

/**
 * A tiny stand-in for the pieces of the DOM the rail actually uses. Bun has no
 * DOM, and `rail.ts` was written for exactly this: it takes its `Document`
 * through the constructor (for popout correctness) and never imports
 * `obsidian`, so the whole file is drivable from here.
 *
 * Only what the rail touches is implemented — enough that a wrong structure,
 * a lost identity or a churned element FAILS rather than quietly passing.
 */
class StubClassList {
    private readonly names = new Set<string>()

    add(...values: string[]): void {
        for (const value of values) {
            this.names.add(value)
        }
    }

    remove(...values: string[]): void {
        for (const value of values) {
            this.names.delete(value)
        }
    }

    toggle(value: string, force: boolean): void {
        if (force) {
            this.names.add(value)
        } else {
            this.names.delete(value)
        }
    }

    contains(value: string): boolean {
        return this.names.has(value)
    }

    values(): string[] {
        return [...this.names]
    }
}

class StubElement {
    readonly classList = new StubClassList()
    readonly children: StubElement[] = []
    readonly attributes = new Map<string, string>()
    readonly dataset: Record<string, string> = {}
    readonly style = {
        properties: new Map<string, string>(),
        setProperty(name: string, value: string): void {
            this.properties.set(name, value)
        }
    }
    readonly listeners = new Map<string, Array<(event: unknown) => void>>()
    parent: StubElement | null = null
    textContent = ''
    title = ''
    type = ''
    disabled = false
    focused = false
    /** How many times a native tooltip was (re)attached to this element. */
    tooltipWrites = 0

    constructor(
        readonly tagName: string,
        private readonly doc: StubDocument
    ) {}

    appendChild(child: StubElement): void {
        child.parent?.removeChild(child)
        this.children.push(child)
        child.parent = this
    }

    removeChild(child: StubElement): void {
        const index = this.children.indexOf(child)
        if (index >= 0) {
            this.children.splice(index, 1)
            child.parent = null
        }
    }

    replaceChildren(): void {
        for (const child of [...this.children]) {
            this.removeChild(child)
        }
    }

    remove(): void {
        this.parent?.removeChild(this)
    }

    setAttribute(name: string, value: string): void {
        this.attributes.set(name, value)
    }

    getAttribute(name: string): string | null {
        return this.attributes.get(name) ?? null
    }

    addEventListener(type: string, listener: (event: unknown) => void): void {
        const existing = this.listeners.get(type) ?? []
        existing.push(listener)
        this.listeners.set(type, existing)
    }

    removeEventListener(type: string, listener: (event: unknown) => void): void {
        const existing = this.listeners.get(type)
        if (!existing) {
            return
        }
        const index = existing.indexOf(listener)
        if (index >= 0) {
            existing.splice(index, 1)
        }
    }

    /** Fires listeners of `type` with `this` as the event target. */
    dispatch(type: string): void {
        for (const listener of [...(this.listeners.get(type) ?? [])]) {
            listener({ target: this })
        }
    }

    focus(): void {
        this.doc.activeElement = this
    }

    /** No-op layout read — the rail uses it only to flush a class removal. */
    getBoundingClientRect(): { width: number; height: number } {
        return { width: 0, height: 0 }
    }

    /** Every descendant, depth-first, including this element. */
    tree(): StubElement[] {
        return [this, ...this.children.flatMap((child) => child.tree())]
    }

    find(className: string): StubElement | undefined {
        return this.tree().find((el) => el.classList.contains(className))
    }

    findAll(className: string): StubElement[] {
        return this.tree().filter((el) => el.classList.contains(className))
    }
}

class StubDocument {
    activeElement: StubElement | null = null

    createElement(tagName: string): StubElement {
        return new StubElement(tagName, this)
    }
}

function editor(overrides: Partial<RailEditorState> = {}): RailEditorState {
    return {
        id: 'a',
        name: 'Hater',
        color: '#ff0000',
        status: 'idle',
        findingCount: 0,
        ...overrides
    }
}

interface Harness {
    readonly rail: PersonaRail
    readonly root: StubElement
    readonly doc: StubDocument
    readonly clicks: string[]
    readonly tooltips: StubElement[]
}

function mount(): Harness {
    const doc = new StubDocument()
    const container = doc.createElement('div')
    const clicks: string[] = []
    const tooltips: StubElement[] = []
    const rail = new PersonaRail(
        container as unknown as HTMLElement,
        {
            onReview: () => clicks.push('review'),
            onCancel: () => clicks.push('cancel'),
            onToggleDaemon: () => clicks.push('daemon'),
            onToggleCollapsed: () => clicks.push('collapse'),
            onToggleFindings: () => clicks.push('findings'),
            onEditorClick: (editorId) => clicks.push(`editor:${editorId}`),
            onRetry: (editorId) => clicks.push(`retry:${editorId}`),
            onPanelClick: () => clicks.push('panel')
        },
        doc as unknown as Document,
        (el) => {
            const stub = el as unknown as StubElement
            stub.tooltipWrites += 1
            tooltips.push(stub)
        }
    )
    const root = container.children[0]
    if (root === undefined) {
        throw new Error('the rail did not mount')
    }
    return { rail, root, doc, clicks, tooltips }
}

function state(overrides: Partial<RailState> = {}): RailState {
    return { editors: [editor()], running: false, ...overrides }
}

function rowNames(root: StubElement): string[] {
    return root
        .findAll('editor-ai-daemons-rail-row')
        .map((row) => row.find('editor-ai-daemons-rail-name')?.textContent ?? '')
}

describe('PersonaRail structure', () => {
    it('nests the panel row and its members in the group, others outside', () => {
        const { rail, root } = mount()
        rail.render(
            state({
                editors: [
                    editor({ id: 'a', name: 'Hater' }),
                    editor({ id: 'b', name: 'Beginner' }),
                    editor({ id: 'c', name: 'Outsider' })
                ],
                panel: {
                    name: 'Pre-publish review',
                    color: 'var(--color-pink)',
                    status: 'ready',
                    memberIds: ['a', 'b'],
                    verdictLabel: 'Needs work'
                }
            })
        )
        const group = root.find('editor-ai-daemons-rail-group')
        const members = root.find('editor-ai-daemons-rail-members')
        expect(group).toBeDefined()
        expect(members).toBeDefined()
        expect(rowNames(group as StubElement)).toEqual(['Pre-publish review', 'Hater', 'Beginner'])
        expect(rowNames(members as StubElement)).toEqual(['Hater', 'Beginner'])
        // The non-member editor keeps its place outside the bracket.
        const list = root.find('editor-ai-daemons-rail-list') as StubElement
        const outside = list.children.filter((child) => child !== group)
        expect(outside.flatMap((slot) => rowNames(slot))).toEqual(['Outsider'])
    })

    it('gives the panel row a hollow core and the editors filled ones', () => {
        const { rail, root } = mount()
        rail.render(
            state({
                editors: [editor({ id: 'a' })],
                panel: {
                    name: 'Pre-publish review',
                    color: 'var(--color-pink)',
                    status: 'running',
                    memberIds: ['a']
                }
            })
        )
        const cores = root.findAll('editor-ai-daemons-rail-core')
        expect(cores).toHaveLength(2)
        expect(cores[0]?.classList.contains('editor-ai-daemons-rail-core-hollow')).toBeTrue()
        expect(cores[1]?.classList.contains('editor-ai-daemons-rail-core-hollow')).toBeFalse()
    })

    it('numbers the rows 0..n in VISUAL order across panel, members, others', () => {
        const { rail, root } = mount()
        rail.render(
            state({
                editors: [
                    editor({ id: 'a' }),
                    editor({ id: 'b' }),
                    editor({ id: 'c' }),
                    editor({ id: 'd' })
                ],
                panel: {
                    name: 'Pre-publish review',
                    color: 'var(--color-pink)',
                    status: 'running',
                    memberIds: ['b', 'd']
                }
            })
        )
        const indices = root
            .findAll('editor-ai-daemons-rail-slot')
            .map((slot) => slot.style.properties.get('--editor-ai-daemons-rail-index'))
        expect(indices).toEqual(['0', '1', '2', '3', '4'])
    })

    it('keeps the retry button a SIBLING of the row button', () => {
        const { rail, root, clicks } = mount()
        rail.render(state({ editors: [editor({ id: 'a', status: 'error' })] }))
        const slot = root.find('editor-ai-daemons-rail-slot') as StubElement
        const retry = root.find('editor-ai-daemons-rail-retry') as StubElement
        expect(retry.parent).toBe(slot)
        expect(slot.children.map((child) => child.tagName)).toEqual(['button', 'button'])
        retry.dispatch('click')
        expect(clicks).toEqual(['retry:a'])
    })

    it('silences the ring and the badge — the row name already says both', () => {
        const { rail, root } = mount()
        rail.render(state({ editors: [editor({ status: 'done', findingCount: 3 })] }))
        expect(root.find('editor-ai-daemons-rail-ring')?.getAttribute('aria-hidden')).toBe('true')
        expect(root.find('editor-ai-daemons-rail-badge')?.getAttribute('aria-hidden')).toBe('true')
    })
})

describe('PersonaRail reconciliation', () => {
    function streamed(): Harness {
        const harness = mount()
        harness.rail.render(
            state({
                runKey: 'snap-1',
                running: true,
                editors: [editor({ id: 'a', status: 'running' })]
            })
        )
        return harness
    }

    it('keeps the very same elements across a re-render', () => {
        // The whole reason this class reconciles: the rail re-renders on every
        // streamed finding, and a rebuilt element loses focus, restarts the
        // busy sweep and aborts every one-shot cue.
        const { rail, root } = streamed()
        const before = root.find('editor-ai-daemons-rail-row')
        const ringBefore = root.find('editor-ai-daemons-rail-ring')
        rail.render(
            state({
                runKey: 'snap-1',
                running: true,
                editors: [editor({ id: 'a', status: 'running', findingCount: 2 })]
            })
        )
        expect(root.find('editor-ai-daemons-rail-row')).toBe(before as StubElement)
        expect(root.find('editor-ai-daemons-rail-ring')).toBe(ringBefore as StubElement)
        expect(root.find('editor-ai-daemons-rail-badge')?.textContent).toBe('2')
    })

    it('does not re-apply the busy ring class while the status is unchanged', () => {
        // Re-adding `-ring-busy` restarts the `infinite` sweep from 0deg; at a
        // render per streamed finding the spinner would never complete a turn.
        const { rail, root } = streamed()
        const ring = root.find('editor-ai-daemons-rail-ring') as StubElement
        expect(ring.classList.contains('editor-ai-daemons-rail-ring-busy')).toBeTrue()
        ring.classList.remove('editor-ai-daemons-rail-ring-busy')
        rail.render(
            state({
                runKey: 'snap-1',
                running: true,
                editors: [editor({ id: 'a', status: 'running', findingCount: 5 })]
            })
        )
        // Untouched: a render that changes no status writes no ring class.
        expect(ring.classList.contains('editor-ai-daemons-rail-ring-busy')).toBeFalse()
    })

    it('swaps the ring class when the status DOES change', () => {
        const { rail, root } = streamed()
        const ring = root.find('editor-ai-daemons-rail-ring') as StubElement
        rail.render(state({ runKey: 'snap-1', editors: [editor({ id: 'a', status: 'done' })] }))
        expect(ring.classList.contains('editor-ai-daemons-rail-ring-busy')).toBeFalse()
        expect(ring.classList.contains('editor-ai-daemons-rail-ring-done')).toBeTrue()
    })

    it('re-attaches a native tooltip only when the text changed', () => {
        const { rail, root, tooltips } = streamed()
        const row = root.find('editor-ai-daemons-rail-row') as StubElement
        const writes = row.tooltipWrites
        rail.render(
            state({
                runKey: 'snap-1',
                running: true,
                editors: [editor({ id: 'a', status: 'running' })]
            })
        )
        expect(row.tooltipWrites).toBe(writes)
        rail.render(
            state({
                runKey: 'snap-1',
                running: true,
                editors: [editor({ id: 'a', status: 'running', findingCount: 1 })]
            })
        )
        expect(row.tooltipWrites).toBe(writes + 1)
        expect(tooltips.length).toBeGreaterThan(0)
    })

    it('drops the rows of editors that went away', () => {
        const { rail, root } = mount()
        rail.render(
            state({ editors: [editor({ id: 'a' }), editor({ id: 'b', name: 'Beginner' })] })
        )
        expect(rowNames(root)).toEqual(['Hater', 'Beginner'])
        rail.render(state({ editors: [editor({ id: 'b', name: 'Beginner' })] }))
        expect(rowNames(root)).toEqual(['Beginner'])
    })

    it('adds and removes the retry button as the status turns', () => {
        const { rail, root } = mount()
        rail.render(state({ editors: [editor({ id: 'a', status: 'error' })] }))
        expect(root.find('editor-ai-daemons-rail-retry')).toBeDefined()
        rail.render(state({ editors: [editor({ id: 'a', status: 'running' })] }))
        expect(root.find('editor-ai-daemons-rail-retry')).toBeUndefined()
    })
})

describe('PersonaRail focus', () => {
    it('keeps focus on the Review button across a run of re-renders', () => {
        const { rail, root, doc, clicks } = mount()
        rail.render(state())
        const button = root.find('editor-ai-daemons-rail-button') as StubElement
        button.focus()
        for (let finding = 1; finding <= 5; finding += 1) {
            rail.render(
                state({
                    runKey: 'snap-1',
                    running: true,
                    editors: [editor({ id: 'a', status: 'running', findingCount: finding })]
                })
            )
        }
        expect(doc.activeElement).toBe(button)
        // And it is now Cancel, without ever having been a different element.
        expect(button.textContent).toBe('Cancel')
        button.dispatch('click')
        expect(clicks).toEqual(['cancel'])
    })

    it('restores focus to the same row when the set of rows changes', () => {
        const { rail, root, doc } = mount()
        rail.render(
            state({ editors: [editor({ id: 'a' }), editor({ id: 'b', name: 'Beginner' })] })
        )
        const rowB = root
            .findAll('editor-ai-daemons-rail-row')
            .find((row) => row.dataset['editorId'] === 'b') as StubElement
        rowB.focus()
        rail.render(
            state({
                editors: [
                    editor({ id: 'a' }),
                    editor({ id: 'b', name: 'Beginner' }),
                    editor({ id: 'c', name: 'Outsider' })
                ]
            })
        )
        expect(doc.activeElement).toBe(rowB)
        expect(rowB.parent).not.toBeNull()
    })

    it('restores focus to a retry button across a restructure', () => {
        const { rail, root, doc } = mount()
        rail.render(
            state({
                editors: [editor({ id: 'a', status: 'error' }), editor({ id: 'b', name: 'B' })]
            })
        )
        const retry = root.find('editor-ai-daemons-rail-retry') as StubElement
        retry.focus()
        rail.render(state({ editors: [editor({ id: 'a', status: 'error' })] }))
        expect(doc.activeElement).toBe(retry)
    })
})

describe('PersonaRail motion cues', () => {
    it('plays the entrance once per run and clears it on animationend', () => {
        const { rail, root } = mount()
        rail.render(state({ runKey: 'snap-1', running: true }))
        const slot = root.find('editor-ai-daemons-rail-slot') as StubElement
        expect(slot.classList.contains('editor-ai-daemons-rail-slot-enter')).toBeTrue()
        // A render mid-animation must not take the class off — that is what
        // aborted the wash when the rail rebuilt itself.
        rail.render(
            state({
                runKey: 'snap-1',
                running: true,
                editors: [editor({ status: 'running', findingCount: 1 })]
            })
        )
        expect(slot.classList.contains('editor-ai-daemons-rail-slot-enter')).toBeTrue()
        slot.dispatch('animationend')
        expect(slot.classList.contains('editor-ai-daemons-rail-slot-enter')).toBeFalse()
    })

    it('washes a row exactly once when it settles', () => {
        const { rail, root } = mount()
        rail.render(state({ runKey: 'snap-1', editors: [editor({ status: 'running' })] }))
        const row = root.find('editor-ai-daemons-rail-row') as StubElement
        rail.render(
            state({ runKey: 'snap-1', editors: [editor({ status: 'done', findingCount: 2 })] })
        )
        expect(row.classList.contains('editor-ai-daemons-rail-row-settled')).toBeTrue()
        row.dispatch('animationend')
        expect(row.classList.contains('editor-ai-daemons-rail-row-settled')).toBeFalse()
        rail.render(
            state({ runKey: 'snap-1', editors: [editor({ status: 'done', findingCount: 2 })] })
        )
        expect(row.classList.contains('editor-ai-daemons-rail-row-settled')).toBeFalse()
    })

    it('bumps a count badge that changed, and never the panel verdict', () => {
        const { rail, root } = mount()
        const panel = (status: 'running' | 'ready'): RailState =>
            state({
                runKey: 'snap-1',
                editors: [editor({ id: 'a', status: 'running', findingCount: 1 })],
                panel: {
                    name: 'Pre-publish review',
                    color: 'var(--color-pink)',
                    status,
                    memberIds: ['a'],
                    ...(status === 'ready' ? { verdictLabel: 'Needs work' } : {})
                }
            })
        rail.render(panel('running'))
        rail.render({
            ...panel('ready'),
            editors: [editor({ id: 'a', status: 'running', findingCount: 2 })]
        })
        const count = root.find('editor-ai-daemons-rail-count') as StubElement
        const verdict = root.find('editor-ai-daemons-rail-verdict') as StubElement
        expect(count.classList.contains('editor-ai-daemons-rail-badge-bump')).toBeTrue()
        // The verdict pill only exists once the scorecard is terminal, so its
        // first render would ALWAYS be a bump — the settle wash says it.
        expect(verdict.classList.contains('editor-ai-daemons-rail-badge-bump')).toBeFalse()
    })
})

describe('PersonaRail live region', () => {
    it('owns a polite status region outside everything a render replaces', () => {
        const { rail, root } = mount()
        rail.render(state())
        const status = root.find('editor-ai-daemons-rail-status') as StubElement
        expect(status.getAttribute('role')).toBe('status')
        expect(status.getAttribute('aria-live')).toBe('polite')
        expect(status.parent).toBe(root)
    })

    it('announces a run starting and each editor landing', () => {
        const { rail, root } = mount()
        rail.render(state())
        const status = root.find('editor-ai-daemons-rail-status') as StubElement
        expect(status.textContent).toBe('')
        rail.render(state({ runKey: 'snap-1', running: true, editors: [editor({ id: 'a' })] }))
        expect(status.textContent).toBe('Review started, 1 editor.')
        rail.render(
            state({
                runKey: 'snap-1',
                running: true,
                editors: [editor({ id: 'a', status: 'running' })]
            })
        )
        rail.render(
            state({
                runKey: 'snap-1',
                editors: [editor({ id: 'a', name: 'Hater', status: 'done', findingCount: 2 })]
            })
        )
        expect(status.textContent).toBe('Hater — 2 findings. Review finished, 2 findings.')
    })

    it('says nothing new while findings merely stream in', () => {
        const { rail, root } = mount()
        rail.render(state({ runKey: 'snap-1', running: true }))
        const status = root.find('editor-ai-daemons-rail-status') as StubElement
        const announced = status.textContent
        for (let finding = 1; finding <= 4; finding += 1) {
            rail.render(
                state({
                    runKey: 'snap-1',
                    running: true,
                    editors: [editor({ status: 'running', findingCount: finding })]
                })
            )
        }
        expect(status.textContent).toBe(announced)
    })
})

describe('PersonaRail idle fade (issue #33)', () => {
    it('marks the rail busy while an editor is working', () => {
        const { rail, root } = mount()
        rail.render(state({ editors: [editor({ status: 'running' })], running: true }))
        expect(root.classList.contains('is-busy')).toBe(true)
    })

    it('marks the rail busy while a run is in flight even with settled rows', () => {
        const { rail, root } = mount()
        rail.render(state({ editors: [editor({ status: 'done' })], running: true }))
        expect(root.classList.contains('is-busy')).toBe(true)
    })

    it('marks the rail busy while a daemon refresh is armed', () => {
        const { rail, root } = mount()
        rail.render(
            state({
                editors: [editor({ status: 'idle' })],
                running: false,
                daemonMode: true,
                daemonArmed: true
            })
        )
        expect(root.classList.contains('is-busy')).toBe(true)
    })

    it('clears the busy mark on an idle rail — CSS may fade it', () => {
        const { rail, root } = mount()
        rail.render(state({ editors: [editor({ status: 'running' })], running: true }))
        rail.render(
            state({
                editors: [editor({ status: 'done' })],
                running: false,
                daemonMode: true, // merely ON never blocks the fade
                daemonArmed: false
            })
        )
        expect(root.classList.contains('is-busy')).toBe(false)
    })
})

describe('PersonaRail collapse (issue #28)', () => {
    it('marks the root collapsed and flips the chevron + aria-expanded', () => {
        const { rail, root } = mount()
        rail.render(state({ collapsed: true }))
        expect(root.classList.contains('is-collapsed')).toBe(true)
        const chevron = root.find('editor-ai-daemons-rail-collapse')
        expect(chevron?.textContent).toBe('▸')
        expect(chevron?.attributes.get('aria-expanded')).toBe('false')
        rail.render(state({ collapsed: false }))
        expect(root.classList.contains('is-collapsed')).toBe(false)
        expect(chevron?.textContent).toBe('▾')
        expect(chevron?.attributes.get('aria-expanded')).toBe('true')
    })

    it('routes a chevron click to the collapse callback', () => {
        const { rail, root, clicks } = mount()
        rail.render(state({}))
        root.find('editor-ai-daemons-rail-collapse')?.dispatch('click')
        expect(clicks).toEqual(['collapse'])
    })

    it('shows the total finding count only while collapsed and non-zero', () => {
        const { rail, root } = mount()
        const editors = [editor({ id: 'a', findingCount: 3 }), editor({ id: 'b', findingCount: 4 })]
        rail.render(state({ editors, collapsed: true }))
        const count = root.find('editor-ai-daemons-rail-collapsed-count')
        expect(count?.textContent).toBe('7')
        expect(count?.classList.contains('editor-ai-daemons-hidden')).toBe(false)
        // Expanded: the rows themselves carry the counts.
        rail.render(state({ editors, collapsed: false }))
        expect(count?.classList.contains('editor-ai-daemons-hidden')).toBe(true)
        // Collapsed with nothing reported: no badge.
        rail.render(state({ editors: [editor({ findingCount: 0 })], collapsed: true }))
        expect(count?.classList.contains('editor-ai-daemons-hidden')).toBe(true)
    })

    it('keeps the daemon toggle and the Cancel action reachable while collapsed', () => {
        const { rail, root, clicks } = mount()
        rail.render(state({ collapsed: true, running: true }))
        // The daemon toggle and the (Cancel) button still exist and dispatch;
        // hiding the Review form of the button is CSS, keyed off the classes
        // asserted here.
        root.find('editor-ai-daemons-rail-daemon')?.dispatch('click')
        const button = root.find('editor-ai-daemons-rail-button')
        expect(button?.classList.contains('editor-ai-daemons-rail-button-cancel')).toBe(true)
        button?.dispatch('click')
        expect(clicks).toEqual(['daemon', 'cancel'])
    })
})

describe('PersonaRail findings-visibility toggle (issue #29)', () => {
    it('mirrors the hidden state onto the control and routes clicks', () => {
        const { rail, root, clicks } = mount()
        rail.render(state({ findingsHidden: false }))
        const toggle = root.find('editor-ai-daemons-rail-findings-toggle')
        expect(toggle?.textContent).toBe('▣')
        expect(toggle?.attributes.get('aria-pressed')).toBe('false')
        rail.render(state({ findingsHidden: true }))
        expect(toggle?.textContent).toBe('▢')
        expect(toggle?.attributes.get('aria-pressed')).toBe('true')
        expect(toggle?.classList.contains('is-findings-hidden')).toBe(true)
        toggle?.dispatch('click')
        expect(clicks).toEqual(['findings'])
    })
})
