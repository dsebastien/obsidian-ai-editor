# AI Editor — v1 Implementation Plan

> Status: DRAFT — everything below is directional. The requirements were gathered as brainstorming; each feature is a candidate, not a contract. The one non-negotiable: **awesome UI/UX**. When a trade-off arises between feature count and interaction quality, interaction quality wins.

## 1. Vision

Bring AI editing/reviewing/QA **into** the Obsidian editor itself — not a chat sidebar bolted onto a note, but AI personas that live in the margins of the text, highlight what they care about, argue with you, and propose surgical edits you accept or reject inline.

The user writes; a configurable crew of **Editors** (AI personas) and **Panels** (groups of editors) review, critique, rewrite, fact-check, and coach — all grounded in the user's own vault (voice profile, style rules, personas documented as notes).

### Design north stars

1. **The text is the interface.** No modal chat. Findings anchor to spans in the note; actions happen where the text is (Maggie Appleton: "bring the LLM to the editing and thinking process, rather than exiting into a chat interface").
2. **Suggestions, never silent mutations.** Every AI change is a visible diff with Accept/Reject. The user stays the author.
3. **Ignorable by design.** Findings fade away when dismissed; daemons never block writing (Appleton's daemons principle).
4. **Vault as configuration.** Every prompt (editor persona, panel charter, voice profile) can be typed directly in a textarea OR sourced from 0-n vault notes. Documenting your assistant in your vault IS configuring the plugin.
5. **Full parity in Live Preview AND Source mode.** Both are CM6, so highlights, rails, cards, diffs, and margin comments must work identically in both. Source mode is a first-class citizen, not a degraded fallback — test every surface in both modes.
6. **Desktop-first.** Mobile support is explicitly not a priority.

## 2. Inspiration analysis

### 2.1 Juri Strumpflohner's "Quill" (X posts, analyzed frame-by-frame from demo videos)

Sources:
- https://x.com/juristr/status/2074494746484236459 (8-min demo, July 7 2026)
- https://x.com/juristr/status/2077036970895872368 (28-s dark-mode demo, July 14 2026)
- https://x.com/juristr/status/2079297727364464700 (screenshot of async review, July 20 2026)

Observed UX (all confirmed via frame extraction):

| Element | Behavior |
|---|---|
| **Persona rail** (left gutter) | Colored dots, one per persona. Hover reveals name (e.g. "DEVIL'S ADVOCATE") + edit/delete icons. A `+` dot creates a new persona. |
| **Summon button** | Above the rail. Click → all personas review the doc. Button becomes "Cancel"; dots become spinners; when done, each dot shows a **count badge** (findings count, e.g. 8/4/8). |
| **Span highlights** | Each persona highlights the text spans it has findings for (subtle tinted background). |
| **Review card** | Click a highlight → floating card near the span: persona name ("Concision Editor"), critique text, quoted passage, buttons **Suggest / Apply / Dismiss**, plus a freeform input "Push back, ask for evidence…" to argue with the persona. |
| **Inline diff** | "Suggest" → in-place diff: red strikethrough deletions, green insertions, one-line rationale ("Dropped 'just' and 'a bunch of', replaced the vague clause…"), **Accept / Reject**, plus "Refine this suggestion…" input. |
| **Selection context menu** | Select text → menu: Rephrase, Say more, Critique, Find evidence, Get research, Identify assumptions, + "Ask the daemon…" freeform. Keyboard shortcuts shown. |
| **Generate more** | A ghost "+ Generate more" affordance between blocks → inline "Generating…" placeholder → continuation drafted in place. |
| **Async review (v2)** | Select text + type an instruction → margin comment card showing the quote, the instruction, status **SUBMITTED**, then a live **"Reviewing 0:27"** timer while a background agent works. Result lands back in the card. Google-Docs-comments where the reviewer is an agent. |

### 2.2 Maggie Appleton — Language Model Sketchbook (https://maggieappleton.com/lm-sketchbook)

- **Daemons**: background characters with distinct epistemic roles (devil's advocate, synthesizer, evidence-fetcher, elaborator, encourager). Non-intrusive; suggestions can be ignored and fade.
- **Epi**: context-menu integration — localized, task-specific help (rephrase, critique, evidence, assumption-checking) inside the writing tool.
- Core thesis: chatbots are the wrong interface for writing support; embed affordances in the editor.

### 2.3 The user's OSK AI ecosystem (feature quarry)

The vault already contains a mature agent architecture ([[AI Assistant Architecture]]) whose concepts map 1:1 onto plugin features:

| Vault concept | Plugin analog |
|---|---|
| **Agent** = SOUL.md (identity, voice, DO/DON'T, expertise, decision framework, boundaries) | **Editor** persona whose prompt can point at vault notes (a SOUL note works as-is) |
| **Panel** = N agents → individual verdicts + aggregated recommendation + top-3 fixes + dissent (e.g. osk-panel-publish: Editor, Beginner, Power User, Hater) | **Panel** entity: 1-n editors + aggregation step → scorecard view |
| `user-voice-profile` context loader (My Voice Profile, Content Strategy, Content Types) | **Voice/style configuration** (textarea + 0-n note refs) injected into every editor run |
| `osk-writing-humanizer` (AI-pattern detection, banned vocabulary, P0/P1/P2 severity, structure-is-the-#1-tell) | Starter editor: **Humanizer** — flags AI-sounding passages, metronomic rhythm, banned words |
| `osk-writing-rigor` (hedge-stacking, uncited claims, magnitude language, weasel openers) | Starter editor: **Rigor Auditor** |
| `developassion-style-police` / `style-guard` (banned words, emdash abuse, signature elements, pass/fail gate) | Starter editor: **Style Enforcer**; a "pre-publish gate" panel |
| Agents: Hater, Skeptic, Beginner, Power User, Storyteller, Provocateur | Starter personas for the editor gallery |
| Scorecards with verdicts (publish / needs work / kill it) | Panel result UI |

## 3. Decisions locked so far (from the grilling session)

| Decision | Choice |
|---|---|
| Audience | **Public community plugin**, fully configurable; the user's own style rules become his persona configs |
| Backends | **Both**: direct LLM APIs (BYOK) **and** agent CLIs (Claude Code, Codex). Desktop-only |
| v1 surfaces | **All four**: persona rail + summon, selection context menu, async margin comments, generate/continue |
| Persistence | **Ephemeral findings** (in-memory CM6 decorations, remapped as you type, gone on close — re-summon is cheap) + **sidecar store** for async comments (survive editor sessions, background agents outlive the note being open) |
| Persona model | Per-editor **model/backend override** (fallback to global default) + starter pack + JSON import/export |
| Anchoring | **Exact-quote matching** (structured findings quote the text; plugin locates quote in raw markdown, exact → normalized → fuzzy; unmatched findings degrade to a note-level list) |
| Naming | Personas are **"Editors"**; groups are **"Panels"**. Plugin name: **AI Editor** |
| Panels | **In v1** ("I want it all"): user composes panels from 1-n editors; aggregated scorecard (verdicts, top fixes, dissent) |
| Action bindings | Every UI action (rephrase, summarize, critique…) is **mapped in settings to an editor or panel** |
| Prompt sourcing | Every prompt field = **textarea AND/OR 0-n vault note refs** ("configure directly as a prompt, or indirectly by documenting things in my vault") |

## 4. Domain model

```
Editor
  id, name, color, icon?
  promptSource:      { text?: string; noteRefs: NotePath[] }   // concatenated at runtime
  backend:           BackendRef | 'inherit'                    // provider+model or CLI agent
  capabilities:      { review: bool; rewrite: bool; research: bool }  // what it may do
  enabled:           bool

Panel
  id, name, color/badge style (visually distinct from Editors everywhere)
  members:           EditorId[]           // 1-n
  charterSource:     { text?: string; noteRefs: NotePath[] }   // aggregation instructions
  aggregation:       'scorecard' | 'merged-findings'
  enabled:           bool

VoiceProfile (global, singleton in settings)
  source:            { text?: string; noteRefs: NotePath[] }   // e.g. [[My Voice Profile]]
  injectInto:        'all' | per-editor opt-out

Action  (built-in verbs surfaced in context menu / command palette)
  id: rephrase | summarize | critique | say-more | find-evidence |
      identify-assumptions | simplify | continue | custom…
  binding:           EditorId | PanelId   // configurable in settings
  customActions:     user-defined {name, promptSource, binding}

Finding (ephemeral)
  editorId, quotedText, anchor {from,to} | null, critique,
  suggestedReplacement?, rationale?, status: open|applied|dismissed

ReviewRun (ephemeral)
  target: note | selection, requestedBy: summon|action|panel,
  perEditor: pending|running|done|error, findings[], panelVerdict?

MarginComment (persisted, sidecar)
  id, filePath, anchor {quotedText, prefix, suffix},   // fuzzy re-anchoring
  instruction, status: submitted|running|done|dismissed,
  startedAt, elapsed, result?: Finding[]

Backend
  ApiBackend:  provider (anthropic|openai|openrouter|ollama|custom-openai-compatible),
               apiKey, baseUrl?, model
  CliBackend:  kind (claude-code|codex|custom), executablePath, args template,
               cwd (vault), timeout
```

Key invariants:
- An Editor's effective system prompt = voice profile (if injected) + persona prompt (textarea ⊕ resolved note contents, in declared order).
- Note refs are resolved at run time (fresh read), so editing [[My Voice Profile]] immediately affects every subsequent run — the vault is the config.
- Panels are visually distinguishable from Editors in every surface (rail, context menu, cards): distinct shape/badge (e.g. editors = solid dots, panels = ringed/stacked dots).

## 5. Architecture

### 5.1 Backend abstraction

```
interface ReviewBackend {
  review(req: ReviewRequest): AsyncIterable<BackendEvent>
  // BackendEvent: finding | progress | token | done | error
}
```

- **ApiBackend** (v1 core): direct `fetch` to provider APIs, streaming. Structured output via JSON schema / tool-call where supported; strict Zod validation of findings.
- **CliBackend** (v1, desktop-only): spawn `claude` / `codex` in headless mode (`claude -p --output-format stream-json`) with the note (or selection) as context, cwd = vault root. Parse streamed JSON into BackendEvents. This is what powers "Get research"-grade actions (web, tools) and long async reviews.
- Per-editor backend override; global default backend in settings.
- All requests carry: system prompt (assembled per §4), the note content (raw markdown), optional selection range, and the structured-findings output contract.

### 5.2 Finding contract (what every backend must return)

```json
{
  "findings": [{
    "quote": "exact text from the document",
    "critique": "what's wrong / observation",
    "suggestion": "replacement text (optional)",
    "rationale": "one-liner shown with the diff (optional)",
    "severity": "info | suggestion | warning",
    "confidence": 0-1
  }],
  "verdict": "publish | needs-work | kill",   // panels / gate editors only
  "summary": "note-level remarks (optional)"
}
```

### 5.3 Anchoring pipeline (highest technical risk — build first)

1. Exact string match of `quote` in raw markdown.
2. Fallback: whitespace/typography-normalized match (smart quotes, NBSP, newlines).
3. Fallback: fuzzy match (e.g. bitap/levenshtein window, threshold ~0.9) using `prefix`/`suffix` hints.
4. Unmatched → finding still shown in the run's list view (no highlight), never lost.
5. Anchors live as CM6 decorations → positions remap automatically on edits; a finding whose span is edited by the user is marked stale (dimmed).

### 5.4 Editor integration (CM6)

- `ViewPlugin` + `StateField` for highlight decorations (per-editor tint from persona color).
- Gutter/rail: custom DOM in the editor margin (left, like Juri) showing editor dots + panel badges, Summon/Cancel, spinners, count badges.
- Review cards: floating widget (CM6 tooltip API or absolutely-positioned overlay) anchored to spans.
- Inline diffs: widget decorations replacing the span while in preview state; Accept applies a transaction, Reject restores.
- Full parity in Live Preview and Source mode (north star #5): all decorations, cards, and diffs must render and behave identically in both — anchoring against raw markdown makes this natural since Source mode shows exactly what we anchor to. Reading view out of scope for interaction (maybe read-only highlights later).

### 5.5 Async margin comments

- Sidecar store: `.obsidian/plugins/ai-editor/comments.json` (or plugin data dir) keyed by file path; quote+prefix+suffix anchors, fuzzily re-matched on file open (Hypothesis-style).
- Background runs via CliBackend (long-lived) or ApiBackend; live elapsed timer in the card ("Reviewing 0:27"); results survive note switches and Obsidian restarts.
- Right-margin comment column when panel width allows; collapses to icons + side panel on narrow editors.

### 5.6 Side panel (workspace leaf)

One `ItemView` ("AI Editor: Review") showing, per active note:
- current run status per editor/panel, findings list (jump-to-span on click),
- panel scorecards: per-member verdict, aggregated recommendation, top-3 fixes, dissent,
- unanchored findings and note-level summaries,
- history of margin comments for the note.

### 5.7 Settings design (UX matters here too)

Tabs/sections:
1. **Backends** — API providers (keys, models, test button), CLI agents (path detection, health check).
2. **Editors** — gallery of persona cards (color, name, enabled); create/edit modal with: name, color, prompt textarea, **note-ref picker (0-n notes, ordered, with fuzzy note search)**, backend/model override, capability toggles. Import/export JSON.
3. **Panels** — compose from existing editors (multi-select, 1-n), charter (textarea + note refs), aggregation mode. Distinct visual identity.
4. **Actions** — table of built-in verbs (rephrase, summarize, critique, say more, find evidence, identify assumptions, simplify, continue) each with a binding dropdown (editor or panel); add custom actions (name + prompt source + binding); hotkey hints (actual hotkeys via Obsidian's hotkey system).
5. **Voice & Style** — global voice profile: textarea + note refs (e.g. [[My Voice Profile]]); per-editor injection opt-out.
6. **Behavior** — summon scope (whole note / section / selection), concurrency, cost guardrails (max tokens per run), telemetry off.

### 5.8 Starter pack (shipped editors; all fully editable)

Drawn from Maggie's epistemic roles + the user's OSK skills/agents:

1. **Concision Editor** — cut flab, merge redundancy (Juri's demo).
2. **Devil's Advocate** — attack weak arguments, find holes (OSK Hater/Skeptic).
3. **Fact Checker** — flag uncited claims, dated stats, verify when backend has research capability (osk-knowledge-fact-check).
4. **Flow & Structure Editor** — transitions, ordering, scannability (OSK Editor).
5. **Humanizer** — AI-tell detection: metronomic rhythm, banned vocabulary, hedge-stacking (osk-writing-humanizer + osk-writing-rigor).
6. **Beginner Reader** — jargon, assumed context, accessibility (OSK Beginner).

Starter panel: **Pre-publish Review** = Devil's Advocate + Flow & Structure + Beginner Reader + Humanizer → scorecard with publish / needs-work / kill verdicts (mirrors osk-panel-publish).

## 6. Milestones (what, not when; each lands green: tsc + lint + test + build)

- **M0 — Foundations**: domain types + Zod schemas; settings store (Immer); backend abstraction with ApiBackend (Anthropic + OpenAI-compatible + Ollama); finding contract + anchoring pipeline with exhaustive spec tests (anchoring is the risk — de-risk first).
- **M1 — Core review loop**: editor rail + Summon/Cancel + spinners + badges; span highlights; review cards (critique, Suggest/Apply/Dismiss, push-back input); inline diff with Accept/Reject/Refine. Single editor, whole-note scope.
- **M2 — Editors & settings**: persona CRUD UI (gallery, colors, prompt textarea + note-ref picker), voice profile section, starter pack seeding, import/export.
- **M3 — Actions & context menu**: selection context menu + command palette commands; action→editor/panel bindings in settings; custom actions; "Generate more" continuation affordance.
- **M4 — Panels**: panel CRUD (1-n members, charter, aggregation), panel run orchestration (parallel member runs + aggregation call), scorecard in side panel; visual distinction editors-vs-panels everywhere.
- **M5 — CLI backends**: Claude Code + Codex adapters (headless streaming), health checks, per-editor backend override UI; research-grade actions light up.
- **M6 — Async margin comments**: sidecar store, fuzzy re-anchoring, background runs with live timers, margin/side-panel comment UI.
- **M7 — Polish & release**: theming (light/dark, Obsidian CSS vars only), animations (dot spinners, card transitions, diff reveal), performance passes (large notes), docs (README, docs/ user guide), marketplace submission, release workflow.

## 7. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Quote anchoring fails on markdown syntax mismatch (LLM quotes rendered text vs raw source) | Always send raw markdown to the model; instruct quoting verbatim from input; 3-stage matcher + graceful degradation; heavy test corpus |
| CM6 overlay complexity (cards/diffs fighting Live Preview widgets) | Prototype the diff widget early (M1); prefer CM6-native decorations over DOM hacks |
| CLI backend fragility (paths, versions, auth) | Health-check button, clear error surfaces, API backend always available as fallback |
| Cost runaway (N editors × long notes) | Scope control (selection/section), per-run token caps, count badge = findings only after completion, explicit Summon (never auto-run by default) |
| Findings spam / annoying UX | Severity filter, per-editor max findings, "fade on dismiss" everywhere, ignorable-by-design |
| Obsidian review guidelines (no `innerHTML`, sentence-case UI, no "Obsidian" in name/desc) | Template conventions + review-lint before submission |

## 8. Open questions (park for later; don't block M0-M1)

- Diff granularity: word-level vs sentence-level rendering of red/green inline diff.
- Multi-note context: should editors see linked notes / backlinks for context? (Powerful with CliBackend; scope creep risk.)
- Streaming UX: show findings as they arrive vs batch at end (Juri batches; streaming might feel more alive).
- Panel aggregation: second LLM call vs deterministic merge + verdict vote.
- Whether "Get research" (web) is API-backend-gated or CLI-only in practice.
- Publish gates: a "Style Guard" mode that blocks a publish pipeline (integration with obsidian-ghost-publish?) — later.

## 9. References

- Juri Strumpflohner's Quill demos: x.com/juristr statuses 2074494746484236459, 2077036970895872368, 2079297727364464700
- Maggie Appleton, Language Model Sketchbook: https://maggieappleton.com/lm-sketchbook
- Vault: [[AI Assistant Architecture]], DeveloPassion Ghostwriter SOUL, osk-panel-publish, osk-writing-humanizer, osk-writing-rigor, developassion-style-police, user-voice-profile
- Obsidian plugin guidelines: https://docs.obsidian.md/Plugins/Releasing/Plugin+guidelines
