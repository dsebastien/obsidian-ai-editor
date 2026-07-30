# Domain Model

Entities and their relationships. Authoritative shapes live in code: `src/app/domain/` (Zod schemas) and `src/app/types/`. This document explains intent.

## Configuration entities (persisted in settings, stable UUIDs)

- **Editor** — an AI persona: name, color, prompt source (text and/or ordered vault note refs), backend instance + model override (or inherit), context policy (opt-in linked notes, cap), capability toggles (review / rewrite / research), optional learning memory (off | settings | vault note), enabled flag.
- **Panel** — 1-n member editors + charter (text and/or note refs) + aggregation backend/model. Produces scorecards. Visually distinct from editors everywhere.
- **BackendInstance** — one configured provider (Anthropic / OpenAI / OpenAI-compatible / Azure OpenAI / Ollama) or CLI agent (Claude Code / Codex), with label, credentials/endpoint, default model, negotiated capabilities.
- **ActionBinding** — maps a built-in or custom action verb (rephrase, summarize, critique, say-more, find-evidence, identify-assumptions, simplify, continue, custom…) to an editor or panel.
- **BindingRule** — ordered rules matching folder / tag / frontmatter property / note type → **assign** a default reviewer (an editor, or a panel meaning every member) or **disabled** (kill switch: no rail, no menu items, no commands, no dispatch for that scope). Rules only pick participants; they never start anything (Business Rule #1). Resolution order: a matching kill switch wins from any list position, then the first matching assignment in list order (never a union); no match → every enabled review-capable editor. A note's type identity is a SET of identifiers — the Obsidian Starter Kit plugin's own type names when it is installed (optional, feature-detected) plus the `type/<x>` tag convention, which needs no plugin — and a rule matches any of them.
- **VoiceProfile** — global: text and/or note refs; injected into every editor run unless the editor opts out.

## Runtime entities (ephemeral, per session)

- **DocumentSnapshot** — text + content hash + id, pinned per run. All quotes/anchors are relative to a snapshot.
- **ReviewRun** — one user-triggered execution: target (note/selection), requested editors/panel, per-editor status, findings, panel result. All events carry the run id; late events from cancelled runs are discarded.
- **Finding** — one observation by one editor: verbatim quote, critique, optional suggested replacement + rationale, severity, confidence, evidence entries (sources), anchor state (anchored / unanchored / stale / ambiguous), status (open / preview / accepted / rejected / dismissed / superseded / error), per-finding thread.
- **Finding thread** — session-scoped push-back conversation on ONE finding: `thread` holds COMPLETED exchanges only (strictly alternating user/editor, capped at 6), while the in-flight or failed turn is held separately so no half exchange ever enters the history. The editor's answer either withdraws the finding (`conceded` → dismissed) or holds it, updating critique/suggestion IN PLACE (the revised suggestion is re-checked against the anchor, never fuzzy-relocated).
- **PanelResult** — member verdicts (publish / needs-work / kill) with attribution, aggregated recommendation, top fixes, dissent, partial-failure notes.

## Persisted runtime entities (sidecar repository)

- **MarginComment** — file path + quote/prefix/suffix anchor, user instruction, executing editor, status (submitted / running / interrupted / done / dismissed), timestamps, result findings. Fuzzily re-anchored on file open; jobs interrupted by restart offer Retry.

## Key relationships

```
BindingRule ──selects──▶ Editor(s) | Panel | disabled
Panel ──members──▶ Editor (1-n)
ActionBinding ──routes──▶ Editor | Panel
Editor ──runs-on──▶ BackendInstance (or inherits global default)
ReviewRun ──pins──▶ DocumentSnapshot ──anchors──▶ Finding
Finding ──thread──▶ ThreadTurn* ──may-produce──▶ revised suggestion
Panel run ──aggregates──▶ member ReviewRun results ──▶ PanelResult
```
