/**
 * The bridge between Obsidian's declarative settings API (issue #35) and this
 * plugin's settings storage.
 *
 * A `SettingDefinitionControl` addresses its value by a single opaque string
 * `key`, which the framework hands back to `getControlValue` /
 * `setControlValue` on the setting tab. Our settings are a nested, zod-parsed,
 * immutably-updated object — not a flat bag — so the key is read here as a DOT
 * PATH into `PluginSettingsV1` (`behavior.daemonIdleSeconds`,
 * `voiceProfile.followLinks`).
 *
 * Dot paths are stringly-typed, which is the one thing this arrangement gives
 * up versus the imperative tabs' direct property access. The guard is
 * `control-bindings.spec.ts`, which walks every key the settings tab actually
 * declares and asserts it resolves against the parsed defaults — so a typo is
 * a failing test, not a control that silently reads `undefined` forever.
 *
 * Writes go through the facade's Immer `update`, the same single persistence
 * path every other settings surface uses. Nothing here parses or validates:
 * `update` runs the value through `pluginSettingsSchema` exactly as it does
 * for an imperative edit, so an out-of-range write is rejected there and the
 * stored settings never leave a state the schema would refuse.
 */

import type { Draft } from 'immer'
import type { PluginSettingsV1 } from '../domain/settings/settings-schema'

/** A dot path addressing one scalar inside `PluginSettingsV1`. */
export type ControlKey = string

/**
 * Reads the value at `key`, or `undefined` when the path does not resolve.
 *
 * `undefined` is also what the framework treats as "fall back to
 * `defaultValue`", so an unresolvable path degrades to the declared default
 * rather than throwing mid-render. The spec is what stops that degradation
 * from going unnoticed.
 */
export function readControlValue(settings: PluginSettingsV1, key: ControlKey): unknown {
    let current: unknown = settings
    for (const segment of key.split('.')) {
        if (current === null || typeof current !== 'object') {
            return undefined
        }
        current = (current as Record<string, unknown>)[segment]
    }
    return current
}

/**
 * Writes `value` at `key` into an Immer draft.
 *
 * Refuses to create missing intermediate objects: every path this plugin
 * declares addresses a field the schema already defines, so a missing parent
 * means the key is wrong — and silently materializing it would produce a
 * settings object that fails `pluginSettingsSchema` on the very next parse,
 * turning a typo into a persistence error far from its cause. Returns whether
 * the write landed so callers can surface the miss.
 */
export function writeControlValue(
    draft: Draft<PluginSettingsV1>,
    key: ControlKey,
    value: unknown
): boolean {
    const segments = key.split('.')
    const leaf = segments.pop()
    if (leaf === undefined || leaf === '') {
        return false
    }
    let current: unknown = draft
    for (const segment of segments) {
        if (current === null || typeof current !== 'object') {
            return false
        }
        current = (current as Record<string, unknown>)[segment]
    }
    if (current === null || typeof current !== 'object' || !(leaf in current)) {
        return false
    }
    ;(current as Record<string, unknown>)[leaf] = value
    return true
}

/**
 * Every control key a definition tree declares, in declaration order.
 *
 * Walks the same `SettingDefinitionItem` shapes the settings tab returns, but
 * types them structurally rather than importing Obsidian's types — this file
 * stays importable from `bun test`, where the `obsidian` module does not
 * exist. The spec uses it to check the whole tree at once.
 */
export function collectControlKeys(items: readonly unknown[]): string[] {
    const keys: string[] = []
    const visit = (node: unknown): void => {
        if (node === null || typeof node !== 'object') {
            return
        }
        const record = node as Record<string, unknown>
        const control = record['control']
        if (control !== null && typeof control === 'object') {
            const key = (control as Record<string, unknown>)['key']
            if (typeof key === 'string') {
                keys.push(key)
            }
        }
        for (const child of [record['items'], record['page']]) {
            if (Array.isArray(child)) {
                for (const entry of child) {
                    visit(entry)
                }
            }
        }
    }
    for (const item of items) {
        visit(item)
    }
    return keys
}
