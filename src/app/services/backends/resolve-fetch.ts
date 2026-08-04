/**
 * The one place a default `fetch` is resolved.
 *
 * Every service that dispatches to an API backend accepts an injected
 * `fetchImpl` (specs drive it; `Architecture.md` — Backends). This module owns
 * what happens when nothing is injected.
 *
 * Why it is not `globalThis.fetch` (BR #20, `obsidianmd/no-global-this`): in
 * production the plugin always runs inside a window, and a review dispatched
 * from a POPOUT must go through that window's own context — `globalThis` would
 * silently bind the main window's. Resolution is therefore deliberately
 * ordered, and lazy: it happens per call, because a popout can open after the
 * service module is first evaluated.
 *
 * There is deliberately NO bare-`fetch` arm: `no-restricted-globals` points the
 * unqualified global at `requestUrl`, which cannot stream (Architecture —
 * Backends), so the streaming transport has to come off a window. Headless
 * callers (`bun test`) therefore inject; resolving with no window and no
 * injection is a wiring bug and says so rather than reaching for a global.
 */

/** A `fetch` narrowed to what the backends actually call. */
export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>

/** The window-correct `fetch` for the CURRENT moment, or a wiring error. */
function windowFetch(): FetchFn {
    // Obsidian's popout-aware global: the window the user is actually in.
    if (typeof activeWindow !== 'undefined') {
        return activeWindow.fetch.bind(activeWindow)
    }

    // A browser/Electron context with no popout support (older Obsidian).
    if (typeof window !== 'undefined') {
        return window.fetch.bind(window)
    }

    throw new Error(
        'No fetch available: this runtime has no window, so a fetchImpl must be injected.'
    )
}

/**
 * Returns `injected` when a caller supplied one, otherwise a `fetch` that binds
 * to the active window ON CALL.
 *
 * Binding is deferred, not eager, for two reasons that happen to coincide:
 * a popout can open after the service module is first evaluated, and every
 * service resolves its transport at the TOP of a function whose next act may be
 * a refusal (an excluded note, a missing executable, a withheld CLI consent).
 * Those paths never dispatch, so they must not require a transport to exist —
 * a headless spec exercising a refusal would otherwise fail on the way in.
 */
export function resolveFetchImpl(injected?: FetchFn): FetchFn {
    if (injected) {
        return injected
    }
    return (input, init) => windowFetch()(input, init)
}
