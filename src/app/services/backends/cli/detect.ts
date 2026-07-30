import type { ExecutableProbe } from './executable'
import { validateExecutablePath } from './executable'
import type { CliPlatform } from './platform'
import type { CliToolKind } from './tools'

/**
 * "Detect" for the executable-path field: looks in a fixed list of well-known
 * install locations and reports what is actually there.
 *
 * Two things this deliberately does NOT do:
 *
 * - **It never runs anything.** Detection asks the filesystem whether a path
 *   is an executable file, and stops. Running `claude --version` to confirm
 *   would mean starting a program the user has not consented to yet, which is
 *   the exact act the consent dialog exists to gate.
 * - **It never consults `PATH`.** Scanning `PATH` would find more, and would
 *   also faithfully surface whatever a writable directory ahead of the real
 *   one happens to contain — presented to the user as "found Claude Code
 *   here", one click from consent. `executable.ts` refuses PATH resolution for
 *   the same reason; a suggestion list is not a safe place to reintroduce it.
 *
 * So detection is a convenience over a curated list, and the answer is always
 * a concrete absolute path the user can read before agreeing to it. Finding
 * nothing is a normal outcome, not a failure: the field stays hand-editable.
 */

/** One place worth looking, with `~` meaning the user's home directory. */
interface CandidateTemplate {
    readonly template: string
    /** What this location is, for the "found it here" line. */
    readonly origin: string
}

/**
 * Where each tool's official installers put the binary on POSIX systems.
 *
 * Order is the order results are reported in, most-specific first: a
 * user-local install is a deliberate act and beats a system-wide one, which
 * is why `~/.local/bin` comes before `/usr/local/bin`.
 */
const POSIX_CANDIDATES: Record<CliToolKind, readonly CandidateTemplate[]> = {
    'claude-code': [
        { template: '~/.local/bin/claude', origin: 'user install' },
        { template: '~/.claude/local/claude', origin: 'local install' },
        { template: '~/.bun/bin/claude', origin: 'bun global' },
        { template: '~/.volta/bin/claude', origin: 'volta' },
        { template: '/opt/homebrew/bin/claude', origin: 'Homebrew (Apple silicon)' },
        { template: '/usr/local/bin/claude', origin: 'system' },
        { template: '/usr/bin/claude', origin: 'system' }
    ],
    'codex': [
        { template: '~/.local/bin/codex', origin: 'user install' },
        { template: '~/.bun/bin/codex', origin: 'bun global' },
        { template: '~/.volta/bin/codex', origin: 'volta' },
        { template: '~/.cargo/bin/codex', origin: 'cargo' },
        { template: '/opt/homebrew/bin/codex', origin: 'Homebrew (Apple silicon)' },
        { template: '/usr/local/bin/codex', origin: 'system' },
        { template: '/usr/bin/codex', origin: 'system' }
    ]
}

export interface CliCandidate {
    readonly path: string
    readonly origin: string
}

/**
 * The absolute paths worth probing for one tool on one platform.
 *
 * **Windows returns nothing, on purpose.** Both tools install on Windows as
 * npm shims (`claude.cmd`, `codex.cmd`), and the security boundary refuses
 * `.cmd`/`.bat` outright because running one means running `cmd.exe` and
 * re-inheriting the command-line quoting rules the boundary exists to avoid
 * (see `executable.ts`). Offering candidates the plugin would then refuse
 * would be worse than offering none — the user would read a suggestion as a
 * recommendation. A Windows user who has a real `.exe` can still paste its
 * path; nothing here blocks that.
 *
 * `home` is only used to expand `~`; when it is empty, the home-relative
 * candidates are skipped rather than being resolved to something surprising.
 */
export function cliCandidatePaths(input: {
    readonly kind: CliToolKind
    readonly platform: CliPlatform
    readonly home: string
}): readonly CliCandidate[] {
    if (input.platform === 'win32') {
        return []
    }
    const home = input.home.replace(/\/+$/, '')
    const candidates: CliCandidate[] = []
    for (const candidate of POSIX_CANDIDATES[input.kind]) {
        if (candidate.template.startsWith('~/')) {
            if (home.length === 0) {
                continue
            }
            candidates.push({
                path: `${home}/${candidate.template.slice(2)}`,
                origin: candidate.origin
            })
            continue
        }
        candidates.push({ path: candidate.template, origin: candidate.origin })
    }
    return candidates
}

export interface CliDetectionResult {
    /** Everything that exists AND passes the boundary's executable gate. */
    readonly found: readonly CliCandidate[]
    /** How many locations were looked at, for the "nothing found" message. */
    readonly searched: number
}

/**
 * Probes the candidate list and returns the usable ones.
 *
 * Usable means "would pass `validateExecutablePath`", i.e. the same gate the
 * spawn applies — a suggestion the plugin would later refuse is not a
 * suggestion, it is a trap.
 */
export function detectCliExecutables(input: {
    readonly kind: CliToolKind
    readonly platform: CliPlatform
    readonly home: string
    readonly probe: ExecutableProbe
}): CliDetectionResult {
    const candidates = cliCandidatePaths(input)
    const found = candidates.filter(
        (candidate) =>
            validateExecutablePath({
                platform: input.platform,
                path: candidate.path,
                probe: input.probe
            }).ok
    )
    return { found, searched: candidates.length }
}

/** The command name a user would type to find the tool themselves. */
export function cliCommandName(kind: CliToolKind): string {
    return kind === 'claude-code' ? 'claude' : 'codex'
}

/**
 * What the settings dialog says after a detection run. Pure, so the wording is
 * spec-pinned rather than living in a modal.
 *
 * Every branch ends by pointing at the manual route, because detection failing
 * is not the same as the tool being absent and the user must not read it that
 * way.
 */
export function detectionSummary(input: {
    readonly result: CliDetectionResult
    readonly platform: CliPlatform
    readonly kind: CliToolKind
}): string {
    const first = input.result.found[0]
    if (first !== undefined) {
        if (input.result.found.length === 1) {
            return `Found one: ${first.path} (${first.origin}). Check it, then save.`
        }
        return `Found ${input.result.found.length}. Filled in ${first.path} (${first.origin}); pick another below if that is the wrong one.`
    }
    if (input.platform === 'win32') {
        return (
            'Detection is not available on Windows: these tools install as .cmd shims, which ' +
            'this plugin refuses to run. Paste the full path to a real .exe instead.'
        )
    }
    return `Nothing found in ${input.result.searched} common locations. Run “which ${cliCommandName(input.kind)}” in a terminal and paste what it prints.`
}
