import { describe, expect, it } from 'bun:test'
import { cliCandidatePaths, cliCommandName, detectCliExecutables, detectionSummary } from './detect'
import type { ExecutableProbe } from './executable'

const HOME = '/home/tester'

/** A filesystem where only the listed paths are executable files. */
function probeWith(present: readonly string[]): ExecutableProbe {
    const set = new Set(present)
    return {
        statFile: (path) => (set.has(path) ? { isFile: true } : null),
        isExecutable: (path) => set.has(path)
    }
}

describe('cliCandidatePaths', () => {
    it('expands home-relative locations and keeps absolute ones', () => {
        const paths = cliCandidatePaths({ kind: 'claude-code', platform: 'posix', home: HOME }).map(
            (candidate) => candidate.path
        )
        expect(paths).toContain(`${HOME}/.local/bin/claude`)
        expect(paths).toContain('/usr/local/bin/claude')
        expect(paths.every((path) => path.startsWith('/'))).toBe(true)
    })

    it('prefers a user install over a system one', () => {
        const paths = cliCandidatePaths({ kind: 'codex', platform: 'posix', home: HOME }).map(
            (candidate) => candidate.path
        )
        expect(paths.indexOf(`${HOME}/.local/bin/codex`)).toBeLessThan(
            paths.indexOf('/usr/local/bin/codex')
        )
    })

    it('skips home-relative locations rather than guessing when home is unknown', () => {
        const paths = cliCandidatePaths({ kind: 'claude-code', platform: 'posix', home: '' }).map(
            (candidate) => candidate.path
        )
        expect(paths).not.toContain('/.local/bin/claude')
        expect(paths).toContain('/usr/local/bin/claude')
    })

    it('offers nothing on Windows, where the installed form is a .cmd shim', () => {
        // The boundary refuses .cmd/.bat outright; suggesting one would read as
        // a recommendation for something the plugin then refuses to run.
        expect(
            cliCandidatePaths({ kind: 'claude-code', platform: 'win32', home: 'C:\\Users\\t' })
        ).toEqual([])
    })

    it('never consults PATH — the list is fixed and readable', () => {
        const a = cliCandidatePaths({ kind: 'claude-code', platform: 'posix', home: HOME })
        const b = cliCandidatePaths({ kind: 'claude-code', platform: 'posix', home: HOME })
        expect(a).toEqual(b)
    })
})

describe('detectCliExecutables', () => {
    it('returns only locations that pass the boundary’s own gate', () => {
        const result = detectCliExecutables({
            kind: 'claude-code',
            platform: 'posix',
            home: HOME,
            probe: probeWith([`${HOME}/.local/bin/claude`])
        })
        expect(result.found.map((candidate) => candidate.path)).toEqual([
            `${HOME}/.local/bin/claude`
        ])
        expect(result.searched).toBeGreaterThan(1)
    })

    it('skips a path that exists but is not executable', () => {
        const result = detectCliExecutables({
            kind: 'claude-code',
            platform: 'posix',
            home: HOME,
            probe: {
                statFile: () => ({ isFile: true }),
                isExecutable: () => false
            }
        })
        expect(result.found).toEqual([])
    })

    it('skips a directory that happens to share the name', () => {
        const result = detectCliExecutables({
            kind: 'codex',
            platform: 'posix',
            home: HOME,
            probe: { statFile: () => ({ isFile: false }), isExecutable: () => true }
        })
        expect(result.found).toEqual([])
    })

    it('reports several finds in preference order', () => {
        const result = detectCliExecutables({
            kind: 'claude-code',
            platform: 'posix',
            home: HOME,
            probe: probeWith(['/usr/local/bin/claude', `${HOME}/.local/bin/claude`])
        })
        expect(result.found[0]?.path).toBe(`${HOME}/.local/bin/claude`)
    })
})

describe('detectionSummary', () => {
    it('names the single find and asks the user to check it', () => {
        const result = detectCliExecutables({
            kind: 'claude-code',
            platform: 'posix',
            home: HOME,
            probe: probeWith([`${HOME}/.local/bin/claude`])
        })
        const line = detectionSummary({ result, platform: 'posix', kind: 'claude-code' })
        expect(line).toContain(`${HOME}/.local/bin/claude`)
    })

    it('says which one it filled in when there are several', () => {
        const result = detectCliExecutables({
            kind: 'claude-code',
            platform: 'posix',
            home: HOME,
            probe: probeWith(['/usr/local/bin/claude', `${HOME}/.local/bin/claude`])
        })
        const line = detectionSummary({ result, platform: 'posix', kind: 'claude-code' })
        expect(line).toContain('Found 2')
        expect(line).toContain(`${HOME}/.local/bin/claude`)
    })

    it('points at the manual route when nothing is found', () => {
        const result = detectCliExecutables({
            kind: 'codex',
            platform: 'posix',
            home: HOME,
            probe: probeWith([])
        })
        const line = detectionSummary({ result, platform: 'posix', kind: 'codex' })
        expect(line).toContain('which codex')
    })

    it('explains the Windows limitation instead of reporting a failure', () => {
        const result = detectCliExecutables({
            kind: 'claude-code',
            platform: 'win32',
            home: 'C:\\Users\\t',
            probe: probeWith([])
        })
        expect(detectionSummary({ result, platform: 'win32', kind: 'claude-code' })).toContain(
            '.cmd'
        )
    })
})

describe('cliCommandName', () => {
    it('is what the user would type', () => {
        expect(cliCommandName('claude-code')).toBe('claude')
        expect(cliCommandName('codex')).toBe('codex')
    })
})
