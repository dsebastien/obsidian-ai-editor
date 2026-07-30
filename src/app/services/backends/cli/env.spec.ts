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
        const env = buildCliEnv({ platform: 'posix', sourceEnv: SOURCE, runDir: '/tmp/run-1' })
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

    it('has no way to add a variable: the input carries nothing user-supplied', () => {
        // The pass-through list this module used to accept had no caller and
        // no setting behind it, so it was removed rather than left as a door
        // with no lock on it. Whatever a user configures, an API key in their
        // shell environment is not forwarded — the tools authenticate from
        // their own login under HOME.
        const env = buildCliEnv({ platform: 'posix', sourceEnv: SOURCE, runDir: '/tmp/run-1' })
        expect(env['ANTHROPIC_API_KEY']).toBeUndefined()
        expect(env['LD_PRELOAD']).toBeUndefined()
    })

    it('forwards HOME and PATH — the tool finds its own credentials and sub-tools', () => {
        const env = buildCliEnv({ platform: 'posix', sourceEnv: SOURCE, runDir: '/tmp/run-1' })
        expect(env['HOME']).toBe('/home/seb')
        expect(env['PATH']).toBe('/usr/bin:/bin')
    })

    it('points the child temp directory at the run directory instead of the system one', () => {
        const posix = buildCliEnv({ platform: 'posix', sourceEnv: SOURCE, runDir: '/tmp/run-1' })
        expect(posix['TMPDIR']).toBe('/tmp/run-1')
        const win = buildCliEnv({
            platform: 'win32',
            sourceEnv: { SystemRoot: 'C:\\Windows', TEMP: 'C:\\Users\\seb\\AppData\\Local\\Temp' },
            runDir: 'C:\\Temp\\run-1'
        })
        expect(win['TEMP']).toBe('C:\\Temp\\run-1')
        expect(win['TMP']).toBe('C:\\Temp\\run-1')
    })

    it('disables colour so ANSI escapes cannot corrupt the JSON protocol', () => {
        const env = buildCliEnv({ platform: 'posix', sourceEnv: SOURCE, runDir: '/tmp/run-1' })
        expect(env['NO_COLOR']).toBe('1')
        expect(env['TERM']).toBe('dumb')
    })

    it('cannot be poisoned through a prototype-shaped variable name in the source', () => {
        const env = buildCliEnv({
            platform: 'posix',
            sourceEnv: { ...SOURCE, ['__proto__']: '{"polluted":true}' },
            runDir: '/tmp/run-1'
        })
        expect(Object.keys(env)).not.toContain('__proto__')
        expect(({} as Record<string, unknown>)['polluted']).toBeUndefined()
    })

    it('forwards the Windows variables process creation needs', () => {
        const env = buildCliEnv({
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
        expect(env['SystemRoot']).toBe('C:\\Windows')
        expect(env['USERPROFILE']).toBe('C:\\Users\\seb')
        expect(env['PATHEXT']).toBe('.COM;.EXE')
        expect(env['GITHUB_TOKEN']).toBeUndefined()
        // HOME is the POSIX spelling and is not part of the Windows allowlist.
        expect(env['HOME']).toBeUndefined()
    })
})
