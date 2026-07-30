# Configuration

User-facing configuration of the plugin (persisted in `data.json`, schema-versioned with migrations).

## Settings tabs

1. **Backends** — 1-n provider instances (Anthropic, OpenAI, OpenAI-compatible with custom base URL, Azure OpenAI deployment-based, Ollama), each with label, credentials, default model, test button; CLI agents (explicit executable selection, consented health check). Global default backend. First-use setup wizard.
2. **Editors** — persona gallery: name, color, prompt (textarea + ordered note-ref control + follow-links toggle), backend/model override, context policy (opt-in linked notes + cap), capabilities, optional learning memory (settings | vault note), enabled. Import/export (validated, ID-remapped).
3. **Panels** — compose 1-n editors, charter (textarea + note refs + follow-links toggle), aggregation backend/model. Distinct visual identity.
4. **Actions** — built-in verbs + custom actions, each bound to an editor (review-class verbs — critique, find evidence, identify assumptions — may bind a panel instead: every member runs the action). Custom actions are transform-class. Bound + dispatchable actions appear in the selection context menu and as dynamic `action-<bindingId>` palette commands (hotkeys via Obsidian's hotkey system; command ids stay stable across renames). Bound-but-undispatchable actions show why under their row; unbound actions stay hidden.
5. **Voice & Style** — global voice profile (textarea + note refs + follow-links toggle), per-editor injection opt-out.
6. **Rules** — ordered binding rules matching folder / tag / frontmatter (`key: value`, or a bare key as a presence check) / OSK note type. Two effects: **Disable plugin** (kill switch — no rail, no menu items, no commands, no dispatch for matching notes) and **Assign reviewer** (an editor, or a panel meaning every member). Evaluation: a matching kill switch wins from any position in the list; among the rest the first match from the top assigns the reviewer (one rule, never a union); a note no rule matches is reviewed by every enabled editor. Assignments supply the DEFAULT pool only — an explicit ask-an-editor / bound action, and a daemon re-dispatch of a note's previous run, both win over a rule. OSK note types resolve two ways: the Starter Kit plugin's own type names when it is installed (optional, feature-detected, never required) and the `type/<x>` tag convention, which always works; a rule matches either spelling. Rows say what they resolve to, and say so when a rule does nothing.
7. **Behavior** — size-warning threshold, concurrency, request timeout, character context budget (the copy states the spend order and points at the preview command), daemon mode (off by default; toggle + idle delay — automatic review refresh after the user pauses editing, cost implication stated in the toggle copy, Business Rule #1 carve-out), exclusions (folders, tags, `ai_editor: false` frontmatter flag, strip-frontmatter toggle), default comment editor, language override.

Every prompt source (voice profile, editor prompt, panel charter) carries a `followLinks` flag ("Follow links" toggle on its note-refs block). For sources context assembly consumes today — the voice profile and editor prompts — the flag is live; the panel charter's toggle is persisted but inert until charter/aggregation context assembly lands (M6). When on, context assembly also inlines the notes linked FROM each referenced note — depth 1 only, embeds count, deduped against already-included notes, capped at 20 per referenced note (deterministic link order), subject to `contextBudgetChars`; unresolved/non-markdown links skipped silently, excluded referenced notes never followed. Default ON for the voice profile (its motivating case: `[[My Voice Profile]]` linking out to style notes), OFF elsewhere.

## What will be sent (preview)

The palette command **Preview what will be sent** and the **Preview** button in the editor dialog open one read-only modal showing the REAL assembly for one editor and one note: total characters against the budget, one row per section (system prompt, reviewed note, every attached note) with its size and whether the budget truncated or dropped it, the resolved backend, and the verbatim system prompt, with a copy button. It sends nothing.

Both entry points assemble through the same `buildEditorPrompt` a dispatch uses — a preview that re-derived the prompt would eventually disagree with the request, which is the one failure a trust surface may not have. They differ deliberately in two ways: the command reads the LIVE editor buffer (unsaved edits are what a run would send), while the settings button reads the vault but previews the UNSAVED draft persona (previewing the editor you are currently writing is the only useful answer there). Privacy exclusions and a binding-rule kill switch are shown as refusals naming the tab that fixes them, because "nothing would be sent" is the most important thing a preview can say.

## Notable defaults

- No backend configured → wizard, never an error dump.
- Starter pack seeded on first run (idempotent): Concision Editor, Devil's Advocate, Fact Checker, Flow & Structure Editor, Humanizer, Beginner Reader + the Pre-publish Review panel + default action bindings (rephrase/summarize/simplify → Concision Editor, humanize → Humanizer, critique/identify assumptions → Devil's Advocate, find evidence → Fact Checker; continue/say more left unbound). Verbs the user already bound are never overridden.
- Exclusions default to empty; nothing is ever sent without a user action regardless.

## Key storage disclosure

API keys are stored in the plugin's `data.json` inside the vault. If the vault is synced (Obsidian Sync, Syncthing, git…), keys travel with it. This is documented in the README and the Backends tab. Keys and prompts are redacted from logs and error reports.
