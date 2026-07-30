---
title: Usage
nav_order: 2
---

# Usage

> The plugin is in early development. The review loop, action verbs, push-back threads and panel scorecards below are working; margin comments and CLI backends are coming next.

## Getting started

The **setup wizard** opens by itself the first time the plugin loads and walks you through all of it: a backend (with a **Test connection** button that sends one small real request), which editors are on, an optional voice profile, and whether editors wait to be summoned or refresh automatically. Nothing is saved until the last step, so you can leave at any point without changing anything, and you can re-run it any time from **Settings → AI Editor → Behavior → Setup** or the **Run setup wizard** command.

Prefer to do it by hand:

1. Open **Settings → AI Editor → Backends** and configure at least one API backend (Anthropic, OpenAI, OpenRouter or another OpenAI-compatible endpoint, Azure OpenAI, or Ollama) with a default model.
2. Set it as the default backend, or assign it to individual editors.
3. Make sure at least one editor is enabled (a starter pack is seeded on first load).
4. Open a note and run **Review current note**.

### Test connection

The Backends step of the wizard can check a backend before you rely on it. It sends one small request through the exact same path a real review takes, so a pass means reviews will work — not just that the endpoint answers. Three answers are possible:

- **Connection works** — you are done.
- **Reached, but not usable** — the key and the endpoint are fine, but the model did not answer in the structure the plugin needs. Try a stronger model.
- **Failed** — credentials, network, timeout, or configuration. The message says which.

A local model that is still loading can time out here and work fine for real reviews; the message tells you when that is what happened.

## Commands

| Command             | Description                                                                                                                 |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Review current note | Sends the current note to every enabled editor and streams their findings in as highlights. Unavailable for excluded notes. |
| Open review panel   | Opens the review side panel listing each editor's status, findings, summary, and verdict for the active note.               |
| Run setup wizard    | Re-opens the guided setup (backend, editors, voice profile, run mode). Nothing is saved until the last step.                |

More commands (review selection, ask an editor, cancel, triage, bulk operations, severity filter) are listed under the sections below. None of them ship a default hotkey — assign your own in **Settings → Hotkeys**.

## The review flow

- A **persona rail** sits in the top-right corner of every markdown editor: a Review/Cancel button plus one colored dot per enabled editor. Dots pulse while reviewing and show a live finding-count badge. Hover any dot for the editor's name and live status — for example "Concision Editor — 3 findings", "Devil's Advocate — waiting", or "Fact Checker — failed (timeout)".
- **Findings highlight the exact text span** they quote, tinted with the editor's color. Keep typing — highlights follow your edits. If you edit inside a highlighted span, the finding turns stale (dashed underline, dimmed): its suggestion no longer matches your text.
- **Click a highlight** to open a floating review card: the editor's critique, the quoted text, and (when the editor proposed a replacement) an old/new preview with **Accept** and **Dismiss**. Overlapping findings stack in one card, innermost first. Accept applies the replacement as a single undoable edit — and only if the text still matches exactly what the suggestion was computed against; otherwise the finding is stale and must be re-reviewed. Escape, clicking away, scrolling, or editing closes the card. The reply row under the card is a real push-back: see **Pushing back on a finding** below.
- The **side panel** has a header with the note it is bound to and a **Review** button, so you can start a review without going back to the editor — it works on the note you are on, or the last one you were on if your focus is in the panel. While a review is running the button shows a spinner and reads "Reviewing…" instead of starting a second one; cancel from the rail or the **Cancel review or action** command. When the button is unavailable, hover it: the tooltip says why (no note open, note excluded by your privacy settings, a rule turned the plugin off for it, or no editor can review). The panel lists findings per editor. Click one to jump to and briefly select the span in the editor. Findings whose quote could not be located are listed under "Not anchored".
- The **status bar** shows the number of open findings for the active note.
- Notes above the configured word threshold ask for confirmation before anything is sent.
- Editors that cannot run (no backend, disabled backend, no model…) are reported, never silently skipped.

## Triaging findings

Reviewing is meant to feel like resolving merge conflicts: step, judge, move on. Every command below works from the palette (or your own hotkey).

- **Next finding / Previous finding** walk the note's findings in document order, across all editors, wrapping around. Each step scrolls to the finding, rings it as the current one, and opens its card.
- **Accept current finding / Dismiss current finding** judge the ringed finding and jump straight to the next one — accept applies the replacement as a single undo step (and only while the text still matches), dismiss just clears it. When nothing is left, the ring and card disappear.
- **Escape** closes an open card while keeping your place in the loop; pressing it again leaves triage (the ring disappears).
- Clicking an editor's dot in the rail cycles through that editor's findings and briefly flashes its highlights.

## Pushing back on a finding

Every finding card has a reply box: type your objection ("I disagree — this repetition is intentional") and press Enter or select **Send**. The message goes to the same editor that raised the finding, and it answers one of two ways:

- **It withdraws the finding** — the finding is dismissed for you and the notice says why.
- **It holds its position** — the reply appears in the card's thread, and if the exchange sharpened its point, the critique and the suggested replacement are updated in place. A revised suggestion is re-checked against your text, so it is only applicable while the span is unchanged.

- The reply is a normal AI request: it takes a turn in the concurrency queue and obeys your request timeout. Closing the card does **not** cancel it — the answer lands on the finding and shows up when you reopen the card, and a notice tells you it arrived. **Cancel review** does cancel it.
- Threads are capped at six exchanges per finding and last for the session only — nothing is written to your note or to disk. A failed reply keeps your message so you can send it again.

## Bulk operations

- **Accept all (n)** in a side-panel section applies every non-conflicting suggestion of that editor at once, as **one** undoable edit. Two suggestions covering the same span cannot both apply: the first one wins and the other is reported as skipped, so you can re-review that span. Suggestions whose text you changed in the meantime are skipped too. A notice always says what was applied and what was skipped.
- **Dismiss all (m)** clears that editor's findings for the note. It never touches your text.
- The palette has the same per editor (**Accept all from &lt;Editor&gt;**, **Dismiss all from &lt;Editor&gt;**) plus **Accept all non-conflicting findings** for every editor of the note at once.

## Asking for more

When an editor has finished, its side-panel section gets a **Generate more (n)** button — `n` is how many findings it already reported. Pressing it asks that editor for **additional** findings on the note as it reads now; everything it already said stays exactly where it is, and the new findings are added to the list.

- One press is one round. The button disables while its round runs, so you cannot buy two by double-clicking, and there is no automatic repeat — every round is a request you pay for.
- The editor is told what it already reported and asked not to repeat itself; anything identical that comes back anyway is dropped before you see it. It is allowed to come back with nothing, and often should.
- An editor that reported nothing still gets the button — "I found nothing" is worth challenging once.
- If the extra round fails or you cancel it, the section says so next to the button and **your existing findings are untouched**. The editor stays finished rather than failed, precisely so that Retry — which replaces an editor's findings — is not offered to you at that moment.
- **Generate more findings from every finished editor** in the palette does one round for every editor of the note that has finished — one backend request each, and a notice says how many were asked.

## Severity filter

Findings come in three severities: warning, suggestion, and info. **Cycle severity filter** (or the **Show** button at the top of the side panel) narrows what you look at: all severities → warnings and suggestions → warnings only → all again.

The filter is a lens per note, not a deletion: hidden findings come back untouched when you cycle around. While a filter is active, hidden findings disappear from the highlights and the panel list, triage steps skip them, and bulk operations leave them alone — the panel tells you how many are hidden.

## Panels

A **panel** is a group of editors that review together and then get summed up. Compose one in **Settings → AI Editor → Panels**: pick the members, write a **charter** (the shared brief — it goes into every member's prompt _and_ is what the summary is written against), and choose the backend that writes the summary. The starter pack ships **Pre-publish Review** (Devil's Advocate + Flow & Structure + Beginner Reader + Humanizer).

A panel run is **one** run, not four reviews that happen to start together: the members review in parallel exactly like ordinary editors — same highlights, same cards, same retry — and the run then produces a **scorecard** at the top of the side panel: an overall verdict with its reason, a verdict per member, ranked top fixes (select one to jump to the finding it came from), and where the members disagreed, kept as who said what.

- **If a member fails**, the panel completes with the ones that did run, names the missing member, and says the summary did not see it. Retry that member from its section or its rail chip and the scorecard is rewritten.
- **If the summary itself fails**, every member's findings are still there — the block above them says what went wrong and that the reviews below are unaffected.
- **Telling a panel from an editor**: panels are drawn as a **ring** where editors are solid dots — on the rail the panel is one ringed chip with its members bracketed under it — and every place that names one also says "(panel)", so the distinction is not only visual.

## Actions

Actions are verbs you run on a selection: built-in ones (rephrase, summarize, simplify, humanize, continue writing, say more, critique, find evidence, identify assumptions) plus your own custom actions. Each action is bound to an editor in **Settings → AI Editor → Actions** — the starter pack binds sensible defaults (for example humanize → Humanizer, rephrase → Concision Editor) so the selection menu works out of the box.

- **Right-click a selection**: bound actions appear at the top of the context menu, with **Review selection** and **Ask an editor…** below them.
- **Command palette**: every bound action is also a command (for example "Humanize"), so you can assign hotkeys via Obsidian's hotkey settings. Commands appear and disappear as you change bindings — no reload needed — and hotkeys survive renames.
- **Rewrite verbs** (rephrase, summarize, simplify, humanize) never touch your text directly: the proposal appears as an inline diff below the selection — old text struck through, new text highlighted — with **Accept** and **Reject** (Enter/Esc while the widget has focus). Accept is a single undo step, and only applies while the selected text is unchanged; editing it dismisses the stale proposal.
- **Continue writing / Say more** insert a proposed continuation at the cursor, through the same preview.
- **Critique, find evidence, identify assumptions** run as reviews: findings arrive as highlights, exactly like Review selection. These three can also be bound to a panel, in which case the whole panel convenes — every member runs the action with the charter in its prompt, and you get a scorecard on top. A panel-bound action says so in the menu and the palette ("Critique (panel: Pre-publish Review)"), because one press is one request per member.
- Excluded notes never dispatch actions, and an action whose editor is disabled or misconfigured is hidden rather than broken (the Actions tab tells you why).

### Custom actions

**Settings → AI Editor → Actions → Add custom action** gives you your own verb. Give it a name, an instruction (typed, and/or vault notes appended to it — with **Follow links** if those notes link out to more), pick the editor or panel that answers, and pick **what it does**:

- **Rewrite the selection** — the answer replaces the selected text, through the same inline diff as rephrase or humanize.
- **Write more at the cursor** — the answer is inserted after the selection or at the cursor, through the same preview.
- **Report findings** — the answer arrives as highlights on the note, like critique. Only this kind can be bound to a panel, where the whole panel convenes and produces a scorecard.

There is no default for that last choice on purpose: the same instruction means very different things depending on it, and an action that quietly rewrote text you only asked it to check would be the worst kind of surprise. Until you pick one — and until the action has a name and an instruction — it stays out of the menu and the palette, and its row says why.

## Moving your settings between vaults

**Settings → AI Editor → Behavior → Import & export.**

**Export…** lets you tick what to include (backends, editors, panels, actions, rules, voice profile) and writes it either to a JSON file in your vault or to the clipboard. **Your API keys are never exported**, so the file is safe to share, commit, or paste into a message.

**Import…** takes a pasted document or a file from your vault — including a `data.json` copied from another vault's plugin folder. It shows you exactly what will happen before saving anything:

- Everything is **added** to what you already have, never merged over it, and internal ids are regenerated — so importing the same file twice gives you two independent copies rather than a silent overwrite.
- References inside the file are rewired to the imported entities. A reference to something that is not in the file survives only if it already exists here (importing panels back into the vault their member editors live in works); otherwise it arrives unbound, and the summary says so.
- Anything that cannot come in is listed with its reason: an entity this version does not accept, a panel whose member editors are missing, an action verb you already bound, or a section that is full.
- Your voice profile is the one thing that gets **replaced** rather than added, and the summary says so before you confirm.
- **API keys are never imported either** — open the Backends tab and enter yours before running anything.

## Daemon mode (opt-in)

By default nothing runs automatically: reviews only start when you trigger them. **Daemon mode** (Settings → AI Editor → Behavior → Daemon) changes that for the notes you edit: with the toggle on, your editors watch your edits and refresh their recommendations automatically after you pause editing for the configured idle delay.

- A refresh only happens when the note is reviewable, its text actually changed since the last review, and no review is already running for it (edits made during a run coalesce into one refresh after it finishes).
- Notes above the size-warning threshold are silently skipped — daemon mode never interrupts you with dialogs.
- Refreshes reuse the editors of the note's previous review (all enabled editors when it was never reviewed) and never override your explicit actions: summon, cancel, and retry always win.
- While a refresh is armed for the current note, a small pulsing dot appears at the bottom of the persona rail.
- **Cost warning**: every refresh calls your configured AI backends. Keep the idle delay generous if you pay per token.

## Privacy

Privacy-excluded notes (folder, tag, or `ai_editor: false` frontmatter) are never sent to any backend — not by commands, not by daemon mode.
