import { describe, expect, it } from 'bun:test'
import { isAbsoluteExecutablePath, validateExecutablePath } from './executable'
import type { ExecutableProbe } from './executable'

/**
 * The executable gate. These specs pin the refusals rather than the successes:
 * the whole point of the module is that a path the user did not fully specify
 * never reaches the OS.
 */

function probe(
    overrides: Partial<{ isFile: boolean; exists: boolean; executable: boolean }> = {}
): ExecutableProbe {
    const exists = overrides.exists ?? true
    const isFile = overrides.isFile ?? true
    const executable = overrides.executable ?? true
    return {
        statFile: () => (exists ? { isFile } : null),
        isExecutable: () => executable
    }
}

describe('isAbsoluteExecutablePath', () => {
    it('accepts a rooted POSIX path and rejects everything else', () => {
        expect(isAbsoluteExecutablePath('posix', '/usr/local/bin/claude')).toBe(true)
        expect(isAbsoluteExecutablePath('posix', 'claude')).toBe(false)
        expect(isAbsoluteExecutablePath('posix', './claude')).toBe(false)
        expect(isAbsoluteExecutablePath('posix', '../bin/claude')).toBe(false)
        expect(isAbsoluteExecutablePath('posix', 'C:\\tools\\claude.exe')).toBe(false)
    })

    it('accepts drive-qualified and UNC paths on Windows', () => {
        expect(isAbsoluteExecutablePath('win32', 'C:\\tools\\claude.exe')).toBe(true)
        expect(isAbsoluteExecutablePath('win32', 'c:/tools/claude.exe')).toBe(true)
        expect(isAbsoluteExecutablePath('win32', '\\\\server\\share\\claude.exe')).toBe(true)
        expect(isAbsoluteExecutablePath('win32', '\\tools\\claude.exe')).toBe(false)
        expect(isAbsoluteExecutablePath('win32', 'claude.exe')).toBe(false)
    })
})

describe('validateExecutablePath', () => {
    it('accepts an absolute path to an existing executable file', () => {
        const result = validateExecutablePath({
            platform: 'posix',
            path: '  /usr/local/bin/claude  ',
            probe: probe()
        })
        expect(result).toEqual({ ok: true, path: '/usr/local/bin/claude' })
    })

    it('refuses an empty path', () => {
        const result = validateExecutablePath({ platform: 'posix', path: '   ', probe: probe() })
        expect(result.ok).toBe(false)
        expect(result.ok ? '' : result.code).toBe('empty')
    })

    it('refuses a bare command name — PATH is not trusted to decide what runs', () => {
        const result = validateExecutablePath({ platform: 'posix', path: 'claude', probe: probe() })
        expect(result.ok).toBe(false)
        expect(result.ok ? '' : result.code).toBe('not-absolute')
        expect(result.ok ? '' : result.message).toContain('PATH')
    })

    it('refuses a relative path', () => {
        const result = validateExecutablePath({
            platform: 'posix',
            path: './bin/claude',
            probe: probe()
        })
        expect(result.ok ? '' : result.code).toBe('not-absolute')
    })

    it('refuses a tilde path and says why', () => {
        const result = validateExecutablePath({
            platform: 'posix',
            path: '~/bin/claude',
            probe: probe()
        })
        expect(result.ok ? '' : result.code).toBe('not-absolute')
        expect(result.ok ? '' : result.message).toContain('shell')
    })

    it('refuses a path containing a NUL byte before touching the filesystem', () => {
        let probed = false
        const result = validateExecutablePath({
            platform: 'posix',
            path: '/usr/bin/claude\0/../../evil',
            probe: {
                statFile: () => {
                    probed = true
                    return { isFile: true }
                },
                isExecutable: () => true
            }
        })
        expect(result.ok ? '' : result.code).toBe('invalid-characters')
        expect(probed).toBe(false)
    })

    it('refuses a missing file', () => {
        const result = validateExecutablePath({
            platform: 'posix',
            path: '/usr/local/bin/claude',
            probe: probe({ exists: false })
        })
        expect(result.ok ? '' : result.code).toBe('not-found')
    })

    it('refuses a directory', () => {
        const result = validateExecutablePath({
            platform: 'posix',
            path: '/usr/local/bin',
            probe: probe({ isFile: false })
        })
        expect(result.ok ? '' : result.code).toBe('not-a-file')
    })

    it('refuses a file the user cannot execute', () => {
        const result = validateExecutablePath({
            platform: 'posix',
            path: '/usr/local/bin/claude',
            probe: probe({ executable: false })
        })
        expect(result.ok ? '' : result.code).toBe('not-executable')
    })

    it('refuses Windows scripts that would need a command interpreter', () => {
        for (const path of [
            'C:\\tools\\claude.cmd',
            'C:\\tools\\claude.BAT',
            'C:\\tools\\claude.ps1',
            'C:\\tools\\claude.js'
        ]) {
            const result = validateExecutablePath({ platform: 'win32', path, probe: probe() })
            expect(result.ok ? '' : result.code).toBe('needs-interpreter')
        }
    })

    it('accepts a Windows executable', () => {
        const result = validateExecutablePath({
            platform: 'win32',
            path: 'C:\\tools\\claude.exe',
            probe: probe()
        })
        expect(result).toEqual({ ok: true, path: 'C:\\tools\\claude.exe' })
    })

    it('does not mistake a dot in a directory name for an extension', () => {
        const result = validateExecutablePath({
            platform: 'win32',
            path: 'C:\\tools\\v1.2\\claude.exe',
            probe: probe()
        })
        expect(result.ok).toBe(true)
    })
})
