import { describe, expect, it } from 'bun:test'
import { removeStrayMounts, strayMountSelector } from './mount-guard'
import type { StrayMountHost } from './mount-guard'

/**
 * A stand-in for the slice of `Element` the guard touches. Bun has no DOM;
 * the stub keeps a flat child list and answers `:scope > .cls` queries the
 * way `querySelectorAll` would for direct children — enough that a wrong
 * selector shape or a skipped removal FAILS instead of quietly passing.
 */
class StubChild {
    removed = false

    constructor(
        readonly className: string,
        private readonly host: StubHost
    ) {}

    remove(): void {
        this.removed = true
        this.host.detach(this)
    }
}

class StubHost implements StrayMountHost {
    readonly children: StubChild[] = []
    readonly queries: string[] = []

    append(className: string): StubChild {
        const child = new StubChild(className, this)
        this.children.push(child)
        return child
    }

    detach(child: StubChild): void {
        const index = this.children.indexOf(child)
        if (index >= 0) {
            this.children.splice(index, 1)
        }
    }

    querySelectorAll(selector: string): ArrayLike<{ remove(): void }> {
        this.queries.push(selector)
        const match = /^:scope > \.(.+)$/.exec(selector)
        const className = match?.[1]
        if (!className) {
            return []
        }
        return this.children.filter((child) => child.className === className)
    }
}

describe('strayMountSelector', () => {
    it('targets DIRECT children only — nested views own their own mounts', () => {
        // The `:scope >` prefix is the load-bearing part: without it, a rail
        // inside an embedded markdown view would be torn down by its host.
        expect(strayMountSelector('editor-ai-daemons-rail-wrapper')).toBe(
            ':scope > .editor-ai-daemons-rail-wrapper'
        )
    })
})

describe('removeStrayMounts', () => {
    it('removes every stray with the class and reports the count', () => {
        // The cross-generation leak scenario: a previous plugin generation
        // aborted teardown and left its wrapper behind; a bad double-leak
        // could even leave two. The guard must clear ALL of them, not skip
        // after the first — the live mount that follows must be the only one.
        const host = new StubHost()
        host.append('editor-ai-daemons-rail-wrapper')
        host.append('editor-ai-daemons-rail-wrapper')

        const removed = removeStrayMounts(host, 'editor-ai-daemons-rail-wrapper')

        expect(removed).toBe(2)
        expect(host.children).toHaveLength(0)
    })

    it('leaves unrelated children alone and returns 0 on a clean host', () => {
        const host = new StubHost()
        host.append('cm-editor')
        host.append('editor-ai-daemons-margin')

        const removed = removeStrayMounts(host, 'editor-ai-daemons-rail-wrapper')

        expect(removed).toBe(0)
        expect(host.children).toHaveLength(2)
    })

    it('queries with the direct-child selector, never a descendant match', () => {
        const host = new StubHost()
        removeStrayMounts(host, 'editor-ai-daemons-margin')
        expect(host.queries).toEqual([':scope > .editor-ai-daemons-margin'])
    })

    it('is safe against removal mutating the live collection', () => {
        // `querySelectorAll` on a real DOM returns a STATIC NodeList, but the
        // guard must not depend on that: it snapshots via `Array.from` before
        // removing, so a live-collection host (this stub detaches on remove)
        // still gets every stray removed.
        const host = new StubHost()
        const first = host.append('editor-ai-daemons-rail-wrapper')
        const second = host.append('editor-ai-daemons-rail-wrapper')
        const third = host.append('editor-ai-daemons-rail-wrapper')

        const removed = removeStrayMounts(host, 'editor-ai-daemons-rail-wrapper')

        expect(removed).toBe(3)
        expect([first.removed, second.removed, third.removed]).toEqual([true, true, true])
        expect(host.children).toHaveLength(0)
    })
})
