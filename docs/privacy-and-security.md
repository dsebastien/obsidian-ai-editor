---
title: Privacy and security
nav_order: 14
---

# Privacy and security

This plugin sends your writing to an AI model. Everything here is about making that predictable.

## Nothing runs on its own

Every backend request is triggered by an explicit action of yours: Review, an action verb, a push-back reply, a margin comment, a health check, a CLI invocation. There is no timer, no on-open hook, no on-save hook.

The one exception is **[daemon mode](daemon-mode.md)**, a settings toggle that is off by default. Turning it on _is_ the explicit permission for the automatic refreshes it performs, and its settings copy states the cost implication plainly.

## Nothing is written without a diff

Every AI-proposed change goes through a visible diff with **Accept** and **Reject**. There is no code path that writes AI output into a note without your confirmation.

A proposal may only be applied while the target text still equals the text it was computed against. Stale proposals are marked as such and must be regenerated — they are never fuzzily relocated onto text they were not written for.

Findings quote your text **verbatim**. A quote that cannot be located exactly, or that matches ambiguously, is shown as unanchored rather than guessed into a position.

## Privacy exclusions are absolute

**Settings → Editor AI Daemons → Behavior → Privacy exclusions.** Three ways to exclude a note:

| Mechanism       | How                                                        |
| --------------- | ---------------------------------------------------------- |
| **Folder**      | Add the folder path to **Excluded folders**                |
| **Tag**         | Add the tag (without `#`) to **Excluded tags**             |
| **Frontmatter** | Put `editor_ai_daemons: false` in the note (on by default) |

An excluded note is never sent to any backend — **not as the review target, not as attached linked context, and not through an explicit wikilink reference from another prompt**. Excluded notes are dropped from every source before their content is read.

This is stronger than a "[disable plugin](rules.md)" binding rule, which only removes the plugin's surfaces for a note and still allows it to be attached as context for another note's review.

## What actually gets sent

For an API backend, one request carries:

- the **system prompt**: your voice profile (unless the editor opts out), the editor's persona prompt, and its learning-memory block if it has one;
- the **note** — its whole text, or just your selection for a selection-scoped run;
- **attached notes**: prompt note references, wikilinks written in prompt text, links followed from prompt notes, and the reviewed note's own links when that editor opts in.

Nothing else. No vault listing, no file names beyond the ones attached, no metadata sweep.

**Strip frontmatter** (Behavior tab, off by default) removes the leading frontmatter block from the reviewed note **and** from every attached note, in the request payload and in what the preview reports. Nothing else in the text is touched. When your selection is inside the frontmatter — you asked an action to rewrite the frontmatter itself — the block is sent, because it is the thing you pointed at.

Run **Preview what will be sent** to see the exact assembly for one editor and one note — total characters against the budget, one row per section with its size and whether the budget truncated or dropped it, and the verbatim system prompt with a copy button. It sends nothing. It assembles through the same code a real request uses, so it cannot drift from what would actually be sent.

## Where API keys live

**In this plugin's `data.json`, inside your vault.** That is Obsidian's storage for plugin settings, and it is worth stating rather than burying:

- **If the vault syncs — Obsidian Sync, iCloud, Dropbox, Syncthing, git — the keys travel with it.**
- Use minimal-scope keys, and rotate them if the vault ever leaks.
- The Backends tab repeats this in a callout above the first field.

Keys and prompts are redacted from logs and error reports, and provider error bodies are never shown verbatim — a provider that echoes your key in an error message cannot leak it through a notice. [Exported settings](transfer.md) never contain a key.

## Where margin comments live

One file inside the plugin's own data folder, keyed by note path. **Never next to a note, never in a note's frontmatter, never inside your text.** Not polluting the vault is a core promise here.

A comment stores its quote and surroundings, never a position, and is re-anchored against the live text every time. A comment whose text you edited away is kept and shown as orphaned with its quote — never silently deleted, never guessed into a new position. See [Margin comments](margin-comments.md).

## Findings and runs are not persisted

Findings, run state and push-back threads are in-memory for the session. Closing Obsidian discards them. Nothing about a review is written to your vault.

## CLI backends

A CLI backend runs a program on your machine with your note on its standard input. It has its own containment, its own two consents, and a list of things the plugin explicitly does **not** bound. Read [CLI backends](cli-backends.md) before enabling one.

## Network

- API backends talk only to the endpoint you configured. There is no telemetry, no analytics, no update ping, no phone-home.
- OpenRouter requests carry attribution headers naming this plugin, as OpenRouter's own guidance asks. That is the only extra header of its kind.
- Requests are made from Obsidian's renderer, which means self-hosted endpoints must allow the browser origin — see [Troubleshooting](troubleshooting.md#requests-fail-immediately-network-error-or-failed-to-fetch).

## Bounds on what a backend can do to you

A backend's answer is untrusted input and is bounded before anything touches your note: at most 200 findings per result, quotes up to 2000 characters, critiques and suggestions up to 10000, replacements up to 100000. An oversized or malformed response is refused as invalid output rather than partially applied. A CLI backend's output is additionally capped at 8 MB.

## Next

- [CLI backends](cli-backends.md)
- [Binding rules](rules.md)
- [Move settings between vaults](transfer.md)
