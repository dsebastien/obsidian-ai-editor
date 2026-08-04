---
title: Install and quick start
nav_order: 2
---

# Install and quick start

## Requirements

- Obsidian **1.12.2** or newer.
- **Desktop only** (Windows, macOS, Linux). The plugin declares `isDesktopOnly: true`; it does not run on mobile.
- At least one AI backend you can reach: a hosted API key, a local Ollama server, or an agent CLI installed on the same machine.
- The `editor-ai-daemons:*` [command-line integration](command-line.md) needs the same 1.12.2 — it is the release that added the API.

## Install

### Community plugins

Once the plugin is available in the community catalog:

1. Go to **Settings → Community plugins**.
2. Disable **Restricted mode** if it is enabled.
3. Select **Browse**, search for **AI Editor**, install it, then enable it.

### Manual installation

1. Download `main.js`, `manifest.json` and `styles.css` from the [latest release](https://github.com/dsebastien/obsidian-ai-editor/releases).
2. Copy them into `<Vault>/.obsidian/plugins/editor-ai-daemons/`.
3. Reload Obsidian and enable **AI Editor** in **Settings → Community plugins**.

### BRAT (bleeding edge)

[BRAT](https://github.com/TfTHacker/obsidian42-brat) installs plugins straight from a GitHub repository and keeps them updated. Expect breakage.

1. Install **Obsidian42 - BRAT** from **Settings → Community plugins → Browse** and enable it.
2. Run **BRAT: Add a beta plugin for testing** from the command palette.
3. Paste `https://github.com/dsebastien/obsidian-ai-editor`.
4. Enable **AI Editor** in **Settings → Community plugins**.

## The setup wizard

The wizard opens by itself the first time the plugin loads. It has six steps and you can leave at any of them.

1. **Welcome** — what the plugin does, and where API keys are stored.
2. **Backend** — pick a provider, paste a key, name a model, and select **Test connection**.
3. **Editors** — which of the seeded personas are on.
4. **Voice profile** — optional vault notes describing how you write.
5. **When editors run** — summoned only (default) or [daemon mode](daemon-mode.md), with the cost implication stated.
6. **Summary** — what was configured, and whether it can actually run a review.

**Nothing is written until the last step.** The wizard edits a draft and applies it as one update, so cancelling at any point leaves your settings exactly as they were. The single exception is the flag that records that the wizard has had its chance, so a dismissed wizard is not re-offered on every launch.

Re-run it whenever you like: **Settings → AI Editor → Behavior → Setup → Run setup wizard**, or the **Run setup wizard** command. A re-run seeds its draft from your current settings, so a second pass edits rather than resets. The wizard adds a backend; it never edits an existing one.

### Test connection

The backend step can check a backend before you rely on it. It sends one small request through the exact same path a real review takes, so a pass means reviews will work — not just that the endpoint answers. Three answers are possible:

- **Connection works** — you are done.
- **Reached, but not usable** — the key and the endpoint are fine, but the model did not answer in the structure the plugin needs. Try a stronger model.
- **Failed** — credentials, network, timeout, or configuration. The message says which.

The check uses a 60-second timeout of its own rather than your configured request timeout. A local model that is still loading can time out here and work fine for real reviews; the message tells you when that is what happened.

## Doing it by hand

1. **Settings → AI Editor → Backends → Add backend**. Pick a provider, fill in what it needs, save. See [Set up a backend](backends.md).
2. Set it as the **Global default backend**, or assign it to individual editors.
3. Make sure at least one editor is enabled under **Editors** — six are seeded on first load.
4. Open a note and run **Review current note** from the command palette, or select **Review** on the persona rail in the top-right corner of the editor.

## What gets seeded on first load

Six editors, one panel, and default action bindings — all fully editable, all deletable.

| Editor                  | What it looks for                                                 |
| ----------------------- | ----------------------------------------------------------------- |
| Concision Editor        | Padding, hedging, sentences that can lose half their words        |
| Devil's Advocate        | Weak arguments, unsupported leaps, the obvious counterexample     |
| Fact Checker            | Claims that need a source, a number, or a qualification           |
| Flow & Structure Editor | Order, transitions, paragraphs that fight the reader              |
| Humanizer               | Machine-generated fingerprints: uniform rhythm, inflated phrasing |
| Beginner Reader         | Undefined jargon, skipped reasoning steps, unstated prerequisites |

The **Pre-publish review** panel bundles Devil's Advocate, Flow & Structure Editor, Beginner Reader and Humanizer behind one charter: _is this ready to publish under the author's name?_

Default action bindings: rephrase, summarize and simplify → Concision Editor; humanize → Humanizer; critique and identify assumptions → Devil's Advocate; find evidence → Fact Checker. **Continue writing** and **Say more** are deliberately left unbound — no seeded persona is an authorial voice, so any default would be a bad one.

Seeding happens once and never overwrites anything you already configured.

## Next

- [Set up a backend](backends.md)
- [Review a note](usage.md)
- [Privacy and security](privacy-and-security.md)
