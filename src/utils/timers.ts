/**
 * The one place a timer is obtained.
 *
 * `obsidianmd/prefer-window-timers` exists because a bare `setTimeout` binds to
 * the main window: a callback scheduled from a POPOUT keeps running against a
 * window the user may already have closed. Production must therefore schedule
 * off the active window.
 *
 * Note the asymmetry with `resolve-fetch`, which prefers `activeWindow`: for
 * TIMERS the rule wants `window` specifically and reports `activeWindow` just
 * as loudly (AGENTS.md, "API conventions"), so there is no active-window arm
 * here.
 *
 * The service layer (CLI spawn, kill escalation, transport deadlines) is
 * Obsidian-free by design and its specs run headless under `bun test`, where no
 * `window` exists at all — hence the Node fallback, which is an IMPORT rather
 * than a global and so carries no popout ambiguity to get wrong.
 *
 * Prefer injecting a timer where a spec needs to drive the clock (see
 * `CommentJobRegistry`'s `setTimer`/`clearTimer` seam); reach for this when the
 * timer is an implementation detail the caller should not have to supply.
 */
import { clearTimeout as clearNodeTimer, setTimeout as setNodeTimer } from 'node:timers'

/** Schedules `callback` after `ms`, returning a handle for `clearTimer`. */
export function setTimer(callback: () => void, ms: number): number {
    if (typeof window !== 'undefined') {
        return window.setTimeout(callback, ms)
    }
    return Number(setNodeTimer(callback, ms))
}

/** Cancels a handle from `setTimer`. Safe to call after the timer has fired. */
export function clearTimer(handle: number): void {
    if (typeof window !== 'undefined') {
        window.clearTimeout(handle)
        return
    }
    clearNodeTimer(handle)
}

/** Resolves after `ms`. The awaitable form of `setTimer`. */
export function sleep(ms: number): Promise<void> {
    return new Promise<void>((resolve) => setTimer(resolve, ms))
}
