# AI Editor

An [Obsidian](https://obsidian.md) plugin that brings AI editing, reviewing, and QA **into the editor itself** — not a chat sidebar, but configurable AI personas ("Editors") and groups of them ("Panels") that highlight what they care about in your text, argue with you, and propose surgical edits you accept or reject inline.

- **Editors**: AI personas (Concision Editor, Devil's Advocate, Fact Checker…) you define with a prompt — typed directly or sourced from your own vault notes.
- **Panels**: groups of 1-n editors producing an aggregated scorecard: verdicts, top fixes, dissenting opinions.
- **Review loop**: summon your editors, watch findings land as highlighted spans, triage them with keyboard-first accept/reject, push back and argue, refine suggestions.
- **Actions**: rephrase, critique, say more, find evidence, identify assumptions — each bound to the editor or panel of your choice, plus your own custom actions (name, instruction, and whether the answer rewrites the selection, is inserted at the cursor, or comes back as findings).
- **Async margin comments**: select text, leave an instruction, and a background agent works on it while you keep writing.
- **Vault as configuration**: point personas, panels, and your voice/style profile at vault notes — documenting your assistant in your vault IS configuring the plugin.
- **Portable configuration**: export the editors, panels, actions, rules, and voice profile you built to a JSON file (API keys never included) and import them into another vault, after confirming exactly what will be added.
- **Bring your own backend**: direct LLM APIs (Anthropic, OpenAI, OpenRouter and other compatibles, Azure AI Foundry, Ollama) or agent CLIs (Claude Code, Codex). Desktop-only.
- **Guided setup**: a first-run wizard walks you through a backend, your editors, your voice profile, and when editors run — with a **Test connection** check that sends one real request through the same path a review takes, so a green light means reviews will actually work. Nothing is saved until the last step, and it is re-runnable any time.

Nothing ever runs automatically: every AI action is user-initiated, and every change goes through a visible diff. The one opt-in exception is **daemon mode** — a settings toggle (off by default) that lets your editors watch your edits and refresh their recommendations after you pause; every refresh calls your configured backends, so the toggle states the cost implication plainly.

> Status: early development. See `documentation/plans/` for the implementation plan.

## Inspiration

This plugin stands on the shoulders of two people:

- **[Maggie Appleton](https://maggieappleton.com)** — her [Language Model Sketchbook, or Why I Hate Chatbots](https://maggieappleton.com/lm-sketchbook) introduced _daemons_: background characters with distinct epistemic roles that live in the margins of your writing environment, suggest rather than impose, and can always be ignored. The core interaction philosophy of this plugin — bring the language model to the editing and thinking process instead of exiting into a chat interface — is hers.
- **[Juri Strumpflohner](https://juri.dev)** — his AI-first markdown writing editor demos showed what that philosophy looks like as a working tool: a persona rail, summoning reviewers, inline diff suggestions, push-back conversations, and async review comments:
    - [Built an AI-first markdown writing editor…](https://x.com/juristr/status/2074494746484236459)
    - [I'm starting to really like this flow of collaborative editing](https://x.com/juristr/status/2077036970895872368)
    - [I love my little reviewing tool…](https://x.com/juristr/status/2079297727364464700)

## Development

Built with [Bun](https://bun.sh/) and TypeScript, from the [Obsidian Plugin Template (Bun)](https://github.com/dsebastien/obsidian-plugin-template).

### Prerequisites

- [Bun](https://bun.sh/) (latest version)
- [Git](https://git-scm.com/)
- An Obsidian vault for testing (`OBSIDIAN_VAULT_LOCATION` env var)

### Commands

| Command             | Description                       |
| ------------------- | --------------------------------- |
| `bun install`       | Install dependencies              |
| `bun run dev`       | Development build with watch mode |
| `bun run build`     | Production build                  |
| `bun run tsc:watch` | Type check in watch mode          |
| `bun run lint`      | Run ESLint                        |
| `bun run format`    | Format with Prettier              |
| `bun test`          | Run tests                         |

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) for contribution guidelines.

## License

MIT License - see [LICENSE](./LICENSE) for details.

## News & Support

To stay up to date about this plugin, Obsidian in general, Personal Knowledge Management and note-taking, subscribe to [my newsletter](https://newsletter.dsebastien.net). Note that the best way to support my work is to become a paid subscriber ❤️.

If this plugin is useful to you, you can also [buy me a coffee](https://www.buymeacoffee.com/dsebastien) ☕
