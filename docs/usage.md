---
title: Usage
nav_order: 2
---

# Usage

> The plugin is in early development. The review loop below is the first working slice; panels, actions, push-back threads, and margin comments are coming next.

## Getting started

1. Open **Settings → AI Editor → Backends** and configure at least one API backend (Anthropic, OpenAI or compatible, Azure OpenAI, or Ollama) with a default model.
2. Set it as the default backend, or assign it to individual editors.
3. Make sure at least one editor is enabled (a starter pack is seeded on first load).
4. Open a note and run **Review current note**.

## Commands

| Command             | Description                                                                                                                 |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Review current note | Sends the current note to every enabled editor and streams their findings in as highlights. Unavailable for excluded notes. |
| Open review panel   | Opens the review side panel listing each editor's status, findings, summary, and verdict for the active note.               |

## The review flow

- A **persona rail** sits in the top-right corner of every markdown editor: a Review/Cancel button plus one colored dot per enabled editor. Dots pulse while reviewing and show a live finding-count badge.
- **Findings highlight the exact text span** they quote, tinted with the editor's color. Keep typing — highlights follow your edits. If you edit inside a highlighted span, the finding turns stale (dashed underline, dimmed): its suggestion no longer matches your text.
- **Click a highlight** to open a floating review card: the editor's critique, the quoted text, and (when the editor proposed a replacement) an old/new preview with **Accept** and **Dismiss**. Overlapping findings stack in one card, innermost first. Accept applies the replacement as a single undoable edit — and only if the text still matches exactly what the suggestion was computed against; otherwise the finding is stale and must be re-reviewed. Escape, clicking away, scrolling, or editing closes the card. The push-back input is a placeholder for an upcoming milestone.
- The **side panel** lists findings per editor. Click one to jump to and briefly select the span in the editor. Findings whose quote could not be located are listed under "Not anchored".
- The **status bar** shows the number of open findings for the active note.
- Notes above the configured word threshold ask for confirmation before anything is sent.
- Editors that cannot run (no backend, disabled backend, no model…) are reported, never silently skipped.

Nothing runs automatically: reviews only start when you trigger them, and privacy-excluded notes (folder, tag, or `ai_editor: false` frontmatter) are never sent to any backend.
