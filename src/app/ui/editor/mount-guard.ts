/**
 * Idempotence guard for per-view UI mounts (rail wrapper, margin column).
 *
 * Why it exists: mounts can leak ACROSS plugin generations. If `onunload`
 * aborts before `ReviewController.dispose()` runs (Obsidian's
 * `Plugins.disablePlugin` catches the throw, logs `Plugin failure`, and still
 * marks the plugin disabled), the dead generation's rail wrapper stays inside
 * the view's `contentEl`. The next enable (hot-reload, plugin update) starts a
 * fresh controller with an EMPTY glue map, so the keyed-map guard in
 * `syncGlues` cannot see the zombie — and `createGlue` would mount a second
 * rail on the same content element: two rails per pane, the dead one frozen at
 * its last collapsed state.
 *
 * The guard REMOVES strays instead of adopting them: a stray belongs to a dead
 * controller (dead listeners, dead subscriptions, stale state) and must never
 * be reused by the live one.
 */

/**
 * The slice of `Element` the guard needs. Structural on purpose: Bun's test
 * runner has no DOM, and this shape is trivially stubbed in specs while
 * `HTMLElement` satisfies it for free (`Array.from` only needs `ArrayLike`).
 */
export interface StrayMountHost {
    querySelectorAll(selector: string): ArrayLike<{ remove(): void }>
}

/**
 * `:scope >` — DIRECT children only. A nested markdown view (embed, hover
 * popover) owns its own mounts; reaching into descendants would tear down a
 * live rail that belongs to someone else.
 */
export function strayMountSelector(className: string): string {
    return `:scope > .${className}`
}

/**
 * Removes every direct child of `host` carrying `className`. Returns how many
 * were removed so callers can log the anomaly (any non-zero count means a
 * previous generation's teardown aborted mid-way).
 */
export function removeStrayMounts(host: StrayMountHost, className: string): number {
    const strays = Array.from(host.querySelectorAll(strayMountSelector(className)))
    for (const stray of strays) {
        stray.remove()
    }
    return strays.length
}
