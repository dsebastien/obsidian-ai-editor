import { describe, expect, it } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { behaviorSettingsSchema } from './settings-schema'

/**
 * Guard against a DEAD behavior toggle.
 *
 * Two settings shipped in the Behavior tab with a schema field, a control and a
 * documentation row — and no consumer anywhere (`stripFrontmatter`,
 * `responseLanguageOverride`). A toggle that claims to do something and does
 * nothing is worse than no toggle: it converts an informed decision into a
 * false one, and for a privacy control that is a defect, not a gap.
 *
 * So the rule is now mechanical: every key of `behaviorSettingsSchema` must be
 * READ somewhere that is neither the schema, nor the tab that renders it, nor
 * the settings transfer module (which copies fields wholesale and therefore
 * mentions all of them without using any). Adding a field without wiring it
 * fails here, at the moment it is added.
 *
 * Specs count as consumers on purpose — a field whose only reader is a spec is
 * still under-wired, but the spec's assertion tells you what it was meant to
 * do, and the false-negative risk of excluding them (a field used only through
 * an indirection this grep cannot see) is worse than the false-positive risk of
 * including them.
 */

const SRC_ROOT = join(import.meta.dir, '..', '..', '..')

/** Files that mention every field by construction and prove nothing. */
const EXCLUDED = [
    join('domain', 'settings', 'settings-schema.ts'),
    join('domain', 'settings', 'settings-transfer.ts'),
    join('settings', 'tabs', 'behavior-tab.ts'),
    join('domain', 'settings', 'behavior-settings-consumers.spec.ts')
]

function collectSources(dir: string, out: { path: string; text: string }[]): void {
    for (const entry of readdirSync(dir)) {
        const full = join(dir, entry)
        if (statSync(full).isDirectory()) {
            collectSources(full, out)
            continue
        }
        if (entry.endsWith('.ts')) {
            out.push({ path: full, text: readFileSync(full, 'utf8') })
        }
    }
}

describe('behavior settings have consumers', () => {
    it('reads every behavior field somewhere outside the schema, tab and transfer', () => {
        const sources: { path: string; text: string }[] = []
        collectSources(SRC_ROOT, sources)
        const candidates = sources.filter(
            (source) => !EXCLUDED.some((excluded) => source.path.endsWith(excluded))
        )
        expect(candidates.length).toBeGreaterThan(100)

        const orphans = Object.keys(behaviorSettingsSchema.shape).filter(
            (field) => !candidates.some((source) => source.text.includes(field))
        )
        expect(orphans).toEqual([])
    })
})
