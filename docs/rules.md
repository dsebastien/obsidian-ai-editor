---
title: Binding rules
nav_order: 9
---

# Binding rules

A **binding rule** decides, per scope of your vault, either **who reviews** those notes or that the plugin is **switched off** for them entirely.

**Settings → AI Editor → Rules.** With no rules at all, every enabled editor reviews every note — which is also what happens to a note no rule matches.

## What a rule matches

| Match type        | Value                                                                  |
| ----------------- | ---------------------------------------------------------------------- |
| **Folder**        | A folder path, e.g. `Blog`. `/` matches the whole vault                |
| **Tag**           | A tag without `#`, e.g. `draft`                                        |
| **Frontmatter**   | `key: value`, e.g. `type: article` — or a bare key as a presence check |
| **OSK note type** | A note type name, e.g. `permanent-notes`                               |

## What a rule does

- **Assign reviewer** — the matched notes are reviewed by one editor, or by one [panel](panels.md) (which makes it a full panel run, charter and scorecard included).
- **Disable plugin** — a kill switch. No rail, no menu items, no commands, no AI, for any note that matches.

## The order of evaluation

1. **A matching kill switch wins from anywhere in the list.** Position does not save you from it.
2. Among the rest, **the first match from the top** assigns the reviewer. One rule, never a union of several.
3. A note nothing matches is reviewed by every enabled editor.

Drag a row by its handle to set priority. New rules are appended at the bottom, which is the lowest priority.

Each row shows what it currently resolves to, and says so when a rule does nothing.

## Assignments are defaults, not laws

A rule supplies the **default participant pool**. These override it:

- an explicit **Ask a question**;
- **Ask for comments** — a [margin comment](margin-comments.md) names its own editor;
- a **bound action** — you named the verb and it names its own target;
- `--editors` on the [command line](command-line.md);
- a **daemon refresh** of a note that was reviewed before, which reuses that review's editors.

Because they override the rule, they stay available even when the rule's own target cannot run: a rule pointing at a disabled editor stops **Review**, not **Ask a question**.

A kill switch is different: it refuses everything, including all of the above.

## Obsidian Starter Kit note types

The **OSK note type** match works two ways, and a rule matches either spelling:

- when the [Obsidian Starter Kit](https://github.com/DeveloPassion/obsidian-starter-kit-plugin) plugin is installed, against its own type names (for example _Permanent Notes_);
- always, against the `type/…` tag convention (for example `permanent_note`).

The Rules page tells you which of the two is active in your vault, and shows the spelling to use. The Starter Kit is optional and is never required — it is feature-detected, not depended on.

## A rule is not a privacy exclusion

They look similar and they are not the same thing:

|                            | **Disable plugin** rule                                        | [Privacy exclusion](privacy-and-security.md) |
| -------------------------- | -------------------------------------------------------------- | -------------------------------------------- |
| Effect on the note         | No plugin surfaces, no AI                                      | Never sent to any backend                    |
| Effect as _linked context_ | None — the note can still be attached to another note's review | Absolute: never attached, never followed     |
| Configured in              | Rules page                                                     | Behavior page                                |

If the point is that a note's content must never leave the vault, use a privacy exclusion. Use a kill switch when the plugin is simply noise in that part of the vault.

## Examples

- **Never in my journal**: `Folder` = `Journal`, effect **Disable plugin**.
- **Blog posts get the full panel**: `Folder` = `Blog`, effect **Assign reviewer**, target _Pre-publish review (panel)_.
- **Drafts get one cheap reviewer**: `Tag` = `draft`, effect **Assign reviewer**, target _Concision Editor_. Put it below the blog rule if a draft can also be a blog post and you want the panel to win.
- **Only literature notes get the Fact Checker**: `Frontmatter` = `type: literature`, effect **Assign reviewer**, target _Fact Checker_.

## Next

- [Privacy and security](privacy-and-security.md)
- [Work with panels](panels.md)
- [Configuration reference](configuration.md)
