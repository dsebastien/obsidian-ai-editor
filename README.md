# AI Editor

An [Obsidian](https://obsidian.md) plugin that brings AI editing, reviewing, and QA **into the editor itself** — not a chat sidebar, but configurable AI personas ("Editors") and groups of them ("Panels") that highlight what they care about in your text, argue with you, and propose surgical edits you accept or reject inline.

- **Editors**: AI personas (Concision Editor, Devil's Advocate, Fact Checker…) you define with a prompt — typed directly or sourced from your own vault notes.
- **Panels**: groups of 1-n editors producing an aggregated scorecard: verdicts, top fixes, dissenting opinions.
- **Review loop**: summon your editors, watch findings land as highlighted spans, triage them with keyboard-first accept/reject, push back and argue, refine suggestions.
- **Actions**: rephrase, critique, say more, find evidence, identify assumptions — each bound to the editor or panel of your choice, plus your own custom actions (name, instruction, and whether the answer rewrites the selection, is inserted at the cursor, or comes back as findings).
- **Async margin comments**: select text, leave a question, and an editor answers it in the background while you keep writing. The comment lives in a column beside the text, aligned with the line it is about, and survives note switches and restarts — a comment whose text you edited away is kept and shown with its quote, never silently dropped.
- **Vault as configuration**: point personas, panels, and your voice/style profile at vault notes — documenting your assistant in your vault IS configuring the plugin.
- **Portable configuration**: export the editors, panels, actions, rules, and voice profile you built to a JSON file (API keys never included) and import them into another vault, after confirming exactly what will be added.
- **Bring your own backend**: direct LLM APIs (Anthropic, OpenAI, OpenRouter and other compatibles, Azure AI Foundry, Ollama) or agent CLIs (Claude Code, Codex) running on your own machine, behind the security boundary described below. Desktop-only.
- **Guided setup**: a first-run wizard walks you through a backend, your editors, your voice profile, and when editors run — with a **Test connection** check that sends one real request through the same path a review takes, so a green light means reviews will actually work. Nothing is saved until the last step, and it is re-runnable any time.

Nothing ever runs automatically: every AI action is user-initiated, and every change goes through a visible diff. The one opt-in exception is **daemon mode** — a settings toggle (off by default) that lets your editors watch your edits and refresh their recommendations after you pause; every refresh calls your configured backends, so the toggle states the cost implication plainly.

> Status: early development. See `documentation/plans/` for the implementation plan.

## CLI backends: the security model first

A CLI backend runs a **program on your computer** with your note content on its standard input. That is the highest-risk thing this plugin does, so the containment comes before the feature:

- **No shell, ever.** The tool is started with an argument array. No command line is assembled, so there is no quoting rule to get wrong and no metacharacter to escape.
- **You name the exact binary.** An absolute path to an existing, executable file. A bare name or a relative path is refused: it would be resolved through `PATH` or the working directory, and a writable directory ahead of the real one would silently turn "review this note" into "run whatever is called `claude` today".
- **Your note never appears in arguments.** It travels on standard input only. Arguments are world-readable in `ps` on a shared machine; notes are not.
- **A throwaway working directory.** Created per run, owner-only, unpredictable name, deleted when the run ends. Never your vault, and deliberately not the plugin's own folder either — that lives inside the vault and syncs.
- **An environment built from empty.** Only what the tool cannot start without: a home directory so it can find its own login, a `PATH` for its sub-tools, a locale, and a temporary directory pointing inside the throwaway folder. Nothing else in Obsidian's environment travels with the request, and there is no setting that can add to the list.
- **No session on disk.** Both tools are run with session persistence off (`--no-session-persistence`, `--ephemeral`), so a review does not save a resumable transcript of your note.
- **No inherited MCP servers, for Claude Code.** `--strict-mcp-config` is passed and no MCP config is, so the servers you configured elsewhere are not loaded. **Codex is different**, and this is worth knowing before you allow it: its own `~/.codex/config.toml` IS read — that is where your provider, endpoint and model live, and ignoring it would silently redirect the run away from the setup you tested — so any `[mcp_servers.*]` you declared there is loaded too.
- **Every run ends with the whole process tree killed**, verified rather than assumed — including a run that finished normally, because an agent that exits successfully can leave a helper behind. When something survives, the run is reported as failed rather than passed off as a success.

**What the plugin does NOT bound**, stated plainly because you are being asked to allow a program to run:

- **Each tool's own configuration is loaded.** For Claude Code that means your `CLAUDE.md`, skills, plugins, hooks and `settings.json` — including any pre-approved permission rules in it, which `--permission-mode manual` does not override. For Codex it means `~/.codex/config.toml`. Suppressing those would break authentication or silently change which model answers, so the plugin does not; what it can do is tell you.
- **Codex runs under `--sandbox read-only`; Claude Code has no sandbox flag to run under.** Its containment here is the throwaway working directory, the empty environment, and — unless your own settings pre-approve tools — a permission mode nothing can answer.

On top of that, **two separate consents**, both revocable:

1. **Allowed to run** — a dialog that states, before anything starts, that a program will be launched on your computer with your note on its standard input, names the exact file, and says you are responsible for what that program does. Until you agree, the backend is skipped by every run, however its enable toggle reads.
2. **Tool and research mode** — a second, stronger, separate act: the agent may read and write files and reach the network on your behalf. Off by default. Turning it off later leaves the backend working. Offered only for a tool where the plugin can actually switch it off (Claude Code); Codex says so plainly instead of showing a toggle that would do nothing.

Consent records **which executable** you agreed to. Change the path — or import settings, or sync `data.json` from another machine — and the earlier agreement no longer applies; you are asked again about the program that is actually there.

Windows note: both tools install there as `.cmd` shims, which this plugin refuses to run (running one means running `cmd.exe`). Point the setting at a real `.exe` or use an API backend.

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

<!-- other-plugins:start -->

## My other Obsidian plugins

| Plugin                                                                                                        | What it does                                                                                                                                  |
| ------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| [Agentic Resource Discovery Server](https://github.com/dsebastien/obsidian-agentic-resource-discovery-server) | Local-first Agentic Resource Discovery publisher and registry that serves your AI skills and tools to agents over a local HTTP and MCP server |
| [Book Exporter](https://github.com/dsebastien/obsidian-book-exporter)                                         | Export books (one manifest note + linked chapter notes) to EPUB and PDF via Pandoc                                                            |
| [Bookshelf Base](https://github.com/dsebastien/obsidian-bookshelf)                                            | Display your notes as a visual bookshelf via a custom Bases view                                                                              |
| [Dataview Serializer](https://github.com/dsebastien/obsidian-dataview-serializer)                             | Serialize Dataview queries to Markdown, and keep the Markdown representation up to date                                                       |
| [Expander](https://github.com/dsebastien/obsidian-expander)                                                   | Replace variables across your vault using HTML comment markers. Supports static values and dynamic functions                                  |
| [Ghost Publish](https://github.com/dsebastien/obsidian-ghost-publish)                                         | Publish your vault notes to a Ghost blog with configurable presets for tags, newsletters, and frontmatter conventions                         |
| [Graph Explorer Base View](https://github.com/dsebastien/obsidian-graph-explorer-base-view)                   | A custom Bases view that renders notes as an interactive force-directed graph with explored/unexplored tracking                               |
| [Hidden Folders Access](https://github.com/dsebastien/obsidian-hidden-folders-access)                         | Index hidden root-level folders (e.g. .claude) so they appear in the file tree, metadata cache, and Bases                                     |
| [Journal Bases](https://github.com/dsebastien/obsidian-journal-base)                                          | Custom Base views for journaling and periodic reviews                                                                                         |
| [Kanban Action Planner](https://github.com/dsebastien/obsidian-kanban-action-planner)                         | Render your notes as configurable Kanban boards and calendars inside Bases, with statuses, ordering, relationships, and scheduling            |
| [Life Tracker](https://github.com/dsebastien/obsidian-life-tracker-base-view)                                 | Capture and visualize the data that matters in your life                                                                                      |
| [Note Village](https://github.com/dsebastien/obsidian-note-village)                                           | A 2D pixel art village where your notes become villagers you can explore and chat with using AI                                               |
| [Obsidian Starter Kit](https://github.com/DeveloPassion/obsidian-starter-kit-plugin)                          | Adds strong typing support and powerful automation support for notes                                                                          |
| [Remarkable Synchronizer](https://github.com/dsebastien/obsidian-remarkable-sync)                             | Connect to the reMarkable cloud, list, download, and sync notebook pages as images                                                            |
| [Replicate](https://github.com/dsebastien/obsidian-replicate)                                                 | Use AI models with ease via the Replicate.com integration                                                                                     |
| [REST and MCP server](https://github.com/dsebastien/obsidian-cli-rest)                                        | Exposes CLI commands as RESTful API endpoints and an MCP server for AI tool integration                                                       |
| [Time Machine](https://github.com/dsebastien/obsidian-time-machine)                                           | Browse, compare, and restore previous versions of your notes using built-in file-recovery snapshots                                           |
| [Transcriber](https://github.com/dsebastien/obsidian-transcriber)                                             | Transcribe images to markdown using Ollama vision models                                                                                      |
| [Typefully](https://github.com/dsebastien/obsidian-typefully)                                                 | Publish social media posts with ease using the Typefully integration                                                                          |
| [Update Time](https://github.com/dsebastien/obsidian-update-time)                                             | Automatically update front matter to include creation and last update times                                                                   |

Everything I build is documented in [my newsletter](https://dsebastien.net/newsletter) and on [my YouTube channel](https://youtube.com/@dsebastien).

<!-- other-plugins:end -->

<!-- support-cta -->

## News & support

To stay up to date about this plugin, Obsidian in general, Personal Knowledge Management and note-taking:

- Subscribe to [my newsletter](https://dsebastien.net/newsletter)
- Subscribe to [my YouTube channel](https://youtube.com/@dsebastien)
- Join the [Knowii community](https://www.store.dsebastien.net/product/knowii-community/) and learn to organize your notes and put your knowledge to work, together with fellow knowledge workers

If this plugin is useful to you, here are the best ways to support my work ❤️:

- [Join the Knowii community](https://www.store.dsebastien.net/product/knowii-community/)
- [Become a GitHub Sponsor](https://github.com/sponsors/dsebastien)
- [Buy me a coffee](https://www.buymeacoffee.com/dsebastien)
- [Subscribe to my YouTube channel](https://youtube.com/@dsebastien)
- [Check out my products](https://store.dsebastien.net)

Found a bug or have an idea? [Open an issue](https://github.com/dsebastien/obsidian-ai-editor/issues).
