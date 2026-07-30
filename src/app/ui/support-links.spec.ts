import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import {
    BUY_ME_A_COFFEE_URL,
    GITHUB_SPONSORS_URL,
    KNOWII_COMMUNITY_URL,
    NEWSLETTER_URL,
    YOUTUBE_CHANNEL_URL
} from './support-links'

/**
 * The support calls to action live on SEVEN surfaces, only two of which this
 * plugin's own code can reach (the settings tab and the "What's new" tab).
 * The other five are repository files that no compiler, no bundler and no
 * other test ever looks at: the manifest, two GitHub configuration files, the
 * release workflow, and the two markdown landing pages.
 *
 * Nothing links `support-links.ts` to any of them, so a URL changed in the one
 * place that calls itself the single source of truth would leave five surfaces
 * quietly pointing somewhere else — and the failure is invisible until a user
 * follows a dead link months later.
 *
 * These specs are that link. They read the repository files and assert that
 * every surface agrees with the constants above.
 */

/** `src/app/ui` → repository root. */
const REPO_ROOT = join(import.meta.dir, '..', '..', '..')

function readRepoFile(...segments: string[]): string {
    return readFileSync(join(REPO_ROOT, ...segments), 'utf8')
}

/** The block a `<!-- marker -->` owns: from the marker to the next `<!--`, or to the end. */
function blockAfterMarker(markdown: string, marker: string): string {
    const start = markdown.indexOf(marker)
    expect(start).toBeGreaterThanOrEqual(0)
    const rest = markdown.slice(start + marker.length)
    const next = rest.indexOf('<!--')
    return -1 === next ? rest : rest.slice(0, next)
}

const CTA_URLS = [
    KNOWII_COMMUNITY_URL,
    GITHUB_SPONSORS_URL,
    BUY_ME_A_COFFEE_URL,
    YOUTUBE_CHANNEL_URL,
    NEWSLETTER_URL
]

describe('support links', () => {
    test('every call to action is an https URL', () => {
        for (const url of CTA_URLS) {
            expect(url.startsWith('https://')).toBe(true)
        }
    })
})

describe('manifest funding', () => {
    // Obsidian renders one entry per key of `fundingUrl`, in the community
    // plugin browser and in the installed-plugin entry. A plain string
    // collapses that to a single link — the shape is the feature.
    const manifest = JSON.parse(readRepoFile('manifest.json')) as {
        fundingUrl?: unknown
    }

    test('fundingUrl is an object of labelled URLs, not a single string', () => {
        expect(typeof manifest.fundingUrl).toBe('object')
        expect(manifest.fundingUrl).not.toBeNull()
    })

    test('fundingUrl offers Knowii, GitHub Sponsors and Buy me a coffee', () => {
        const funding = manifest.fundingUrl as Record<string, string>
        expect(Object.values(funding)).toEqual([
            KNOWII_COMMUNITY_URL,
            GITHUB_SPONSORS_URL,
            BUY_ME_A_COFFEE_URL
        ])
    })
})

describe('GitHub funding configuration', () => {
    const funding = readRepoFile('.github', 'FUNDING.yml')

    test('the sponsor button names the GitHub and Buy me a coffee accounts', () => {
        expect(funding).toContain('github: [dsebastien]')
        expect(funding).toContain('buy_me_a_coffee: dsebastien')
    })

    test('the custom entries are live, not commented out', () => {
        // The template ships this line commented; leaving it that way drops
        // Knowii and the store from GitHub's sponsor dropdown entirely.
        expect(funding).toMatch(/^custom:/m)
        expect(funding).toContain(KNOWII_COMMUNITY_URL)
    })
})

describe('release footer', () => {
    const footer = readRepoFile('.github', 'release-footer.md')
    const workflow = readRepoFile('.github', 'workflows', 'release.yml')

    test('the footer does not open with a frontmatter fence', () => {
        // A markdown file starting with `---` is frontmatter to Prettier,
        // which reformats it. The separator is the workflow's job.
        expect(footer.startsWith('---')).toBe(false)
    })

    test('the footer links every call to action', () => {
        for (const url of CTA_URLS) {
            expect(footer).toContain(url)
        }
    })

    test('the release workflow appends the footer to the release body', () => {
        expect(workflow).toContain('cat .github/release-footer.md >> $GITHUB_OUTPUT')
        expect(workflow).toContain("printf '\\n---\\n\\n' >> $GITHUB_OUTPUT")
    })
})

describe.each([
    ['README.md', ['README.md']],
    ['docs/README.md', ['docs', 'README.md']]
])('%s support block', (_label, segments) => {
    const markdown = readRepoFile(...segments)
    const block = blockAfterMarker(markdown, '<!-- support-cta -->')

    test('the marker owns a "News & support" section', () => {
        expect(block).toContain('## News & support')
    })

    test('the block links every call to action', () => {
        for (const url of CTA_URLS) {
            expect(block).toContain(url)
        }
    })
})

describe.each([
    ['README.md', ['README.md']],
    ['docs/README.md', ['docs', 'README.md']]
])('%s cross-promotion block', (_label, segments) => {
    const markdown = readRepoFile(...segments)

    test('the block is delimited at both ends', () => {
        const start = markdown.indexOf('<!-- other-plugins:start -->')
        const end = markdown.indexOf('<!-- other-plugins:end -->')
        expect(start).toBeGreaterThanOrEqual(0)
        expect(end).toBeGreaterThan(start)
    })

    test('the block does not cross-promote this plugin', () => {
        const start = markdown.indexOf('<!-- other-plugins:start -->')
        const end = markdown.indexOf('<!-- other-plugins:end -->')
        const table = markdown.slice(start, end)
        expect(table).not.toContain('obsidian-ai-editor')
    })
})

describe('documentation site footer', () => {
    const config = readRepoFile('docs', '_config.yml')

    test('footer_content carries the calls to action on every page', () => {
        expect(config).toContain('footer_content:')
        for (const url of [
            KNOWII_COMMUNITY_URL,
            GITHUB_SPONSORS_URL,
            BUY_ME_A_COFFEE_URL,
            YOUTUBE_CHANNEL_URL
        ]) {
            expect(config).toContain(url)
        }
    })
})
