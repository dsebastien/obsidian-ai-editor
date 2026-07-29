import { describe, expect, test } from 'bun:test'
import {
    ASSETS_SRC,
    BANNER,
    DIST,
    EXTERNAL_MODULES,
    PLUGIN_ID,
    SRC,
    STYLES_OUT,
    STYLES_SRC
} from './build'

describe('build constants', () => {
    test('SRC is set to src', () => {
        expect(SRC).toBe('src')
    })

    test('DIST is set to dist', () => {
        expect(DIST).toBe('dist')
    })

    test('ASSETS_SRC is set to src/assets', () => {
        expect(ASSETS_SRC).toBe('src/assets')
    })

    test('STYLES_SRC is set to src/styles.src.css', () => {
        expect(STYLES_SRC).toBe('src/styles.src.css')
    })

    test('STYLES_OUT is set to dist/styles.css', () => {
        expect(STYLES_OUT).toBe('dist/styles.css')
    })

    test('PLUGIN_ID matches package.json name', async () => {
        const packageJson = (await Bun.file('package.json').json()) as { name: string }
        expect(PLUGIN_ID).toBe(packageJson.name)
    })

    test('BANNER contains expected text', () => {
        expect(BANNER).toContain('GENERATED/BUNDLED FILE BY BUN')
        expect(BANNER).toContain('github repository')
    })
})

describe('stylesheet ↔ runtime class contract', () => {
    /**
     * The What's New modal (src/app/ui/whats-new-modal.ts) builds its class
     * names at runtime from `manifest.id` (`${id}-whats-new-*`). The
     * stylesheet must target that exact prefix — a stale template prefix
     * (e.g. `my-plugin-`) ships dead rules and an unstyled dialog.
     */
    test('whats-new selectors use the manifest.id prefix', async () => {
        const manifest = (await Bun.file('manifest.json').json()) as { id: string }
        const styles = await Bun.file(STYLES_SRC).text()
        expect(styles).toContain(`.${manifest.id}-whats-new-dialog`)
        expect(styles).toContain(`.${manifest.id}-whats-new-notes`)
        expect(styles).not.toContain('my-plugin-')
    })

    /**
     * Tailwind preflight is a GLOBAL reset (`*{margin:0;border:0 solid}`,
     * `html` font defaults, `:root` theme variables) — Obsidian applies
     * styles.css app-wide, so shipping it breaks the app and community
     * themes (plugin guideline: no global styles). The source must never
     * import 'tailwindcss' wholesale (which includes preflight.css).
     */
    test('styles source never imports tailwind preflight', async () => {
        const styles = await Bun.file(STYLES_SRC).text()
        expect(styles).not.toContain("@import 'tailwindcss';")
        expect(styles).not.toContain('tailwindcss/preflight')
    })
})

describe('EXTERNAL_MODULES', () => {
    test('includes obsidian', () => {
        expect(EXTERNAL_MODULES).toContain('obsidian')
    })

    test('includes electron', () => {
        expect(EXTERNAL_MODULES).toContain('electron')
    })

    test('includes codemirror modules', () => {
        expect(EXTERNAL_MODULES).toContain('@codemirror/autocomplete')
        expect(EXTERNAL_MODULES).toContain('@codemirror/state')
        expect(EXTERNAL_MODULES).toContain('@codemirror/view')
    })

    test('includes lezer modules', () => {
        expect(EXTERNAL_MODULES).toContain('@lezer/common')
        expect(EXTERNAL_MODULES).toContain('@lezer/highlight')
        expect(EXTERNAL_MODULES).toContain('@lezer/lr')
    })

    test('has expected number of external modules', () => {
        expect(EXTERNAL_MODULES.length).toBe(13)
    })
})
