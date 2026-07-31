---
title: Margin comments
nav_order: 8
---

# Margin comments

A **margin comment** is a question you park on a passage — _"is this claim supported?"_, _"is this too long?"_ — that an editor answers in the background while you keep writing. It survives note switches, closing the note, and restarting Obsidian.

## Ask for one

Select some text, then use any of:

- the **Ask for comments** command;
- **Ask for comments…** in the selection's right-click menu;
- the **Ask for comments** button at the top of the review panel.

A dialog opens on the editor set in **Settings → AI Editor → Behavior → Default comment editor** (change it per comment) and asks for your question.

**A selection is required.** A margin comment is anchored to a span: without one there would be no line to sit beside and no quote to re-anchor against later.

## While it runs

The answer arrives whenever it arrives. Keep writing, switch notes, close the note — the job does not care.

Background comment work **never queues ahead of a review you are watching**. It takes a slot only when the queue is empty and there is a spare one, so a parked question can never delay a review you are staring at. On a busy vault that means a comment may wait; that is the intended trade. Running background work is never interrupted, because the request has already been paid for.

Every job is individually cancellable.

## The column

Comments render in a column beside the text, each card aligned with the line it is about: who was asked, where the job stands with a live timer while it runs, and the answer once there is one. Several comments on one line collapse into an **N comments** chip that expands.

| Control     | What it does                                                                         |
| ----------- | ------------------------------------------------------------------------------------ |
| **Resolve** | Closes the comment and **keeps** it, so the same question is not asked twice         |
| **Delete**  | Removes it for good, after an explicit confirmation                                  |
| **Retry**   | Re-asks a comment that failed or was interrupted by a restart — always a new request |

Long answers truncate with an in-place expansion, so opening one does not move the cards around it.

### Where the column appears

- It needs room: **panes of roughly 700px and wider**. Below that, the review panel is the surface.
- With **Readable line length** on (Obsidian's default) the column drops into the empty right margin and **your text does not move at all**. With it off, the editor is padded once so the cards never sit on top of your prose.
- **In Reading view there is no column.** The comments still exist and are still listed in the review panel; switch back to Live Preview or Source mode to see them beside the text.
- Turn the whole column off with **Toggle the margin comment column** or **Settings → AI Editor → Behavior → Margin comment column**. The comments then live in the review panel only — the toggle is a view preference, not a deletion.

## When the text changes

A comment stores the text it quoted plus its surroundings — never a position. Every time the note loads or changes, each comment is re-anchored against the live text through the same matcher findings use.

If you edit the quoted text away, the comment is **not deleted**. It moves to a collapsed group at the top of the column, with its original quote, so you can find what it was about. Nothing is ever guessed into a new position.

**Retry** re-anchors first and refuses when the quote is gone: re-asking about text that no longer exists would answer a different question than the one you asked.

## Where they are stored

One file inside the plugin's own data folder, keyed by note path. **Never next to your notes, never in a note's frontmatter, never in your text.** Not polluting the vault is a core promise of this plugin.

- **Renaming a note** moves its comments. **Deleting a note** drops them — no tombstone, so a note later created at that path cannot inherit a stranger's comments.
- **A store that cannot be read is preserved** as a timestamped backup copy before anything writes, you are told, and the plugin loads with whatever could be salvaged.
- **The file syncs** if your vault does. A write that finds changes this session has not seen merges the two by comment id rather than reverting whatever another device parked, and says so.
- **An interrupted write is recovered** from its staged temporary file on the next load and reported — a missing store would otherwise be indistinguishable from a first run.
- **A session that cannot write refuses new comments** and retries, rather than accepting questions it will lose when you quit.
- Up to **500 comments per note**. When a rename merges two sets past that cap, the overflow is reported rather than silently discarded.

## After a restart

A comment that was in flight when Obsidian closed loads back as **interrupted**, with a **Retry** button. Nothing is ever resumed automatically — the plugin does not make AI requests you did not ask for, and an interrupted job is exactly a request nobody is currently asking for.

Plugin unload cancels every in-flight job and records it as interrupted before the store is flushed. A cancelled job is reported as _interrupted_ rather than _failed_, because nothing is known about why it ended.

## Not yet

Per-comment reply threads (arguing with an answer, the way you can with a finding) are not implemented. Ask again with a new comment for now.

## Next

- [Review a note](usage.md)
- [Privacy and security](privacy-and-security.md)
- [Troubleshooting](troubleshooting.md)
