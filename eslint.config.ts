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
                activeDocument: 'readonly',
                // Bun's global, used by specs for Bun.sleep()
                Bun: 'readonly'
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
            // Obsidian methods are dynamically added to prototypes
            '@typescript-eslint/no-unsafe-enum-comparison': 'off',
            'no-prototype-builtins': 'off',
            // `window.confirm` is forbidden by AGENTS.md and is not used
            // anywhere; the rule stays off only because the word "confirm"
            // appears in method names of the Modal subclasses that replace it.
            'no-alert': 'off',
            // NOTE (BR #20, 2026-08-04): no `obsidianmd/*` rule is disabled
            // here, per-file, or inline. The catalog reviewer runs its OWN
            // ruleset against the source archive, so a local disable hides the
            // finding from us without suppressing anything on their side.
            // Rules that fire get fixed in the code.
            //
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
