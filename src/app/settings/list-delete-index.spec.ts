/**
 * Regression guard for the list-delete stale-index race (adversarial review,
 * 2026-08-07).
 *
 * `SettingDefinitionList.onDelete(index)` hands back a row index. The row is
 * indexed against whatever the framework is CURRENTLY showing — and after a
 * drag, that is the reordered array, immediately. Our own re-render only lands
 * once the reorder has persisted through the facade, so there is a window in
 * which the definition tree still closes over the pre-drag snapshot.
 *
 * A page that resolves the doomed entity from that snapshot deletes the wrong
 * one. It is silent: the confirmation names the wrong entity, and for rules
 * (first-match-wins) it quietly reroutes reviews.
 *
 * So every list page must resolve the entity from the LIVE settings at click
 * time. These specs simulate the window directly — build the tree, reorder the
 * settings behind it, then fire `onDelete` with the index the framework would
 * now be using — and assert the right entity dies.
 */

import { describe, expect, it } from 'bun:test'
import { produce } from 'immer'
import type { App } from 'obsidian'
import { pluginSettingsSchema } from '../domain/settings/settings-schema'
import type { PluginSettingsV1 } from '../domain/settings/settings-schema'
import type { SettingsFacade } from './settings-facade'
import type { TabContext } from './tabs/shared'
import { ConfirmModal } from './components'
import { rulesPageItems } from './tabs/rules-tab'
import { backendsPageItems } from './tabs/backends-tab'

interface Harness {
    readonly ctx: TabContext
    readonly current: () => PluginSettingsV1
}

function harness(initial: PluginSettingsV1): Harness {
    let settings = initial
    const facade: SettingsFacade = {
        getSettings: () => settings,
        update: async (mutator) => {
            settings = produce(settings, mutator)
        },
        subscribe: () => () => {}
    }
    return {
        ctx: {
            app: {} as unknown as App,
            facade,
            refresh: () => {}
        },
        current: () => settings
    }
}

/** Walks the definition tree for the first list and returns its `onDelete`. */
function onDeleteOf(items: readonly unknown[]): (index: number) => void {
    for (const item of items) {
        const record = item as Record<string, unknown>
        if (record['type'] === 'list' && typeof record['onDelete'] === 'function') {
            return record['onDelete'] as (index: number) => void
        }
    }
    throw new Error('no list with onDelete in the definition tree')
}

const RULES = pluginSettingsSchema.parse({
    rules: [
        { id: 'rule-a', name: 'A', match: { matchType: 'folder', value: 'A' }, effect: 'disabled' },
        { id: 'rule-b', name: 'B', match: { matchType: 'folder', value: 'B' }, effect: 'disabled' }
    ]
})

const BACKENDS = pluginSettingsSchema.parse({
    backends: [
        {
            id: 'backend-a',
            family: 'api',
            kind: 'anthropic',
            label: 'A',
            apiKey: 'sk-a',
            defaultModel: 'm'
        },
        {
            id: 'backend-b',
            family: 'api',
            kind: 'anthropic',
            label: 'B',
            apiKey: 'sk-b',
            defaultModel: 'm'
        }
    ]
})

describe('rules list delete', () => {
    it('deletes the row the user pointed at, not the one the stale snapshot held', () => {
        const { ctx, current } = harness(RULES)
        const onDelete = onDeleteOf(rulesPageItems(ctx))

        // The drag persisted: A is now at index 1. The tree above still closes
        // over the pre-drag order, which is exactly the window under test.
        void ctx.facade.update((draft) => {
            draft.rules = [draft.rules[1], draft.rules[0]].filter(
                (rule): rule is NonNullable<typeof rule> => rule !== undefined
            )
        })
        expect(current().rules.map((rule) => rule.id)).toEqual(['rule-b', 'rule-a'])

        onDelete(1) // the framework's index for A after the move

        expect(current().rules.map((rule) => rule.id)).toEqual(['rule-b'])
    })

    it('deletes the right rule when nothing moved', () => {
        const { ctx, current } = harness(RULES)
        onDeleteOf(rulesPageItems(ctx))(0)
        expect(current().rules.map((rule) => rule.id)).toEqual(['rule-b'])
    })

    it('ignores an index past the end rather than deleting something else', () => {
        const { ctx, current } = harness(RULES)
        onDeleteOf(rulesPageItems(ctx))(9)
        expect(current().rules).toHaveLength(2)
    })
})

/**
 * Backends confirm before deleting, so the deletion itself is not observable
 * without driving a modal. What IS observable — and what the bug corrupted — is
 * which backend the flow RESOLVES: the confirmation named the wrong one, and
 * confirming then deleted it. `ConfirmModal.open` is the mocked no-op from
 * `test-setup.ts`, so replacing it captures the options the flow built.
 */
function captureConfirmation(run: () => void): { title: string; message: string } | null {
    // Reached through a plain-object view of the prototype: taking the method
    // off the class directly trips @typescript-eslint/unbound-method, and the
    // rule is right in general — here the whole point is to swap the slot.
    const prototype = ConfirmModal.prototype as unknown as {
        open: (this: { options: { title: string; message: string } }) => void
    }
    const original = prototype.open
    let captured: { title: string; message: string } | null = null
    prototype.open = function capture(this: { options: { title: string; message: string } }): void {
        captured = { title: this.options.title, message: this.options.message }
    }
    try {
        run()
    } finally {
        prototype.open = original
    }
    return captured
}

describe('backends list delete', () => {
    it('names the row the user pointed at after a reorder', () => {
        const { ctx, current } = harness(BACKENDS)
        const onDelete = onDeleteOf(backendsPageItems(ctx))

        // The drag persisted: backend A is now at index 1, while the tree above
        // still closes over the pre-drag order.
        void ctx.facade.update((draft) => {
            draft.backends = [draft.backends[1], draft.backends[0]].filter(
                (backend): backend is NonNullable<typeof backend> => backend !== undefined
            )
        })
        expect(current().backends.map((backend) => backend.label)).toEqual(['B', 'A'])

        const confirmation = captureConfirmation(() => {
            onDelete(1) // the framework's index for A after the move
        })

        expect(confirmation?.message).toContain('"A"')
        expect(confirmation?.message).not.toContain('"B"')
    })

    it('ignores an index past the end without asking anything', () => {
        const { ctx, current } = harness(BACKENDS)
        const confirmation = captureConfirmation(() => {
            onDeleteOf(backendsPageItems(ctx))(9)
        })
        expect(confirmation).toBeNull()
        expect(current().backends).toHaveLength(2)
    })
})
