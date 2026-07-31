---
title: Overview
nav_order: 1
permalink: /
---

# AI Editor

AI editing, reviewing and QA **inside the Obsidian editor** — not a chat sidebar. Configurable AI personas ("Editors") and groups of them ("Panels") highlight what they care about in your text, argue with you, and propose surgical edits you accept or reject inline.

Nothing runs on its own, and nothing is written without a diff. Desktop only. Bring your own backend.

## Key features

- **Editors** — AI personas you define with a prompt. Six ship with the plugin, all editable.
- **Panels** — groups of editors that review together and produce one scorecard: overall verdict, per-member verdicts, ranked top fixes, and where they disagreed.
- **Review loop** — findings anchored to the exact words they quote, triaged from the keyboard, with push-back replies when you disagree.
- **Actions** — rephrase, summarize, simplify, humanize, continue writing, say more, critique, find evidence, identify assumptions, plus your own custom verbs.
- **Margin comments** — park a question on a passage and keep writing; the answer arrives in a column beside the text and survives restarts.
- **Vault as configuration** — personas, charters and voice profile can live in your own notes, read fresh at every run.
- **Bring your own backend** — Anthropic, OpenAI, OpenRouter, OpenAI-compatible endpoints, Azure OpenAI, Ollama, or the Claude Code and Codex CLIs running locally.

## Quick start

1. Install the plugin and enable it (see [Install and quick start](install.md)).
2. The **setup wizard** opens on first load: add a backend, select **Test connection**, choose your editors, point at a voice profile, decide when editors run. Nothing is saved until the last step.
3. Open a note and run **Review current note**.
4. Click a highlight to read a finding; **Accept** or **Dismiss** it.

## The guide

| Page                                            | What it covers                                                                     |
| ----------------------------------------------- | ---------------------------------------------------------------------------------- |
| [Install and quick start](install.md)           | Requirements, install routes, the setup wizard, what gets seeded                   |
| [Set up a backend](backends.md)                 | Providers, models, thinking modes, timeouts, test connection                       |
| [Review a note](usage.md)                       | The rail, findings, cards, keyboard triage, bulk operations                        |
| [Create and tune editors](editors.md)           | Personas, prompts, context, capabilities, the voice profile                        |
| [Run actions on a selection](actions.md)        | Built-in verbs, inline diffs, custom actions                                       |
| [Work with panels](panels.md)                   | Charters, scorecards, partial failures                                             |
| [Margin comments](margin-comments.md)           | Parked questions answered in the background                                        |
| [Binding rules](rules.md)                       | Per-folder, per-tag, per-note-type routing and kill switches                       |
| [Daemon mode](daemon-mode.md)                   | Automatic refreshes, and what they cost                                            |
| [CLI backends](cli-backends.md)                 | Claude Code and Codex, and their security model                                    |
| [The command line](command-line.md)             | `editor-ai-daemons:review`, `editor-ai-daemons:status`, `editor-ai-daemons:cancel` |
| [Move settings between vaults](transfer.md)     | Export, import, what never travels                                                 |
| [Privacy and security](privacy-and-security.md) | What is sent, what is excluded, where keys live                                    |
| [Configuration reference](configuration.md)     | Every setting, its default, every command                                          |
| [Tips and best practices](tips.md)              | Getting good results without burning tokens                                        |
| [Troubleshooting](troubleshooting.md)           | Timeouts, CORS, unusable answers, unanchored findings                              |

## About

Created by [Sébastien Dubois](https://dsebastien.net). Source on [GitHub](https://github.com/dsebastien/obsidian-ai-editor).

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
