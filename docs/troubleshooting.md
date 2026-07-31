---
title: Troubleshooting
nav_order: 95
---

# Troubleshooting

## A review times out

**Symptom:** _"Provider did not answer within 600 s — raise 'Request timeout' in settings if your model needs longer."_

Slow local models are the usual cause. A 7B model on CPU, or any model with thinking enabled, can legitimately take many minutes on a long note.

1. **Raise the timeout.** **Settings → AI Editor → Behavior → Runs → Request timeout (seconds)**. Default 600, maximum 3600.
2. **Turn thinking off** while you diagnose. **Backends → your backend → Thinking**. A model reasoning silently for minutes is indistinguishable from a hang, which is why it defaults to off.
3. **Review a selection instead of the whole note** to see whether size is the problem.
4. **Lower the context budget** or turn off **Include linked notes** on the editors involved. Fewer characters, faster answer.
5. **Reduce concurrency.** **Max concurrent requests** at 3 means three models loading at once on the same machine; drop it to 1 for a local backend.

**A CLI backend ignores that setting.** It carries its own **Timeout** on the backend itself (default 300 s). Raising the Behavior tab's request timeout does nothing for Claude Code or Codex.

**Test connection uses its own 60-second bound**, so a local model still loading its weights can fail the test and work fine for a real review. The message says so when that is what happened.

## Requests fail immediately (network error, or "Failed to fetch")

**Symptom:** _"Network request failed: … Check the endpoint URL and that the server is reachable; if it is a self-hosted endpoint, it may be blocking browser requests (CORS)…"_

Requests are made from Obsidian's renderer, which is a browser context. The browser deliberately hides _which_ of DNS failure, connection refusal and CORS rejection happened, so the message names all three.

- **Ollama** — it must allow Obsidian's origin. Start it with `OLLAMA_ORIGINS=app://obsidian.md`, or add that to its service environment permanently.
- **LM Studio, llama.cpp, vLLM, a corporate gateway** — same class of problem. Enable CORS for `app://obsidian.md`, or put a permissive reverse proxy in front.
- **Check the base URL** — a trailing path, a wrong port, `https` where the server speaks `http`. Trailing slashes are handled for you.
- **Check the server is up** at all: `curl` the same URL from a terminal. If curl works and Obsidian does not, it is CORS.

## The model answers, but the plugin says the answer is unusable

**Symptom:** _"The endpoint answered, but not in a usable shape — the model ignored the requested structure. Try a stronger model."_ Or, for an agent: _"The tool ran and answered, but not with the structured result the plugin needs."_

Every backend must return a structured result: findings with verbatim quotes, a critique, an optional suggestion, a severity. A "mostly right" payload is still a failure — a partially-parsed suggestion applied to your note would be worse than none.

- **Use a stronger model.** Small local models routinely wrap JSON in prose or invent fields. This is the single most common cause.
- **Check you are on a chat/instruct model**, not a base completion model.
- **For agents**, expect it more often: an agent that narrates before answering looks exactly like this.
- **Simplify the request** while diagnosing: one editor, a short selection, thinking off.
- **Suspect your extra request body** if you set one — a wrong `response_format` or a routing preference sending you to a different model will do this.

The response is also refused if it exceeds the safety bounds: more than 200 findings, a quote over 2000 characters, a critique or suggestion over 10000, a replacement over 100000.

## Findings appear under "Not anchored"

The editor's quote could not be located in your text — not exactly, and not uniquely enough to be safe.

That is by design: a finding is only actionable when its quote matches your text exactly, or matches uniquely once whitespace is normalized. Anything vaguer is shown as **display-only** so you can read the critique, but it is never applied and never guessed into a position.

Usual causes:

- **The model paraphrased instead of quoting.** Weaker models do this constantly. A stronger model fixes it.
- **You edited the text while the review was running.** Re-run the review.
- **The quote spans a formatting boundary** the model reproduced differently — smart quotes, a soft line break, a list marker.

You can still dismiss an unanchored finding; you cannot accept it.

## A finding went stale

Dashed and dimmed: you edited inside the highlighted span, so the suggestion no longer matches the text it was computed against. Accepting it would apply a replacement to something else.

Dismiss it, or run the review again for a fresh look at the text as it now reads.

## Review refuses to start

Hover the panel's **Review** button — the tooltip says which of these it is.

| Reason                   | Fix                                                                                                          |
| ------------------------ | ------------------------------------------------------------------------------------------------------------ |
| **No note open**         | Open a markdown note                                                                                         |
| **Excluded**             | The note matches a [privacy exclusion](privacy-and-security.md) — folder, tag, or `editor_ai_daemons: false` |
| **Rule-disabled**        | A [binding rule](rules.md) switched the plugin off for it. The message names the rule                        |
| **No editor can review** | Every editor is disabled, has no usable backend, or has review capability off                                |

A rule-disabled note has no rail, no menu items and no commands either — that is what the kill switch means.

## An editor is skipped

Skips are always reported, never silent. The reason is one of:

| Message                                       | Fix                                                                   |
| --------------------------------------------- | --------------------------------------------------------------------- |
| _review capability disabled_                  | Editors tab → the editor → **Review**                                 |
| _rewrite capability disabled_                 | Editors tab → the editor → **Rewrite** (transform actions need it)    |
| _no backend configured_                       | Set a global default backend, or assign one to the editor             |
| _its backend no longer exists_                | Reassign the editor to a backend that exists                          |
| _its backend is disabled_                     | Backends tab → enable it                                              |
| _its CLI backend has not been allowed to run_ | Grant launch consent on the backend's row                             |
| _no model configured_                         | Set a default model on the backend, or a model override on the editor |
| _the editor is disabled_                      | Editors tab → enable it                                               |
| _the matching rule's panel no longer exists_  | Rules tab → repoint or delete the rule                                |

## The note is too big

Notes above **Size warning threshold** (default 8000 words) ask for confirmation before anything is sent. Confirm, or:

- **review a selection** instead of the whole note;
- **raise the threshold** in the Behavior tab if you routinely work with long notes and know what it costs;
- from the CLI, pass `--confirm-large`.

**Daemon mode silently skips oversized notes** rather than interrupting you with a dialog. If a note never refreshes automatically, its size is the first thing to check.

Separately, the **context budget** (default 200000 characters) governs what fits in one request. The system prompt and the reviewed note are never truncated; attachments are dropped from the end. **Preview what will be sent** shows exactly what was dropped and why.

## A CLI backend will not run

| Message                                | What it means                                                                  |
| -------------------------------------- | ------------------------------------------------------------------------------ |
| _No executable path is configured_     | Fill in **Executable**                                                         |
| _The executable path must be absolute_ | No `~`, no bare name, no relative path — no shell runs here to expand them     |
| _No file exists at …_                  | Wrong path. `which claude` / `which codex` prints the real one                 |
| _… is not a file_                      | You pointed at a directory                                                     |
| _… is not executable by this user_     | `chmod +x`, or point at the real binary                                        |
| _This file is a script, not a program_ | A Windows `.cmd`/`.bat`/`.ps1` shim. Point at the `.exe` or use an API backend |
| _has not been allowed to run_          | Grant the first consent. **Enabled is not consent**                            |

**Detect found nothing?** It only probes a curated list of install locations and never searches `PATH`. Run `which claude` in a terminal and paste the result.

**Consent stopped applying?** Consent records _which executable_ it was granted for. Changing the path, importing settings, or syncing `data.json` from another machine invalidates it, and you are asked again about the program that is actually there. That is deliberate.

**The run failed with "the process tree could not be stopped".** An agent left something behind. The run is reported as failed rather than as a success, on purpose. Check for orphaned processes before re-running.

**You cannot see the tool's error text.** By design: an agent CLI echoes its configuration when it fails, and configuration contains credentials. You get the status, the byte count of the error stream, and whether something could not be stopped.

## Margin comments

**The column is not showing.** In order of likelihood:

- the pane is narrower than ~700px — the review panel is the surface below that;
- you are in **Reading view**, which has no column. The comments still exist and are still listed in the panel;
- **Margin comment column** is off in the Behavior tab, or you hit **Toggle the margin comment column**.

**A comment says it is orphaned.** You edited away the text it quoted. The comment is kept with its original quote in a collapsed group at the top of the column rather than deleted. **Retry** refuses an orphaned comment: re-asking about text that no longer exists would answer a different question.

**A comment is stuck as interrupted.** Obsidian closed, or the plugin unloaded, while it was in flight. Press **Retry** — nothing is ever resumed automatically.

**A comment never starts.** Background work never queues ahead of a review: it takes a slot only when the queue is empty and there is a spare one. On a busy vault a comment can wait. Let the reviews finish, or raise **Max concurrent requests**.

**You were told the store could not be written.** New comments are refused for the session rather than accepted and lost at quit. Check that Obsidian can write to its config folder and restart.

## Actions

**An action is missing from the menu.** Unbound actions are hidden. Bound-but-undispatchable ones show the reason under their row in the Actions tab: no name, no instruction, no class chosen, a target that is disabled or deleted.

**A custom action does nothing.** Check **What it does** is set. There is deliberately no default, and until you pick one the action stays out of every surface.

**A panel-bound action refuses.** Only report-findings actions can bind a panel. Changing an action's class away from report-findings clears the binding.

## Panels

**A member is missing from the scorecard.** It failed, and the panel says so and names it. Retry that member and the scorecard is rewritten.

**The scorecard failed but the findings are there.** Aggregation is one extra request; when it fails, the member reviews below it are untouched. The block above them says what went wrong.

**The scorecard says it is from the previous round.** A member is generating more findings, so the scorecard will be rewritten when it finishes. Keeping the old one beats showing nothing.

## Commands are missing from the palette

- **`editor-ai-daemons:*` CLI subcommands** need Obsidian 1.12.2 or newer.
- **Per-action and per-editor commands** are generated from your settings and disappear when the binding does.
- **Triage commands** only appear when there is something to triage.
- **Nothing at all for this note**: a [binding rule](rules.md) has switched the plugin off for it.

## Nothing here helped

[Open an issue](https://github.com/dsebastien/obsidian-ai-editor/issues) with what you did, what you expected, and what happened. Include your Obsidian version and which backend kind you use — but **never paste your `data.json`**: it contains your API keys.
