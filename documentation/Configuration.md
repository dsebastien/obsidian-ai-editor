# Configuration

User-facing configuration of the plugin (persisted in `data.json`, schema-versioned with migrations).

## Settings tabs

1. **Backends** — 1-n provider instances (Anthropic, OpenAI, OpenAI-compatible with custom base URL, Azure OpenAI deployment-based, Ollama), each with label, credentials, default model, test button; CLI agents (explicit executable selection, consented health check). Global default backend. First-use setup wizard.
2. **Editors** — persona gallery: name, color, prompt (textarea + ordered note-ref control), backend/model override, context policy (opt-in linked notes + cap), capabilities, optional learning memory (settings | vault note), enabled. Import/export (validated, ID-remapped).
3. **Panels** — compose 1-n editors, charter (textarea + note refs), aggregation backend/model. Distinct visual identity.
4. **Actions** — built-in verbs + custom actions, each bound to an editor or panel; hotkeys via Obsidian's hotkey system.
5. **Voice & Style** — global voice profile (textarea + note refs), per-editor injection opt-out.
6. **Rules** — ordered binding rules (folder/tag/frontmatter → editors/panel/bindings or disabled); OSK note-type targets when the Starter Kit plugin is detected (optional, feature-detected, never required).
7. **Behavior** — size-warning threshold, concurrency, request timeout, token/byte context budget, daemon mode (off by default; toggle + idle delay — automatic review refresh after the user pauses editing, cost implication stated in the toggle copy, Business Rule #1 carve-out), exclusions (folders, tags, `ai_editor: false` frontmatter flag, strip-frontmatter toggle), default comment editor, language override.

## Notable defaults

- No backend configured → wizard, never an error dump.
- Starter pack seeded on first run (idempotent): Concision Editor, Devil's Advocate, Fact Checker, Flow & Structure Editor, Humanizer, Beginner Reader + the Pre-publish Review panel.
- Exclusions default to empty; nothing is ever sent without a user action regardless.

## Key storage disclosure

API keys are stored in the plugin's `data.json` inside the vault. If the vault is synced (Obsidian Sync, Syncthing, git…), keys travel with it. This is documented in the README and the Backends tab. Keys and prompts are redacted from logs and error reports.
