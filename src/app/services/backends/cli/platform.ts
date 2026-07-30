/**
 * The one platform vocabulary the CLI boundary reasons about.
 *
 * Every security decision in this folder branches on "Windows or not" and
 * nothing finer: process groups exist on POSIX and not on Windows, the home
 * directory is spelled differently, and only Windows has a shell-script
 * executable class that cannot be run without an interpreter. Narrowing
 * `process.platform`'s nine values to that one bit here means the branch is a
 * parameter every spec can set, instead of an ambient global no test can
 * change.
 */
export type CliPlatform = 'win32' | 'posix'

/** Maps `process.platform` (or any Node platform string) onto the one bit. */
export function toCliPlatform(nodePlatform: string): CliPlatform {
    return nodePlatform === 'win32' ? 'win32' : 'posix'
}

/** The platform this renderer is running on. */
export function currentCliPlatform(): CliPlatform {
    return toCliPlatform(process.platform)
}
