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

| Element                        | Behavior                                                                                                                                                                                                                                                                     |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Persona rail** (left gutter) | Colored dots, one per persona. Hover reveals name (e.g. "DEVIL'S ADVOCATE") + edit/delete icons. A `+` dot creates a new persona.                                                                                                                                            |
| **Summon button**              | Above the rail. Click → all personas review the doc. Button becomes "Cancel"; dots become spinners; when done, each dot shows a **count badge** (findings count, e.g. 8/4/8).                                                                                                |
| **Span highlights**            | Each persona highlights the text spans it has findings for (subtle tinted background).                                                                                                                                                                                       |
| **Review card**                | Click a highlight → floating card near the span: persona name ("Concision Editor"), critique text, quoted passage, buttons **Suggest / Apply / Dismiss**, plus a freeform input "Push back, ask for evidence…" to argue with the persona.                                    |
| **Inline diff**                | "Suggest" → in-place diff: red strikethrough deletions, green insertions, one-line rationale ("Dropped 'just' and 'a bunch of', replaced the vague clause…"), **Accept / Reject**, plus "Refine this suggestion…" input.                                                     |
| **Selection context menu**     | Select text → menu: Rephrase, Say more, Critique, Find evidence, Get research, Identify assumptions, + "Ask the daemon…" freeform. Keyboard shortcuts shown.                                                                                                                 |
| **Generate more**              | A ghost "+ Generate more" affordance between blocks → inline "Generating…" placeholder → continuation drafted in place.                                                                                                                                                      |
| **Async review (v2)**          | Select text + type an instruction → margin comment card showing the quote, the instruction, status **SUBMITTED**, then a live **"Reviewing 0:27"** timer while a background agent works. Result lands back in the card. Google-Docs-comments where the reviewer is an agent. |

### 2.2 Maggie Appleton — Language Model Sketchbook (https://maggieappleton.com/lm-sketchbook)

- **Daemons**: background characters with distinct epistemic roles (devil's advocate, synthesizer, evidence-fetcher, elaborator, encourager). Non-intrusive; suggestions can be ignored and fade.
- **Epi**: context-menu integration — localized, task-specific help (rephrase, critique, evidence, assumption-checking) inside the writing tool.
- Core thesis: chatbots are the wrong interface for writing support; embed affordances in the editor.

### 2.3 The user's OSK AI ecosystem (feature quarry)

The vault already contains a mature agent architecture ([[AI Assistant Architecture]]) whose concepts map 1:1 onto plugin features:

| Vault concept                                                                                                                                                | Plugin analog                                                                               |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| **Agent** = SOUL.md (identity, voice, DO/DON'T, expertise, decision framework, boundaries)                                                                   | **Editor** persona whose prompt can point at vault notes (a SOUL note works as-is)          |
| **Panel** = N agents → individual verdicts + aggregated recommendation + top-3 fixes + dissent (e.g. osk-panel-publish: Editor, Beginner, Power User, Hater) | **Panel** entity: 1-n editors + aggregation step → scorecard view                           |
| `user-voice-profile` context loader (My Voice Profile, Content Strategy, Content Types)                                                                      | **Voice/style configuration** (textarea + 0-n note refs) injected into every editor run     |
| `osk-writing-humanizer` (AI-pattern detection, banned vocabulary, P0/P1/P2 severity, structure-is-the-#1-tell)                                               | Starter editor: **Humanizer** — flags AI-sounding passages, metronomic rhythm, banned words |
| `osk-writing-rigor` (hedge-stacking, uncited claims, magnitude language, weasel openers)                                                                     | Starter editor: **Rigor Auditor**                                                           |
| `developassion-style-police` / `style-guard` (banned words, emdash abuse, signature elements, pass/fail gate)                                                | Starter editor: **Style Enforcer**; a "pre-publish gate" panel                              |
| Agents: Hater, Skeptic, Beginner, Power User, Storyteller, Provocateur                                                                                       | Starter personas for the editor gallery                                                     |
| Scorecards with verdicts (publish / needs work / kill it)                                                                                                    | Panel result UI                                                                             |

## 3. Decisions locked so far (from the grilling session)

| Decision             | Choice                                                                                                                                                                                                                                                |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Audience             | **Public community plugin**, fully configurable; the user's own style rules become his persona configs                                                                                                                                                |
| Backends             | **Both**: direct LLM APIs (BYOK) **and** agent CLIs (Claude Code, Codex). Desktop-only                                                                                                                                                                |
| v1 surfaces          | **All four**: persona rail + summon, selection context menu, async margin comments, generate/continue                                                                                                                                                 |
| Persistence          | **Ephemeral findings** (in-memory CM6 decorations, remapped as you type, gone on close — re-summon is cheap) + **sidecar store** for async comments (survive editor sessions, background agents outlive the note being open)                          |
| Persona model        | Per-editor **model/backend override** (fallback to global default) + starter pack + JSON import/export                                                                                                                                                |
| Anchoring            | **Exact-quote matching** (structured findings quote the text; plugin locates quote in raw markdown, exact → normalized → fuzzy; unmatched findings degrade to a note-level list)                                                                      |
| Naming               | Personas are **"Editors"**; groups are **"Panels"**. Plugin name: **AI Editor**                                                                                                                                                                       |
| Panels               | **In v1** ("I want it all"): user composes panels from 1-n editors; aggregated scorecard (verdicts, top fixes, dissent)                                                                                                                               |
| Action bindings      | Every UI action (rephrase, summarize, critique…) is **mapped in settings to an editor or panel**                                                                                                                                                      |
| Prompt sourcing      | Every prompt field = **textarea AND/OR 0-n vault note refs** ("configure directly as a prompt, or indirectly by documenting things in my vault")                                                                                                      |
| Finding arrival      | **Stream as they land** — highlights pop in progressively, badges count up live; first insight in seconds                                                                                                                                             |
| Run scope            | **Whole note by default; selection overrides** when text is selected. Size warning + confirm above a configurable word count                                                                                                                          |
| Panel aggregation    | **LLM aggregation call** after members finish: charter prompt + member outputs → recommendation, top-3 fixes, dissent. Panel has its own provider/model for this call                                                                                 |
| Extra context        | **Opt-in linked notes per editor** (1 hop, capped) + `[[wikilink]]` references typed in ANY prompt/input field (persona prompts, push-back, refine, custom actions) resolve and attach those notes as context. Wikilink autocomplete in plugin inputs |
| Providers            | 1-n configurable provider instances: **Anthropic, OpenAI + any OpenAI-compatible (custom base URL), Azure AI Foundry (first-class: deployment name, api-version, auth header), Ollama**. Per-editor AND per-panel provider/model selection            |
| Layout               | **Adaptive Juri layout**: pane ≥ ~900px → left rail + floating cards + right margin comment column; narrow panes collapse to highlight-click → card + side-panel list                                                                                 |
| Keyboard             | **Full keyboard triage**: hotkey-assignable commands for next/prev finding, accept, reject, dismiss, suggest, focus push-back. Review = merge-conflict-style rapid triage                                                                             |
| Onboarding           | **Guided setup wizard** on first use: pick/detect backend (Ollama running? `claude` on PATH?), test connection, seed starter editors, 30-second tour on sample text                                                                                   |
| Guardrails           | Size warning + confirm; **exclusions** (folders/tags/`ai_editor: false` frontmatter flag block review; strip-frontmatter option); **nothing runs automatically on note open — every AI action is user-initiated**                                     |
| Conversations        | **Per-finding threads**: push-back → editor reply → counter → revised suggestion, collapsed history in the card. Session-scoped                                                                                                                       |
| Editor modes         | **Full parity in Live Preview AND Source mode** (both CM6); Reading view interaction out of scope                                                                                                                                                     |
| Note-type rules      | **Binding rules** (folder/tag/frontmatter → default editors/panel/bindings) + optional **OSK auto-discovery** (feature-detected, never mandatory) + per-scope **kill switch** (disable the plugin's UI entirely for chosen note types/folders)        |
| Bulk triage          | **Accept/dismiss all per editor** (rail dot menu), **accept all non-conflicting** (one undoable transaction, precondition-checked), **severity filter** (info/suggestion/warning)                                                                     |
| Ambient UI           | **Status-bar item** for the active note: last run's finding count + gate verdict badge; click → side panel. No heat strip in v1                                                                                                                       |
| Settings UX          | **Tabbed settings** (Backends / Editors / Panels / Actions / Voice & Style / Rules / Behavior), well organized                                                                                                                                        |
| Overlapping findings | **Stacked card with tabs**: one blended highlight; the card shows every editor's take on that span (own suggestion + thread each); only one suggestion in diff-preview at a time                                                                      |
| Language             | **Match the note's language automatically** (critiques, suggestions, threads in the text's language) + global override ("always respond in X")                                                                                                        |
| Comment routing      | Async margin comments run on a **configurable default editor**, with a persona chip / @-mention in the input to reroute per comment                                                                                                                   |
| Review surface       | **Body only in v1** — frontmatter/metadata review (description, title, aliases, full properties) is post-v1 (GitHub issue)                                                                                                                            |

## 4. Domain model

```
Editor
  id, name, color, icon?
  promptSource:      { text?: string; noteRefs: NotePath[] }   // concatenated at runtime
  backend:           BackendInstanceRef + model | 'inherit'    // provider instance or CLI agent
  contextPolicy:     { includeLinkedNotes: bool; maxLinkedNotes: number }  // opt-in, 1 hop, capped
  capabilities:      { review: bool; rewrite: bool; research: bool }  // what it may do
  enabled:           bool

Panel
  id, name, color/badge style (visually distinct from Editors everywhere)
  members:           EditorId[]           // 1-n
  charterSource:     { text?: string; noteRefs: NotePath[] }   // aggregation instructions
  aggregationBackend: BackendInstanceRef + model | 'inherit'   // powers the scorecard call
  aggregation:       'scorecard' | 'merged-findings'
  enabled:           bool

BackendInstance (1-n configured in settings)
  ApiBackend:  provider (anthropic | openai-compatible | azure-ai-foundry | ollama),
               label, apiKey?, baseUrl?, deployment?/apiVersion? (azure), defaultModel
  CliBackend:  kind (claude-code | codex | custom), label, executablePath,
               args template, cwd (vault), timeout

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
  suggestedReplacement?, rationale?, status: open|applied|dismissed,
  thread: Message[]      // per-finding push-back conversation (session-scoped)

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

## 4b. Note-type awareness

- **Binding rules** (settings): ordered rules `[match: folder / tag / frontmatter property → default editors/panel + default action bindings]`. The Review button "does the right thing" per note type; rules only pick WHO reviews, never auto-run anything.
- **Optional OSK integration**: when the Obsidian Starter Kit plugin is installed, note types are auto-discovered via a feature-detected adapter (port of `starter-kit.service.ts` from obsidian-kanban-action-planner: `isStarterKitAvailable` / `listNoteTypes` / `recognizeNoteType`, defensive normalization, graceful `null`/`[]` degradation). Rules can then target a recognized note type directly instead of hand-configured folders/tags. **Never mandatory** — everything works without OSK.
- **Kill switch per scope**: rules can also map a note type / folder / tag to **"disabled"** — the plugin's UI (rail, context menu, actions) fully deactivates for those notes (e.g. daily notes, private folders). Complements the privacy exclusions in §5.7.

## 4c. Adversarial review outcomes (2026-07-29)

An adversarial review by codex (`gpt-5.6-sol`, xhigh) — full findings in `documentation/reviews/2026-07-29-plan-review-codex-gpt-5.6-sol.md` — surfaced 8 blockers / 24 majors. Adopted into this plan:

1. **Operation-shaped contract, not one `review()`**: versioned discriminated operations — `Review`, `TransformSelection`, `InsertAt` (continuation), `RefineProposal`, `ThreadTurn`, `AggregatePanel` — each with its own result schema, stable IDs, and a typed `PanelResult` (member verdicts, top fixes, dissent, provenance).
2. **Live Preview / Source mode = equivalent semantics, not identical rendering** (widgets hide syntax in LP). Mode detection via `editorLivePreviewField`; a markdown fixture corpus exercises marks across links/embeds/headings/callouts in both modes.
3. **Snapshot & concurrency model**: every run pins a content snapshot + hash; anchors map through every CM6 `ChangeDesc`; a proposal whose range was edited goes **stale** (never silently fuzzy-relocated); Accept verifies the precondition text still matches.
4. **Transport reality**: Obsidian's `requestUrl` doesn't stream; renderer `fetch` has CORS caveats per provider. M0 includes a transport spike per provider; **buffered structured output is the first-class baseline**, streaming is a per-provider progressive enhancement ("first insight in seconds" is an aspiration, not a requirement).
5. **CLI backends are a security boundary**: spawn without shell, content via stdin, isolated working directory (not the vault), allowlisted env, read-only sandbox flags, tools/session persistence off by default, process-tree kill on cancel/unload, versioned protocol conformance tests, separate consent flow for tool/research mode. CLI support is **opt-in and late** in the milestone order.
6. **`isDesktopOnly: true` from M0** (manifest currently says false — fix immediately).
7. **Provider adapters are explicit profiles** (native OpenAI, narrowly-defined OpenAI-compatible, Anthropic, Ollama, Azure OpenAI deployment-based), each with capability negotiation (streaming? JSON schema? usage?), normalized errors, `AbortSignal`, health check, and exactly-once terminal events.
8. **Context assembly is budgeted and previewable**: token/byte budget across the whole context graph (not note counts), dedup/cycle handling, and a per-run "what will be sent" preview; exclusions are enforced before context resolution (excluded notes can't ride in via wikilinks).
9. **Settings integrity**: stable UUIDs, schema versions + migrations, referential integrity on delete (impact dialogs), import validation/remapping, idempotent starter-pack seeding.
10. **Wikilink references via a dedicated note-ref control** (`AbstractInputSuggest`-based) or a purpose-built contenteditable prompt editor — not naive textarea autocomplete.
11. **Key storage disclosure**: keys live in `data.json` (may sync) — documented prominently; keys/prompts redacted from logs; warning on non-loopback HTTP endpoints.
12. **Canonical docs** (`Architecture.md`, `Domain Model.md`, `Configuration.md`, `Business Rules.md`) get the locked invariants at M0, before feature code.

## 5. Architecture

### 5.1 Backend abstraction

```
interface ReviewBackend {
  review(req: ReviewRequest): AsyncIterable<BackendEvent>
  // BackendEvent: finding | progress | token | done | error
}
```

- **ApiBackend** (v1 core): direct `fetch` to provider APIs, streaming. Structured output via JSON schema / tool-call where supported; strict Zod validation of findings. **Findings are parsed incrementally from the stream** and emitted as soon as each is complete (streaming-first UX). Provider adapters: Anthropic, OpenAI-compatible (custom base URL — covers OpenAI, OpenRouter, Groq, LM Studio…), Azure AI Foundry (deployment name + api-version + auth header), Ollama.
- **CliBackend** (v1, desktop-only): spawn `claude` / `codex` in headless mode (`claude -p --output-format stream-json`) with the note (or selection) as context, cwd = vault root. Parse streamed JSON into BackendEvents. This is what powers "Get research"-grade actions (web, tools) and long async reviews.
- Per-editor backend override; global default backend in settings.
- All requests carry: system prompt (assembled per §4), the note content (raw markdown), optional selection range, an extensible `context[]` (resolved `[[wikilink]]` refs from prompts/inputs, opt-in linked notes per the editor's contextPolicy), and the structured-findings output contract.
- **Nothing runs on note open.** Every backend call is triggered by an explicit user action (Review, an action verb, a push-back, a comment submission).

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

1. **Backends** — **1-n provider instances** (add multiple, label them): Anthropic / OpenAI-compatible / Azure AI Foundry / Ollama, each with keys, base URL/deployment, default model, test button; CLI agents (path detection, health check). First-use **setup wizard** (detect Ollama + `claude`/`codex` on PATH, test connection, seed starter editors, sample-text tour).
2. **Editors** — gallery of persona cards (color, name, enabled); create/edit modal with: name, color, prompt textarea, **note-ref picker (0-n notes, ordered, with fuzzy note search)**, backend/model override, capability toggles. Import/export JSON.
3. **Panels** — compose from existing editors (multi-select, 1-n), charter (textarea + note refs), aggregation mode. Distinct visual identity.
4. **Actions** — table of built-in verbs (rephrase, summarize, critique, say more, find evidence, identify assumptions, simplify, continue) each with a binding dropdown (editor or panel); add custom actions (name + prompt source + binding); hotkey hints (actual hotkeys via Obsidian's hotkey system).
5. **Voice & Style** — global voice profile: textarea + note refs (e.g. [[My Voice Profile]]); per-editor injection opt-out.
6. **Behavior** — size-warning threshold, concurrency, max tokens per run, **exclusions** (folders, tags, `ai_editor: false` frontmatter flag; strip-frontmatter toggle), hotkey pointers for the keyboard triage commands. No telemetry.

All plugin text inputs (persona prompts, charters, push-back, refine, custom actions) support **`[[wikilink]]` autocomplete**; referenced notes are resolved and attached as context at run time.

### 5.8 Starter pack (shipped editors; all fully editable)

Drawn from Maggie's epistemic roles + the user's OSK skills/agents:

1. **Concision Editor** — cut flab, merge redundancy (Juri's demo).
2. **Devil's Advocate** — attack weak arguments, find holes (OSK Hater/Skeptic).
3. **Fact Checker** — flag uncited claims, dated stats, verify when backend has research capability (osk-knowledge-fact-check).
4. **Flow & Structure Editor** — transitions, ordering, scannability (OSK Editor).
5. **Humanizer** — AI-tell detection: metronomic rhythm, banned vocabulary, hedge-stacking (osk-writing-humanizer + osk-writing-rigor).
6. **Beginner Reader** — jargon, assumed context, accessibility (OSK Beginner).

Starter panel: **Pre-publish Review** = Devil's Advocate + Flow & Structure + Beginner Reader + Humanizer → scorecard with publish / needs-work / kill verdicts (mirrors osk-panel-publish).

## 6. Milestones (what, not when; each lands green: tsc + lint + test + build; reordered per the adversarial review)

- **M0 — Contracts & spikes**: locked invariants written into `documentation/` canonical docs; operation contract (discriminated ops + JSON Schemas + Zod, stable IDs, versioning); anchoring pipeline (snapshot hash, occurrence disambiguation, `ChangeDesc` mapping, stale detection) with property/fuzz tests; **three de-risking spikes**: (a) transport per provider (streaming vs buffered, CORS), (b) CM6 decorations + rail + tooltip in Live Preview AND Source mode against a markdown fixture corpus, (c) CLI headless protocol probe. `isDesktopOnly: true`.
- **M1 — Provider & settings vertical slice**: 1-n provider instances (Anthropic, OpenAI, OpenAI-compatible, Azure OpenAI, Ollama) with capability negotiation, health checks, normalized errors, `AbortSignal`; tabbed settings shell; minimal editor entity + starter pack seeding.
- **M2 — Buffered single-editor review**: Review/Cancel from the rail, span highlights, side panel findings list (also the narrow-layout fallback), whole-note + selection scope, size warning + confirm, exclusions + per-type kill switch.
- **M3 — Streaming & anchors under edit**: per-provider streaming decoders where verified, live badges, cancellation races, stale-marking while the user types, precondition-checked apply.
- **M4 — Cards, diffs & keyboard triage**: floating review cards (single active tooltip, collision-aware), non-destructive inline diff (source stays visible; CM6-undo-integrated Accept), per-finding threads, full keyboard triage state machine, bulk operations (per-editor accept/dismiss-all, accept-all-non-conflicting as one undoable transaction, severity filter), status-bar finding-count item, adaptive layout via `ResizeObserver`.
- **M5 — Editors/actions/context CRUD**: persona gallery (colors, prompt textarea + dedicated note-ref control), voice profile section, action→editor/panel bindings, custom actions, note-type binding rules + optional OSK auto-discovery adapter, `[[link]]`-in-inputs context with budget + "what will be sent" preview, import/export with validation, setup wizard.
- **M6 — Panels**: panel CRUD (1-n members, charter, per-panel aggregation backend), parallel member runs + typed `PanelResult` scorecard (verdicts, top fixes, dissent, partial-failure policy), editors-vs-panels visual distinction, "Generate more" / `InsertAt` continuation affordance.
- **M7 — CLI backends (opt-in)**: Claude Code + Codex adapters behind the security boundary (stdin content, isolated cwd, allowlisted env, read-only sandbox, process-tree kill, protocol conformance tests), separate consent for tool/research mode.
- **M8 — Durable margin comments**: sidecar repository (schema version, migrations, rename handling, corruption recovery), interrupted-job semantics on restart (Retry, never fake resumption), background runs with live timers, margin column UI.
- **M9 — Polish & release**: theming via Obsidian CSS vars, reduced-motion + ARIA + non-color persona indicators, performance passes (large notes, many findings), docs (README, docs/ user guide), community-review checklist sweep, marketplace submission. **Post-implementation adversarial codex review (same model/effort) before release.**

## 7. Risks & mitigations

| Risk                                                                                       | Mitigation                                                                                                                                       |
| ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Quote anchoring fails on markdown syntax mismatch (LLM quotes rendered text vs raw source) | Always send raw markdown to the model; instruct quoting verbatim from input; 3-stage matcher + graceful degradation; heavy test corpus           |
| CM6 overlay complexity (cards/diffs fighting Live Preview widgets)                         | Prototype the diff widget early (M1); prefer CM6-native decorations over DOM hacks                                                               |
| CLI backend fragility (paths, versions, auth)                                              | Health-check button, clear error surfaces, API backend always available as fallback                                                              |
| Cost runaway (N editors × long notes)                                                      | Scope control (selection/section), per-run token caps, count badge = findings only after completion, explicit Summon (never auto-run by default) |
| Findings spam / annoying UX                                                                | Severity filter, per-editor max findings, "fade on dismiss" everywhere, ignorable-by-design                                                      |
| Obsidian review guidelines (no `innerHTML`, sentence-case UI, no "Obsidian" in name/desc)  | Template conventions + review-lint before submission                                                                                             |

## 7b. Later: knowledge-integration features (post-v1, tracked as GitHub issues)

Beyond reviewing prose, editors should help integrate the note into the vault's knowledge graph:

1. **Tag review** — an editor reviews/improves the note's tags: suggests existing vault tags that fit (never inventing new ones without flagging), flags redundant/missing ones. Respects vault tag conventions.
2. **Related-notes discovery** — find vault notes relevant to the current note and propose them as wikilinks, targeted at a specific section (e.g. `## Related`); accept/reject per suggestion, like findings.
3. **References management** — add/update a full references list at the end of the note:
    - **Internal**: every vault note mentioned/linked in the body, consolidated.
    - **External**: URLs the user added manually + **every external source an LLM used as input/reference while editing/writing** (source-citation tracking: backends must report the sources behind their suggestions so citations are effortless and honest).
4. Prerequisite plumbing: the operation contract's evidence entries (review finding #27) double as the citation source for external references.

Additional post-v1 features (each a GitHub issue):

5. **Per-editor learning loop** — optional per editor: distill accept/reject patterns + push-back arguments into a memory store (user chooses per editor: plugin settings OR a dedicated vault note) that is injected into future runs. Transparent and editable — you can read exactly what an editor "learned".
6. **Interview-first drafting** — an action that runs a structured one-question-at-a-time interview (angle, audience, unique take) in the card/side panel before drafting; answers feed the generation context. Mirrors the Ghostwriter's "interview first, write later" rule; builds on the per-finding thread machinery.
7. **Community packs** — in-plugin pack browser with a rich explanatory UI (what each editor/pack is, what it's for). Packs are contributed via PRs to this repo under a `community/` parent folder (dedicated subfolders per editor and per pack); the plugin loads the registry from there. Contribution guide in the docs.
8. **Publish gates** — settings to define gates (designate a panel as gate, optionally per note-type rule); a public plugin API other plugins can call ("latest gate verdict for file X", "run gate"); status-bar verdict badge. First consumer: obsidian-ghost-publish ("Style Guard failed" warning before publishing).
9. **Metadata review** — editors propose frontmatter improvements: first description/title/aliases (prose-ish, publishing value), later any property as a structured, schema-aware diff (OSK type definitions when available). Companion of the tag-review issue.
10. **Session summary** — on-demand command: distill a review session (per-editor accepted/rejected counts, key changes) into a formatted digest, copied to clipboard or appended to a chosen note (e.g. the daily note).

## 8. Open questions (park for later; don't block M0-M1)

- Diff granularity: word-level vs sentence-level rendering of red/green inline diff (leaning word-level, like Juri).
- Post-run usage display: show actual token usage per run (providers return it) — nice trust-builder, not required.
- Whether "Get research" (web) is API-backend-gated or CLI-only in practice.
- Publish gates: a "Style Guard" mode that blocks a publish pipeline (integration with obsidian-ghost-publish?) — later.
- Backlinks (not just outgoing links) as opt-in context.

## 9. References

- Juri Strumpflohner's Quill demos: x.com/juristr statuses 2074494746484236459, 2077036970895872368, 2079297727364464700
- Maggie Appleton, Language Model Sketchbook: https://maggieappleton.com/lm-sketchbook
- Vault: [[AI Assistant Architecture]], DeveloPassion Ghostwriter SOUL, osk-panel-publish, osk-writing-humanizer, osk-writing-rigor, developassion-style-police, user-voice-profile
- Obsidian plugin guidelines: https://docs.obsidian.md/Plugins/Releasing/Plugin+guidelines
