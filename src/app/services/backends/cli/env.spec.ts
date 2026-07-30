import { describe, expect, it } from 'bun:test'
import { buildCliEnv } from './env'

/**
 * The environment allowlist. The load-bearing spec is the first one: whatever
 * else changes here, an unrelated secret sitting in `process.env` must not
 * reach the child.
 */

const SOURCE = {
    HOME: '/home/seb',
    PATH: '/usr/bin:/bin',
    LANG: 'en_US.UTF-8',
    // Everything below must NOT be forwarded.
    AWS_SECRET_ACCESS_KEY: 'aws-secret',
    GITHUB_TOKEN: 'gh-secret',
    NODE_OPTIONS: '--require /tmp/evil.js',
    LD_PRELOAD: '/tmp/evil.so',
    SSH_AUTH_SOCK: '/tmp/ssh-agent',
    ANTHROPIC_API_KEY: 'sk-configured'
} as const

describe('buildCliEnv', () => {
    it('starts from nothing — unrelated secrets in the source environment do not reach the child', () => {
        const result = buildCliEnv({ platform: 'posix', sourceEnv: SOURCE, runDir: '/tmp/run-1' })
        expect(result.ok).toBe(true)
        const env = result.ok ? result.env : {}
        expect(Object.keys(env).sort()).toEqual([
            'HOME',
            'LANG',
            'NO_COLOR',
            'PATH',
            'TERM',
            'TMPDIR'
        ])
        expect(JSON.stringify(env)).not.toContain('aws-secret')
        expect(JSON.stringify(env)).not.toContain('gh-secret')
        expect(env['NODE_OPTIONS']).toBeUndefined()
        expect(env['SSH_AUTH_SOCK']).toBeUndefined()
    })

    it('forwards HOME and PATH — the tool finds its own credentials and sub-tools', () => {
        const result = buildCliEnv({ platform: 'posix', sourceEnv: SOURCE, runDir: '/tmp/run-1' })
        expect(result.ok ? result.env['HOME'] : '').toBe('/home/seb')
        expect(result.ok ? result.env['PATH'] : '').toBe('/usr/bin:/bin')
    })

    it('points the child temp directory at the run directory instead of the system one', () => {
        const posix = buildCliEnv({ platform: 'posix', sourceEnv: SOURCE, runDir: '/tmp/run-1' })
        expect(posix.ok ? posix.env['TMPDIR'] : '').toBe('/tmp/run-1')
        const win = buildCliEnv({
            platform: 'win32',
            sourceEnv: { SystemRoot: 'C:\\Windows', TEMP: 'C:\\Users\\seb\\AppData\\Local\\Temp' },
            runDir: 'C:\\Temp\\run-1'
        })
        expect(win.ok ? win.env['TEMP'] : '').toBe('C:\\Temp\\run-1')
        expect(win.ok ? win.env['TMP'] : '').toBe('C:\\Temp\\run-1')
    })

    it('disables colour so ANSI escapes cannot corrupt the JSON protocol', () => {
        const result = buildCliEnv({ platform: 'posix', sourceEnv: SOURCE, runDir: '/tmp/run-1' })
        expect(result.ok ? result.env['NO_COLOR'] : '').toBe('1')
        expect(result.ok ? result.env['TERM'] : '').toBe('dumb')
    })

    it('forwards explicitly configured API-key variables by value', () => {
        const result = buildCliEnv({
            platform: 'posix',
            sourceEnv: SOURCE,
            passThroughNames: ['ANTHROPIC_API_KEY'],
            runDir: '/tmp/run-1'
        })
        expect(result.ok ? result.env['ANTHROPIC_API_KEY'] : '').toBe('sk-configured')
    })

    it('skips a configured variable that is not set rather than defaulting it', () => {
        const result = buildCliEnv({
            platform: 'posix',
            sourceEnv: SOURCE,
            passThroughNames: ['NOT_SET_ANYWHERE'],
            runDir: '/tmp/run-1'
        })
        expect(result.ok).toBe(true)
        expect(result.ok ? 'NOT_SET_ANYWHERE' in result.env : true).toBe(false)
    })

    it('refuses a configured variable that injects code or redirects the tool', () => {
        for (const name of [
            'LD_PRELOAD',
            'DYLD_INSERT_LIBRARIES',
            'NODE_OPTIONS',
            'BASH_ENV',
            'PATH',
            'HTTPS_PROXY',
            'GIT_SSH_COMMAND',
            'TMPDIR'
        ]) {
            const result = buildCliEnv({
                platform: 'posix',
                sourceEnv: SOURCE,
                passThroughNames: [name],
                runDir: '/tmp/run-1'
            })
            expect(result.ok).toBe(false)
            expect(result.ok ? '' : result.code).toBe('denied-name')
        }
    })

    it('matches the denied list case-insensitively', () => {
        const result = buildCliEnv({
            platform: 'posix',
            sourceEnv: { ld_preload: '/tmp/evil.so' },
            passThroughNames: ['ld_preload'],
            runDir: '/tmp/run-1'
        })
        expect(result.ok ? '' : result.code).toBe('denied-name')
    })

    it('refuses a malformed variable name', () => {
        for (const name of ['', '1KEY', 'MY KEY', 'MY-KEY', 'A'.repeat(200)]) {
            const result = buildCliEnv({
                platform: 'posix',
                sourceEnv: SOURCE,
                passThroughNames: [name],
                runDir: '/tmp/run-1'
            })
            expect(result.ok ? '' : result.code).toBe('invalid-name')
        }
    })

    it('cannot be poisoned through a prototype-shaped variable name', () => {
        const result = buildCliEnv({
            platform: 'posix',
            sourceEnv: SOURCE,
            passThroughNames: ['__proto__'],
            runDir: '/tmp/run-1'
        })
        // Refused as a name (leading underscores are legal, but the value is
        // absent) — what matters is that nothing on Object.prototype moved.
        expect(result.ok).toBe(true)
        expect(({} as Record<string, unknown>)['polluted']).toBeUndefined()
    })

    it('forwards the Windows variables process creation needs', () => {
        const result = buildCliEnv({
            platform: 'win32',
            sourceEnv: {
                SystemRoot: 'C:\\Windows',
                SystemDrive: 'C:',
                ComSpec: 'C:\\Windows\\system32\\cmd.exe',
                USERPROFILE: 'C:\\Users\\seb',
                APPDATA: 'C:\\Users\\seb\\AppData\\Roaming',
                PATHEXT: '.COM;.EXE',
                PATH: 'C:\\Windows',
                HOME: '/home/seb',
                GITHUB_TOKEN: 'gh-secret'
            },
            runDir: 'C:\\Temp\\run-1'
        })
        const env = result.ok ? result.env : {}
        expect(env['SystemRoot']).toBe('C:\\Windows')
        expect(env['USERPROFILE']).toBe('C:\\Users\\seb')
        expect(env['PATHEXT']).toBe('.COM;.EXE')
        expect(env['GITHUB_TOKEN']).toBeUndefined()
        // HOME is the POSIX spelling and is not part of the Windows allowlist.
        expect(env['HOME']).toBeUndefined()
    })
})
