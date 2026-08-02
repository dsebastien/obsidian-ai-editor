import eslint from '@eslint/js'
import tseslint from 'typescript-eslint'
import eslintConfigPrettier from 'eslint-config-prettier'
import globals from 'globals'
import obsidianmd from 'eslint-plugin-obsidianmd'
import { defineConfig } from 'eslint/config'

export default defineConfig([
    eslint.configs.recommended,
    ...tseslint.configs.recommended,
    ...obsidianmd.configs['recommended'],
    eslintConfigPrettier,
    {
        // `registerCliHandler` (1.12.2) is RUNTIME-GUARDED at its one
        // registration site: `Platform.isDesktop &&
        // requireApiVersion('1.12.2')` in plugin.ts. minAppVersion stays
        // 1.8.7 so everything else serves older installs — documented in the
        // community-review checklist § minAppVersion. 0.4.1 forbids inline
        // obsidianmd disables, so the exemption lives here, scoped to the two
        // files whose whole purpose is that API.
        files: ['src/app/cli/register-review-cli.ts', 'src/app/cli/register-run-cli.ts'],
        rules: {
            'obsidianmd/no-unsupported-api': 'off'
        }
    },
    {
        // The declarative settings API (1.13's `getSettingDefinitions`, for
        // settings search) is tracked as its own backlog issue; the tab
        // predates it and serves minAppVersion 1.8.7.
        files: ['src/app/settings/settings-tab.ts'],
        rules: {
            'obsidianmd/settings-tab/prefer-setting-definitions': 'off'
        }
    },
    {
        ignores: [
            '**/dist/**',
            '**/node_modules/**',
            'scripts/**',
            '.cz-config.cjs',
            'prettier.config.cjs',
            'package.json'
        ]
    },
    {
        files: ['**/*.{js,mjs,cjs,ts}'],
        languageOptions: {
            globals: {
                ...globals.node,
                ...globals.browser,
                // Obsidian global functions
                createDiv: 'readonly',
                createEl: 'readonly',
                createSpan: 'readonly',
                createFragment: 'readonly',
                // Obsidian popout-window-aware globals
                activeWindow: 'readonly',
                activeDocument: 'readonly'
            },
            parserOptions: {
                projectService: true,
                tsconfigRootDir: import.meta.dirname
            }
        },
        rules: {
            '@typescript-eslint/no-require-imports': 'off',
            // The community-plugin reviewer treats both the rule violation
            // and any `eslint-disable @typescript-eslint/no-explicit-any` as
            // an ERROR that blocks the scorecard. Catch locally as error,
            // not warn. See AGENTS.md "Community catalog review".
            '@typescript-eslint/no-explicit-any': 'error',
            '@typescript-eslint/no-unused-vars': [
                'error',
                { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }
            ],
            '@typescript-eslint/ban-ts-comment': 'off',
            '@typescript-eslint/no-deprecated': 'off',
            // These are too strict for dynamic plugin APIs
            '@typescript-eslint/no-unsafe-call': 'off',
            '@typescript-eslint/no-unsafe-member-access': 'off',
            '@typescript-eslint/no-unsafe-assignment': 'off',
            // Obsidian methods are dynamically added to prototypes
            '@typescript-eslint/no-unsafe-enum-comparison': 'off',
            'no-prototype-builtins': 'off',
            // `window.confirm` is forbidden by AGENTS.md and is not used
            // anywhere; the rule stays off only because the word "confirm"
            // appears in method names of the Modal subclasses that replace it.
            'no-alert': 'off',
            // Three 0.4.1 style-preference rules conflict with this repo's
            // documented architecture and are switched off DELIBERATELY
            // (community-review checklist § Lint currency, 2026-08-02):
            //
            // - `prefer-create-el` wants Obsidian's prototype helpers
            //   (`doc.win.createEl`). The rail, cards, margin column and
            //   transform preview are deliberately PLAIN DOM: every element
            //   is created via the owning view's `ownerDocument` (the rule's
            //   actual popout concern), and the whole UI layer is unit-tested
            //   against stub documents where Obsidian's prototype extensions
            //   do not exist. Rewriting to the helpers would trade tested
            //   code for untestable code.
            'obsidianmd/prefer-create-el': 'off',
            // - `prefer-window-timers` fires in the SERVICE layer (retry
            //   backoff, debounced sidecar writers, abort composition) which
            //   is Obsidian-free by design and runs in the main window; every
            //   UI-layer timer already uses `window.*` per AGENTS.md, and the
            //   services take injected timer functions precisely so specs can
            //   drive them.
            'obsidianmd/prefer-window-timers': 'off',
            // - `no-global-this` fires on the service layer's
            //   `globalThis.fetch` DEFAULTS, which are unreachable fallbacks
            //   for headless tests: every production dispatch injects
            //   `window.fetch.bind(window)` (checklist § Logging/network).
            'obsidianmd/no-global-this': 'off',
            // Sentence case is a community-review requirement, so the rule is
            // an ERROR here rather than off. It compares every UI string
            // against a word list, so the vocabulary this plugin's copy uses
            // has to be declared or correct text is reported:
            //
            // - `brands` REPLACES the plugin's default list (`?? DEFAULT_BRANDS`),
            //   so this array must carry every brand this codebase names, the
            //   plugin's own included. A new brand in a UI string is reported
            //   until it is added here — loud, which is the point.
            // - `ignoreWords` covers single tokens that are literal UI labels
            //   quoted inside prose ("Select **Test connection** again"), key
            //   names, and one environment variable. Only consulted for tokens
            //   after the first, so a sentence must not OPEN with one.
            // - `ignoreRegex` matches whole strings: placeholder fragments that
            //   are not sentences, a frontmatter key that must stay lowercase,
            //   and the fleet-wide newsletter line kept byte-identical with
            //   `obsidian-plugin-template`.
            //
            // Every entry below is justified in
            // `documentation/community-review-checklist.md` § Sentence case.
            'obsidianmd/ui/sentence-case': [
                'error',
                {
                    enforceCamelCaseLower: true,
                    brands: [
                        // Defaults this codebase relies on
                        'Obsidian',
                        'Obsidian Sync',
                        'Obsidian Publish',
                        'iCloud',
                        'iOS',
                        'macOS',
                        'Windows',
                        'Linux',
                        'Android',
                        'GitHub',
                        'Git',
                        'YouTube',
                        'Markdown',
                        'JavaScript',
                        'TypeScript',
                        'Node.js',
                        'GitHub Sponsors',
                        // The side panel's tab title is a name (its own
                        // exemption used to be two now-forbidden inline
                        // disables — the vocabulary IS the config, 0.4.1).
                        'AI Editor Review',
                        // Backends, tools and products this plugin names
                        'AI Editor',
                        'Anthropic',
                        'Azure OpenAI',
                        'Claude',
                        'Claude Code',
                        'Codex',
                        'Knowii',
                        'LM Studio',
                        'Ollama',
                        'OpenAI',
                        'OpenRouter'
                    ],
                    ignoreWords: [
                        // Literal UI labels quoted inside prose
                        'Actions',
                        'Backends',
                        'Default',
                        'Disable',
                        'Editors',
                        'Inject',
                        'None',
                        'Test',
                        // Literal Azure query-parameter name
                        'api-version',
                        // Key names
                        'Enter',
                        'Esc',
                        // Environment variable
                        'PATH'
                    ],
                    ignoreRegex: [
                        // Placeholder fragments, not sentences
                        '^e\\.g\\. ',
                        // Absolute / home-relative path placeholders. The
                        // rule only skips paths that carry a file extension,
                        // and an executable usually has none.
                        '^[/~]',
                        // Frontmatter key — lowercase is the contract
                        'ai_editor',
                        // Fleet-wide template copy, kept byte-identical
                        'Personal Knowledge Management'
                    ]
                }
            ]
        }
    }
])
