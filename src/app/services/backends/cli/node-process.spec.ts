import { describe, expect, it } from 'bun:test'
import type { ExecutableProbe } from './executable'
import { resolveTaskkillPath, taskkillEnv } from './node-process'

/**
 * The Windows kill path's own gate.
 *
 * `taskkill.exe` is the second program this folder starts, and for a while it
 * was the only one that skipped every rule the folder is built around: its
 * path was assembled by string concatenation from `SystemRoot`/`windir` — two
 * values that come from the renderer's environment, which nothing else here
 * trusts — and it inherited the full Obsidian environment because no `env` was
 * passed. These specs pin the fix. They run on any platform: the resolution is
 * pure over an injected probe.
 */

const SYSTEM32 = 'C:\\Windows\\System32\\taskkill.exe'

/** A filesystem where exactly the listed paths are runnable programs. */
function probeFor(...runnable: readonly string[]): ExecutableProbe {
    const set = new Set(runnable)
    return {
        statFile: (path) => (set.has(path) ? { isFile: true } : null),
        isExecutable: (path) => set.has(path)
    }
}

describe('resolveTaskkillPath', () => {
    it('uses SystemRoot when it points at a real taskkill', () => {
        expect(resolveTaskkillPath({ SystemRoot: 'C:\\Windows' }, probeFor(SYSTEM32))).toBe(
            SYSTEM32
        )
    })

    it('ignores a poisoned SystemRoot instead of running whatever it names', () => {
        // The attack the old code allowed: a writable directory laid out to
        // look like System32 redirects the kill at an arbitrary binary, which
        // then ran with the renderer's whole environment.
        const evil = 'C:\\Users\\seb\\evil'
        const resolved = resolveTaskkillPath(
            { SystemRoot: evil, windir: 'C:\\Windows' },
            // The evil path exists but is NOT executable, so it fails the same
            // gate the user's configured tool passes.
            {
                statFile: (path) =>
                    path === SYSTEM32 || path.startsWith(evil) ? { isFile: true } : null,
                isExecutable: (path) => path === SYSTEM32
            }
        )
        expect(resolved).toBe(SYSTEM32)
    })

    it('falls back to the literal system location when the environment names nothing usable', () => {
        expect(resolveTaskkillPath({ SystemRoot: '', windir: undefined }, probeFor(SYSTEM32))).toBe(
            SYSTEM32
        )
    })

    it('returns null rather than guessing when no candidate is a program', () => {
        // A machine with no taskkill is one where a tree cannot be terminated.
        // Saying so lets `isAlive` report `survived`, which the caller surfaces
        // — better than spawning something that is not taskkill.
        expect(resolveTaskkillPath({ SystemRoot: 'C:\\Windows' }, probeFor())).toBeNull()
    })

    it('refuses a relative SystemRoot the way every other executable path is refused', () => {
        expect(
            resolveTaskkillPath(
                { SystemRoot: 'Windows' },
                probeFor('Windows\\System32\\taskkill.exe')
            )
        ).toBeNull()
    })
})

describe('taskkillEnv', () => {
    it('gives taskkill the two variables Windows needs and nothing else', () => {
        // Not the renderer's environment: taskkill is invoked by absolute path
        // and reads nothing from it, so inheriting tokens was pure downside.
        expect(taskkillEnv(SYSTEM32)).toEqual({
            SystemRoot: 'C:\\Windows',
            windir: 'C:\\Windows'
        })
    })

    it('derives the root from the validated path, not from the environment', () => {
        expect(taskkillEnv('D:\\Win\\System32\\taskkill.exe')['SystemRoot']).toBe('D:\\Win')
    })
})
