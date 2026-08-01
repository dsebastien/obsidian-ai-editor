# AI Editor — v1 Reference (vision, locked decisions, architecture)

> Status: **v1 is built and unshipped.** This is not a plan to execute — it is why the plugin is shaped the way it is: the vision (§1), the work it was drawn from (§2), the product decisions locked with Sébastien (§3), the domain model (§4, §4b-§4f), the architecture (§5), the fleet support-CTA convention (§6), the risk register (§7) and the parked design questions (§7b, §8).
>
> **What the code actually does is documented elsewhere, and those documents win when they disagree with this one:** `documentation/Architecture.md` (structure, run lifecycle, UI contracts, accessibility and performance contracts), `documentation/Domain Model.md` (entities), `documentation/Business Rules.md` (invariants), `documentation/Configuration.md` (settings as the user sees them), `documentation/plans/interaction-surfaces-design.md` (menus, commands, CLI). Manual checks a human still has to run live: `documentation/live-verification-checklist.md`. Everything still open — post-v1 features and the bugs found in live testing — is in GitHub issues, not here.

## 0. Current state

**The gate.** `bun run format`, then `bun run validate` (tsc + eslint `--max-warnings 0` + the spec suite, 2 341 specs green), then `bun run build`. Nothing merges that does not pass all three.

**Nothing has been pushed.** Every commit of the whole build is local.

**Remaining — Sébastien personally. Not agent scope: do not plan or attempt it.**

1. **Push.**
2. **Marketplace submission** — run `documentation/community-review-checklist.md`; its "Before submitting" section is the order. The naming blocker it opened with is closed (see Identity below).
3. **Docs-site publishing, screenshots, video.**
4. **Live-vault verification** — the plugin has never been exercised end to end by an agent, and cannot be: Obsidian is a GUI app. Every manual check is in `documentation/live-verification-checklist.md`, starting with its "End-to-end review flow" section; CLI backends need real binaries, margin comments need a real sync, theming needs real community themes, and the performance work needs a real vault.

**Identity, settled 2026-07-31.** The catalog blocker (`buszk/obsidian-ai-editor` owns the `ai-editor` id and the "AI Editor" name) was resolved by renaming the plugin `id` to `editor-ai-daemons` while keeping the display name "AI Editor". The **GitHub repository name did not change** — every repo URL, funding link, docs `baseurl` and the temp-dir prefix still read `obsidian-ai-editor`. Command ids embed no plugin id and needed nothing. Evidence and the re-run catalog check: `documentation/community-review-checklist.md` § 0.

**Standing policy — no users yet (Sébastien, 2026-07-29).** Until the plugin ships, never spend effort on backwards compatibility, migrations or behaviour-preserving defaults: pick the best design outright and change schemas freely. The schema-version machinery stays for post-release.

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

| Decision             | Choice                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Audience             | **Public community plugin**, fully configurable; the user's own style rules become his persona configs                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Backends             | **Both**: direct LLM APIs (BYOK) **and** agent CLIs (Claude Code, Codex). Desktop-only                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| v1 surfaces          | **All four**: persona rail + summon, selection context menu, async margin comments, generate/continue                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Persistence          | **Ephemeral findings** (in-memory CM6 decorations, remapped as you type, gone on close — re-summon is cheap) + **sidecar store** for async comments (survive editor sessions, background agents outlive the note being open)                                                                                                                                                                                                                                                                                                                                 |
| Persona model        | Per-editor **model/backend override** (fallback to global default) + starter pack + JSON import/export                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Anchoring            | **Exact-quote matching** (structured findings quote the text; plugin locates quote in raw markdown, exact → normalized → fuzzy; unmatched findings degrade to a note-level list)                                                                                                                                                                                                                                                                                                                                                                             |
| Naming               | Personas are **"Editors"**; groups are **"Panels"**. Plugin name: **AI Editor** (manifest `id` `editor-ai-daemons` since 2026-07-31 — §0, and `community-review-checklist.md` § 0 for the evidence)                                                                                                                                                                                                                                                                                                                                                          |
| Panels               | **In v1** ("I want it all"): user composes panels from 1-n editors; aggregated scorecard (verdicts, top fixes, dissent)                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Action bindings      | Every UI action (rephrase, summarize, critique…) is **mapped in settings to an editor or panel**                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Prompt sourcing      | Every prompt field = **textarea AND/OR 0-n vault note refs** ("configure directly as a prompt, or indirectly by documenting things in my vault")                                                                                                                                                                                                                                                                                                                                                                                                             |
| Finding arrival      | **Aspiration, downgraded by §4c item 4 and NOT how v1 behaves**: findings arrive when an editor FINISHES. Buffered structured output is the baseline; where a provider's stream is verified it feeds progress, not incremental findings — extracting findings from a partial document is out of scope                                                                                                                                                                                                                                                        |
| Run scope            | **Whole note by default; selection overrides** when text is selected. Size warning + confirm above a configurable word count                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Panel aggregation    | **LLM aggregation call** after members finish: charter prompt + member outputs → recommendation, top-3 fixes, dissent. Panel has its own provider/model for this call                                                                                                                                                                                                                                                                                                                                                                                        |
| Extra context        | **Opt-in linked notes per editor** (1 hop, capped) + `[[wikilink]]` references typed in ANY prompt/input field (persona prompts, push-back, refine, custom actions) resolve and attach those notes as context. Wikilink autocomplete in plugin inputs                                                                                                                                                                                                                                                                                                        |
| Providers            | 1-n configurable provider instances: **Anthropic, OpenAI + any OpenAI-compatible (custom base URL), Azure AI Foundry (first-class: deployment name, api-version, auth header), Ollama**. Per-editor AND per-panel provider/model selection                                                                                                                                                                                                                                                                                                                   |
| Layout               | **Adaptive Juri layout**: narrow panes collapse to highlight-click → card + side-panel list. **Threshold superseded (stage D slice 4)**: the original ~900px governed the THREE-column layout (left rail + floating cards + right margin comment column); without the M8 margin column the chrome fits down to ~500px, so the shipped collapse is ≤500px → compact rail + pane-clamped cards, back to wide at ≥560px (hysteresis). ~900px is re-evaluated when the M8 margin comment column lands — it may need its own, higher threshold on top of this one |
| Keyboard             | **Full keyboard triage**: hotkey-assignable commands for next/prev finding, accept, reject, dismiss, suggest, focus push-back. Review = merge-conflict-style rapid triage                                                                                                                                                                                                                                                                                                                                                                                    |
| Onboarding           | **Guided setup wizard** on first use: pick/detect backend (Ollama running? `claude` on PATH?), test connection, seed starter editors, 30-second tour on sample text                                                                                                                                                                                                                                                                                                                                                                                          |
| Guardrails           | Size warning + confirm; **exclusions** (folders/tags/`ai_editor: false` frontmatter flag block review; strip-frontmatter option); **nothing runs automatically on note open — every AI action is user-initiated (sole opt-in exception: daemon mode, BR #1 carve-out)**                                                                                                                                                                                                                                                                                      |
| Conversations        | **Per-finding threads**: push-back → editor reply → counter → revised suggestion, collapsed history in the card. Session-scoped                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Editor modes         | **Full parity in Live Preview AND Source mode** (both CM6); Reading view interaction out of scope                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Note-type rules      | **Binding rules** (folder/tag/frontmatter → default editors/panel/bindings) + optional **OSK auto-discovery** (feature-detected, never mandatory) + per-scope **kill switch** (disable the plugin's UI entirely for chosen note types/folders)                                                                                                                                                                                                                                                                                                               |
| Bulk triage          | **Accept/dismiss all per editor** (rail dot menu), **accept all non-conflicting** (one undoable transaction, precondition-checked), **severity filter** (info/suggestion/warning)                                                                                                                                                                                                                                                                                                                                                                            |
| Ambient UI           | **Status-bar item** for the active note: last run's finding count + gate verdict badge; click → side panel. No heat strip in v1                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Settings UX          | **Tabbed settings** (Backends / Editors / Panels / Actions / Voice & Style / Rules / Behavior), well organized                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Overlapping findings | **Stacked card with tabs**: one blended highlight; the card shows every editor's take on that span (own suggestion + thread each); only one suggestion in diff-preview at a time                                                                                                                                                                                                                                                                                                                                                                             |
| Language             | **Match the note's language automatically** (critiques, suggestions, threads in the text's language) + global override ("always respond in X")                                                                                                                                                                                                                                                                                                                                                                                                               |
| Comment routing      | Async margin comments run on a **configurable default editor**, with a persona chip / @-mention in the input to reroute per comment                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Review surface       | **Body only in v1** — frontmatter/metadata review (description, title, aliases, full properties) is post-v1 (GitHub issue)                                                                                                                                                                                                                                                                                                                                                                                                                                   |

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
  charterSource:     { text?: string; noteRefs: NotePath[] }   // shared brief: augments EVERY member's prompt AND is the aggregation system prompt
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
- A panel run is ONE run: its members are ordinary editor streams on the same anchoring/finding/concurrency machinery, its charter augments every member's system prompt through `buildEditorPrompt`, and the run owns the aggregation step that follows them. Members keep their own identity — findings are never merged or re-attributed to the panel.

## 4b. Note-type awareness

- **Binding rules** (settings): ordered rules `[match: folder / tag / frontmatter property / note type → default reviewer]`. The Review button "does the right thing" per note type; rules only pick WHO reviews, never auto-run anything. **Shipped decisions**: a matching `disabled` rule wins from ANY list position (a kill switch must not be shadowed by an unrelated assignment ordered above it); among `assign` rules the FIRST match in list order wins (the tab exposes explicit ordering, so list order IS the user's priority statement — specificity sorting was considered and rejected as making the visible order a lie); assignments never accumulate; no match → every enabled review-capable editor (the pre-rules behavior). Assignments supply the DEFAULT pool only: an explicit ask-an-editor / bound action and a daemon re-dispatch both win. Cold metadata cache fails CLOSED for kill switches, OPEN for assignments. Default action bindings per rule were NOT shipped — `bindingRuleSchema.defaultTarget` is one target, and action bindings are already per-verb in the Actions tab; adding a second, rule-scoped binding layer needs its own design.
- **Optional OSK integration**: `ui/osk-note-types.ts` (`isStarterKitAvailable` / `listNoteTypes`, defensive normalization, graceful `[]` degradation) plus the pure `domain/rules/note-type.ts`. `recognizeNoteType` was deliberately NOT ported: it is asynchronous and every consumer is a synchronous decision (menu build, command gate, rail render), so recognition happens locally by matching the registry's own tag/folder/filename-regex mappings (`formula` mappings are not evaluable and recognize nothing). A note's type identity is a SET of identifiers — the registry's canonical names (`Personal Notes` → `personal-notes`) plus the `type/<x>` tag convention (`type/personal` → `personal`) — and a rule matches any of them, because OSK names types differently from how it tags them. **Never mandatory** — without the plugin, rules match the tag spelling.
- **Kill switch per scope.** A matching `disabled` rule deactivates the rail, the context-menu items, the palette commands (review, actions, triage, bulk, filter), the side-panel binding and the finding card, and refuses every dispatch path (review, transform/generate, push-back thread, daemon, CLI) with a typed `rule-disabled` status distinct from the privacy exclusion of §5.7. `Cancel review` stays available on purpose — stopping an in-flight request is never the wrong outcome. An existing run stays BOUND while hidden so its anchors keep remapping and removing the rule restores a coherent run.

## 4c. Contract and safety constraints

The constraints the design is held to. Each one exists because the alternative was shown to break something; they are not preferences.

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

## 4d. Context budget & "what will be sent"

- **Priority order — decided and documented, `services/context/context-budget.ts`.** Sent in this order, and the LAST sections lose first: (1) the **system prompt** (voice-profile text + persona text + memory text as one string) — never truncated, because half a persona silently produces a different editor; (2) the **reviewed note** — never truncated, because findings must quote the submitted snapshot verbatim and anchors resolve against it (Business Rules #3/#4), and because the assembler _cannot_ trim it anyway (the note travels in the operation payload, `operation.text`, not in the system prompt — the budget only ACCOUNTS for it); (3) **attachments** in assembly order = `prompt-ref` → `wikilink-ref` → `followed-link` → `linked-note`. Since the first two are never truncated, the ordered truncatable region IS the attachment list, so ONE list serves as both send order and priority order — deliberate coupling, because two orders would let the preview list notes in an order that does not explain which of them got dropped.
- **Voice-profile notes outrank persona notes** (they come first inside `prompt-ref`, mirroring the system prompt's text order). Considered and rejected: hoisting persona refs above the voice profile because "the persona IS the editor" — the persona's TEXT is never truncated at all, and the voice profile is one small globally-configured note set while persona refs are per-editor and typically more numerous, so dropping the persona's fifth reference before the single voice-profile note is the better failure. A user who disagrees turns `injectVoiceProfile` off for that editor.
- **Over budget is reported, not absorbed.** When the never-truncated sections alone exceed `contextBudgetChars`, every attachment is dropped and `overBudgetChars` says by how much; the run still goes out (refusing to review a long note would be worse) and the preview states it plainly.
- **Truncated ≠ dropped.** An attachment allocated 0 characters is `dropped`, never `truncated`: "truncated" promises a prefix arrives. Every candidate is reported with its REAL source size even when dropped — that number is what tells the user whether to raise the budget or cut a reference. A note that cannot be read at all is not a section (the budget did not do that).
- **Editor-level linked notes** are part of this: `includeLinkedNotes` / `maxLinkedNotes` attach the reviewed note's outgoing links AND embeds (`ObsidianVaultReader.getOutgoingLinks` merges `links` + `embeds`), depth 1, markdown only, deduped against everything already included, capped, budget-aware, and excluded notes never inlined — with excluded notes not consuming the cap. Attachment blocks now additionally carry a `role` (the attachment reason) so the model can tell persona reference material from the reviewed note's own subject matter.
- **One prompt-build entry point.** `buildEditorPrompt` (review-service) is the only path from settings + note to a system prompt; reviews, transforms/generations, push-back threads and the preview all call it. This is the enabling decision for the preview being trustworthy at all: a spec captures the system prompt of a REAL dispatch (via a capturing `fetch`) and asserts the preview's string equals it byte for byte, so drift is a test failure rather than a discovered lie.
- **Two preview entry points, deliberately different.** `preview-context` (palette: "Preview what will be sent") reads the LIVE editor buffer, because unsaved edits are what a run would send. The **Preview** button in the editor dialog reads the vault but previews the UNSAVED draft persona, because previewing the editor you are currently writing is the only useful answer there. Both refuse with their own message on a **privacy exclusion** (Behavior tab) — "nothing would be sent" is the most important thing a preview can say, so the palette command stays available on an excluded note precisely to say it. A **rule kill switch** is the other case and behaves the other way: §4b removes the plugin's commands from a note a rule switches off, so the palette command disappears; the `rule-disabled` status still exists for the settings dialog and for a rule that lands while the modal is open. (Corrected 2026-07-30 in the stage E fix pass: the command had been gated on both, which hid the exclusion refusal it was supposed to deliver.) The modal sends nothing: its only injected dependency is `previewEditorContext`.
- **The preview covers bound actions, not just plain reviews** (added 2026-07-30, stage E fix pass). The palette modal has an **Action** picker; picking one resolves the instruction through the same `resolveBoundActionVerb` the dispatch uses. This matters because a CUSTOM action inlines its referenced vault notes into its instruction (`CUSTOM_INSTRUCTION_MAX_CHARS` = 10 000), which is vault content leaving the vault that no surface showed. A review-class instruction is appended to the system prompt exactly as `startReview` appends it; a transform/generate instruction rides the operation payload and is reported separately with its size, because "it is in the prompt" and "it is in the request" are different answers. The editor dialog's Preview button has no action picker: its question is about the draft persona.

## 4e. Custom actions & settings transfer

- **A custom action states what it does.** `actionBindingSchema.customVerbClass` (`transform` | `generate` | `review`) is **required, with no default**: custom actions used to be transform-class by construction, so an action whose instruction said "check this for factual errors" replaced the checked text with the answer. Defaulting to `transform` would keep that bug behind a nicer UI. An action without a class resolves to the typed `custom-class-missing` reason and is offered nowhere until the user picks one — the same treatment a blank name or instruction already got.
- **One verb interface for both kinds.** `resolveActionVerb(actionId, custom?)` in the verb registry is the only way a dispatch path turns an action id into the verb it runs: registry entry for a built-in id, the custom action's own `ActionVerb` (label + class + vault-resolved instruction) otherwise. Built-ins win over a supplied custom verb, so a persisted binding can never redefine what "Humanize" does. In the controller, verb resolution moved AHEAD of the class split, which is what lets a review-class custom action carry its vault-resolved instruction into `startReview` — and lets a review-class custom action bind a panel, since the panel rule was already written in terms of the class.
- **`followLinks` on a custom instruction is live**, with the same semantics as context assembly (depth 1, embeds, `FOLLOWED_LINKS_CAP` per referenced note, exclusions decided before any read, each note once). One toggle, one meaning plugin-wide. The direct instruction text is serialized FIRST so the instruction cap (`CUSTOM_INSTRUCTION_MAX_CHARS`) can only ever cut reference material, never the directive.
- **Export strips API keys inside `exportSettings`** — the only function that produces an export — so no caller can forget (Business Rules #12). **Import clears them too**, even when the file carries one: a `data.json` copied from another vault must not silently bill its owner's account. Both dialogs say so on screen. The advanced `extraBodyJson` escape hatch travels as-is: it is functional request configuration, and blanking it would break the backend it configures.
- **Imports add, they never overwrite.** Every imported entity gets a fresh id and references INSIDE the import are remapped onto them, so importing a file twice yields two independent sets rather than a half-merge onto whatever shared an id. `resolveIdCollisions`' load-time semantics (keep-first, leave references alone) are deliberately NOT reused as-is: there a duplicate id means "the same entity twice from a sync merge", here it means "a different entity from another vault", and keeping the reference would point an imported panel at the user's own editor. A reference to something outside the import survives only when that id exists in the current settings — which is what makes re-importing panels into the vault their members still live in do the right thing — and is otherwise cleared with a typed adjustment.
- **Unselected sections are absent from the file, not empty**, and `voiceProfile` is the one value that REPLACES (a single value cannot be "added"); the confirmation states it in capitals before anything is written.
- **Section caps are enforced while planning**, not at save time: the facade rejects a schema-invalid update wholesale, so an oversized import would fail with "could not save" instead of naming the entities that did not fit. The cap constants mirror the schema and a spec pins the mirror against `pluginSettingsSchema` itself.
- **The format marker is not required on import.** A plugin `data.json` from another vault is a legitimate source and carries none; an object with no recognizable section is the error case, because that is when the user picked the wrong file.

## 4f. Setup wizard

- **Six steps**: welcome (what the plugin does + the plain-text-key disclosure) → add a backend (provider picker including OpenRouter, key, model, **Test connection**) → pick which editors are on → optional voice-profile note picker (with Follow links explained) → summon vs daemon with the cost stated → done + pointers. Triggered on the first load where `onboarded === false`, plus the `Run setup wizard` command and a Behavior → Setup button.
- **Nothing is written until Finish.** The wizard accumulates a draft; `applySetupWizard` is one pure whole-value function applied in one settings update. Cancelling at any step (Escape, the X, Cancel) therefore cannot leave a half-configured plugin, because there is no sequence of partial writes to interrupt. Commit-per-step was considered and rejected: it requires every step to be independently valid, and the backend step is not — a label with no model is a backend that exists and cannot run.
- **A step may be left EMPTY, but not HALF-FILLED.** Every step except the backend is optional by nature (defaults exist for all of them). The backend step is optional too — it can be skipped outright — but refuses to advance with an incomplete backend, because that is the one input where "some of it" is worse than none. The refusal uses the SAME rule as the Backends tab (`domain/settings/backend-validation.ts`, now the single source: per-kind requirements plus their wording, with the tab's dialog calling it instead of its own copy), **plus one wizard-only requirement: a model** (added 2026-07-30, stage E fix pass). The Backends tab legitimately saves a model-less backend, since a model can be set per editor; the wizard cannot, because it wires what it adds as the global default — "a label with no model is a backend that exists and cannot run" is this step's own stated example, and it was not enforced. **What the wizard persists is the VALIDATED backend**, not the draft: validation used to normalize a copy and discard it, so a pasted base URL kept its whitespace and every request from it threw `ERR_INVALID_URL`.
- **`onboarded` is set on ANY exit**, not only on Finish — which is exactly what the schema field already said it meant ("completed or was skipped"). A wizard the user dismissed must not reappear on every launch, and re-running it is a command and a settings button away. Re-runs are edits, not resets: the draft seeds from current settings, and the wizard never edits an EXISTING backend (that is the Backends tab's job; silently rewriting a configured backend from a first-run flow would be a surprise).
- **A wizard-added backend becomes the global default when there is none.** Editors inherit their backend, so a wizard that added one without wiring it as the default would hand back a configured backend that nothing uses — the exact "it says it is set up but nothing runs" state the wizard exists to prevent. An existing default is never repointed.
- **Test connection is ONE cheap real request through `createApiEditorExecutor`** — the same path a review takes — over a one-sentence probe document. A hand-rolled ping (models-list GET, bare completion) would answer a question nobody asked: it goes green for an endpoint that authenticates fine and then fails every review because the model cannot produce the structured output the operation contract requires. **Three outcomes, not two**: `ok`, `failed` (credentials / network / timeout / configuration), and `unusable` — reachable endpoint, answer the plugin cannot parse — which is a different fix (a stronger model) from a connection problem and gets its own status and its own color. The probe timeout is **60 s**, deliberately not `behavior.requestTimeoutSeconds` (10 minutes by default): a connection test that can hang for ten minutes is not a test. The timeout message says a slow local model may still work for real runs with a higher request timeout, so Ollama-on-CPU is never mistaken for broken.
- **The last step tells the truth about whether anything will run**, asked of `hasReviewCapableEditor` over the settings the wizard is ABOUT to write — the predicate that knows about disabled backends, dangling references, missing models and per-editor overrides. Re-deriving an approximation inside the wizard is how a "you are all set" screen starts lying.
- **Keyboard**: every control is focusable and the forward button is focused on each step, so the defaults path is Enter, Enter, Enter through native button activation. A modal-wide Enter binding was rejected: with the CTA focused it fires alongside the button's own activation and advances two steps at once.
- Field edits deliberately skip the re-render (text inputs must keep focus), which is why **Test connection reads the backend at click time** and keys its in-flight guard on the backend **id** rather than object identity: a captured draft would test the model as it read one keystroke ago, and identity comparison would discard the verdict on every keystroke typed during the request.

## 5. Architecture (the sketch it was built from)

> The authoritative description of the code is `documentation/Architecture.md`. This section is the original design sketch, kept for the reasoning behind the shape; where it describes behaviour, the notes marked **as built** say where it diverged.

### 5.1 Backend abstraction

```
interface ReviewBackend {
  review(req: ReviewRequest): AsyncIterable<BackendEvent>
  // BackendEvent: finding | progress | token | done | error
}
```

- **ApiBackend** (v1 core): direct `fetch` to provider APIs, streaming. Structured output via JSON schema / tool-call where supported; strict Zod validation of findings. (**Superseded**: incremental finding extraction was dropped — see §4c item 4. Streaming emits progress; findings land when the editor finishes.) Provider adapters: Anthropic, OpenAI-compatible (custom base URL — covers OpenAI, OpenRouter, Groq, LM Studio…), Azure AI Foundry (deployment name + api-version + auth header), Ollama.
- **CliBackend** (v1, desktop-only): spawn `claude` / `codex` in headless mode (`claude -p --output-format stream-json`) with the note (or selection) as context, cwd = vault root. Parse streamed JSON into BackendEvents. This is what powers "Get research"-grade actions (web, tools) and long async reviews.
- Per-editor backend override; global default backend in settings.
- All requests carry: system prompt (assembled per §4), the note content (raw markdown), optional selection range, an extensible `context[]` (resolved `[[wikilink]]` refs from prompts/inputs, opt-in linked notes per the editor's contextPolicy), and the structured-findings output contract.
- **Nothing runs on note open.** Every backend call is triggered by an explicit user action (Review, an action verb, a push-back, a comment submission).

### 5.2 Finding contract (what every backend must return)

> **As built**: the sketch below became the versioned discriminated operation contract in `src/app/domain/operations/` (§4c item 1) — findings additionally carry `prefix`/`suffix`/`occurrence` anchoring hints and evidence entries, and every field is length-capped so an untrusted response cannot exhaust the plugin.

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
- Gutter/rail: custom DOM in the editor margin (left, like Juri) showing editor dots + panel badges, Summon/Cancel, spinners, count badges. (**As built**: not a CM6 gutter and not dots — a card of named persona rows owned by the markdown view, redesigned 2026-08-01. `Architecture.md` § The persona rail.)
- Review cards: floating widget (CM6 tooltip API or absolutely-positioned overlay) anchored to spans.
- Inline diffs: widget decorations replacing the span while in preview state; Accept applies a transaction, Reject restores.
- Full parity in Live Preview and Source mode (north star #5): all decorations, cards, and diffs must render and behave identically in both — anchoring against raw markdown makes this natural since Source mode shows exactly what we anchor to. Reading view out of scope for interaction (maybe read-only highlights later).

### 5.5 Async margin comments

- Sidecar store: ONE `comments.json` in the PLUGIN DATA FOLDER (`manifest.dir`, never a hardcoded config path), keyed by vault-relative note path, schema-versioned. Per-note sidecars next to the notes were considered and rejected — the vault stays clean, and a sync conflict must land on plugin state rather than on the user's own files. Quote + prefix/suffix/occurrence hints and NO offsets; re-anchored on load through the same `matchQuote` engine findings use (`exact` / `fuzzy` / `orphaned`, orphans kept with their quote). Renames move the entry, deletes drop it, a corrupt store is preserved and reported, writes are debounced and staged through a temp file.
- Background runs. A comment run is the third orchestration shape: keyed by COMMENT id rather than by file, bound to no view, so closing the note or switching notes changes nothing. It is a `review` operation scoped to the span with the question carried as the per-run instruction — no new request kind, no second prompt serializer. It shares the event protocol, the redaction seam and the plugin-wide budget with reviews, and enters that budget through `BackgroundRequestGate` (reserve of one, never joins the FIFO queue) so a parked question cannot delay a review the user is watching. Live elapsed timer (`Reviewing 0:27`), counted from when the request STARTED rather than when it was parked; the ticker runs only while something is in flight.
- Interrupted jobs: recorded `interrupted` at unload and normalized to it at load, offering **Retry**, never a resumption. Retry is a brand-new request re-anchored against the live note; a span that is gone refuses instead of drifting onto other text. `failed` is a separate status from `interrupted` so a job that knows why it ended is not confused with one that knows nothing.
- Right-margin comment column when panel width allows; collapses to the side panel on narrow editors. A positioned overlay owned by the markdown view, never a CM6 gutter (gutters are left-side and line-oriented and would compete with Obsidian's own); cards aligned to their line, pushed down and pulled up so they never overlap or fall off the viewport; several comments on one line collapse to an "N comments" chip; orphans in one collapsed group at the top, with their quote. **Coexistence with the editor width, decided**: with Readable line length on the column uses the empty margin and the text does not move (`overlay`); with it off the editor is padded once so cards never sit on top of prose (`reserve`); below ~700px of pane there is no column and the side panel is the surface. Toggle: `behavior.showMarginComments` + the `Toggle the margin comment column` command; nothing renders on a note with no comments.
- Entry point: `Ask for comments` from the editor context menu, the command palette and a button beside the panel's Review. Requires a selection (a comment is anchored to a span; a whole-note comment would have no line and no quote to re-anchor). The picker opens on `behavior.defaultCommentEditorId`, which makes §4's "configurable default editor, rerouted per comment" real. Before this slice `startCommentJob` had no caller at all.
- **Deferred — per-comment reply threads.** The margin card offers Reveal / Retry / Cancel / Resolve / Delete, but not a push-back conversation. Reusing M4's thread machinery is not a UI change: `thread` state lives on a `TrackedFinding` in the session-scoped `FindingStore`, while a margin comment is DURABLE — so it needs a thread on the persisted schema, a `CommentRunController` widened to a second request kind (`thread-turn`, whose `concede` branch has no meaning for a comment that pinned nothing), and its own protocol and store-transition specs. That is a slice, not an affordance, and half-building it would put an unspecified conversation into durable storage. Push-back on the FINDINGS a comment produced already works wherever those findings are anchored.

### 5.6 Side panel (workspace leaf)

One `ItemView` ("AI Editor Review", view type `editor-ai-daemons-review`) showing, per active note:

- current run status per editor/panel, findings list (jump-to-span on click),
- panel scorecards: per-member verdict, aggregated recommendation, top-3 fixes, dissent,
- unanchored findings and note-level summaries,
- history of margin comments for the note.

### 5.7 Settings design (UX matters here too)

Tabs/sections (**as built: seven** — Rules joined them with the binding-rule engine; `Configuration.md` is the current description):

1. **Backends** — **1-n provider instances** (add multiple, label them): Anthropic / OpenAI-compatible / Azure AI Foundry / Ollama, each with keys, base URL/deployment, default model, test button; CLI agents (path detection, health check). First-use **setup wizard** (detect Ollama + `claude`/`codex` on PATH, test connection, seed starter editors, sample-text tour).
2. **Editors** — gallery of persona cards (color, name, enabled); create/edit modal with: name, color, prompt textarea, **note-ref picker (0-n notes, ordered, with fuzzy note search)**, backend/model override, capability toggles. Import/export JSON.
3. **Panels** — compose from existing editors (multi-select, 1-n), charter (textarea + note refs), aggregation mode. Distinct visual identity.
4. **Actions** — table of built-in verbs (rephrase, summarize, critique, say more, find evidence, identify assumptions, simplify, continue) each with a binding dropdown (editor or panel); add custom actions (name + prompt source + binding); hotkey hints (actual hotkeys via Obsidian's hotkey system).
5. **Voice & Style** — global voice profile: textarea + note refs (e.g. [[My Voice Profile]]); per-editor injection opt-out.
6. **Behavior** — size-warning threshold, concurrency, max tokens per run, **exclusions** (folders, tags, `ai_editor: false` frontmatter flag; strip-frontmatter toggle), hotkey pointers for the keyboard triage commands. No telemetry.

All plugin text inputs (persona prompts, charters, push-back, refine, custom actions) support **`[[wikilink]]` autocomplete**; referenced notes are resolved and attached as context at run time.

### 5.8 Starter pack (seeded editors; all fully editable)

Drawn from Maggie's epistemic roles + the user's OSK skills/agents:

1. **Concision Editor** — cut flab, merge redundancy (Juri's demo).
2. **Devil's Advocate** — attack weak arguments, find holes (OSK Hater/Skeptic).
3. **Fact Checker** — flag uncited claims, dated stats, verify when backend has research capability (osk-knowledge-fact-check).
4. **Flow & Structure Editor** — transitions, ordering, scannability (OSK Editor).
5. **Humanizer** — AI-tell detection: metronomic rhythm, banned vocabulary, hedge-stacking (osk-writing-humanizer + osk-writing-rigor).
6. **Beginner Reader** — jargon, assumed context, accessibility (OSK Beginner).

Starter panel: **Pre-publish Review** = Devil's Advocate + Flow & Structure + Beginner Reader + Humanizer → scorecard with publish / needs-work / kill verdicts (mirrors osk-panel-publish).

## 6. Support CTAs — fleet convention

**Every surface a user can see must carry the same calls to action — newsletter, YouTube channel, Knowii community, GitHub Sponsors, Buy me a coffee. `obsidian-plugin-template` is the canonical source for exact wording and code — copy from it rather than re-inventing (see its `TEMPLATE_USAGE.md` §4.2, "Support CTAs"). Seven surfaces: 1. **`src/app/ui/support-links.ts`** — shared module holding `KNOWII_COMMUNITY_URL`, `GITHUB_SPONSORS_URL`, `BUY_ME_A_COFFEE_URL`, `YOUTUBE_CHANNEL_URL`, `NEWSLETTER_URL` plus `renderSupportSection(containerEl, renderBadge?)`. Single source of truth: everything else imports from it. Copy the file verbatim from the template. 2. **`src/app/ui/whats-new-view.ts`** — drop its local URL consts and import them from `./support-links` (the file is byte-identical across the fleet; keep it that way). 3. **Settings tab** — the support section delegates to `renderSupportSection(containerEl, (el) => this.renderBuyMeACoffeeBadge(el))`. The badge asset stays plugin-local and is injected as a callback. Settings get opened repeatedly, unlike the one-shot what's-new dialog, so this is the highest-traffic in-app surface. 4. **`manifest.json` → `fundingUrl`** — an **object** of labelled URLs (`"Join Knowii"`, `"GitHub Sponsors"`, `"Buy Me a Coffee"`), not a single string. Obsidian renders each entry in the community plugin browser and in the installed-plugin entry; it is the only CTA surface Obsidian itself provides. 5. **`.github/FUNDING.yml`** — `github: [dsebastien]`, `buy_me_a_coffee: dsebastien`, and `custom:` with the Knowii and store URLs, driving GitHub's Sponsor button and dropdown. 6. **`.github/release-footer.md` + `release.yml`** — the "Extract changelog for release notes" step appends `printf '\n---\n\n'` then `cat .github/release-footer.md` into `$GITHUB_OUTPUT`, so every GitHub release body carries the CTAs. Note the footer file must **not** start with `---` (Prettier mangles it as frontmatter); the separator is emitted by the workflow instead. 7. **`README.md` + `docs/README.md` + `docs/_config.yml`** — both markdown files end with a `## News & support` section preceded by a `<!-- support-cta -->` marker (marker to next `##` = generated block, regenerable fleet-wide), and carry a `<!-- other-plugins:start -->` / `<!-- other-plugins:end -->` cross-promotion table generated from every plugin's `manifest.json` (name + description, current repo excluded). `docs/_config.yml` sets `footer_content` so just-the-docs renders the links at the bottom of **every\*\* docs page. When this plugin ships, regenerate the other-plugins table in all repos so it appears in the fleet too.

- **Value-moment support prompt (planned, tracked in the vault)**: a one-time, dismissible notice after N successful operations, leading with a concrete usage number before the ask. To be built in the template first and rolled out; if it lands before this plugin ships, adopt it here rather than writing a bespoke one.

## 7. Risks & mitigations

| Risk                                                                                       | Mitigation                                                                                                                                       |
| ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Quote anchoring fails on markdown syntax mismatch (LLM quotes rendered text vs raw source) | Always send raw markdown to the model; instruct quoting verbatim from input; 3-stage matcher + graceful degradation; heavy test corpus           |
| CM6 overlay complexity (cards/diffs fighting Live Preview widgets)                         | Prototype the diff widget early (M1); prefer CM6-native decorations over DOM hacks                                                               |
| CLI backend fragility (paths, versions, auth)                                              | Health-check button, clear error surfaces, API backend always available as fallback                                                              |
| Cost runaway (N editors × long notes)                                                      | Scope control (selection/section), per-run token caps, count badge = findings only after completion, explicit Summon (never auto-run by default) |
| Findings spam / annoying UX                                                                | Severity filter, per-editor max findings, "fade on dismiss" everywhere, ignorable-by-design                                                      |
| Obsidian review guidelines (no `innerHTML`, sentence-case UI, no "Obsidian" in name/desc)  | Template conventions + review-lint before submission                                                                                             |

## 7b. Post-v1 backlog — GitHub owns it

**The backlog is GitHub issues, not this document.** Every item once listed here has an issue; the issue carries the current state, this section only records the mapping (issue bodies point back at "§7b item N") and the one piece of design plumbing that spans several of them.

| Item                                                               | Issue                                                             |
| ------------------------------------------------------------------ | ----------------------------------------------------------------- |
| Tag review — reuse existing vault tags, never invent silently      | [#1](https://github.com/dsebastien/obsidian-ai-editor/issues/1)   |
| Related-notes discovery — wikilinks proposed into a target section | [#2](https://github.com/dsebastien/obsidian-ai-editor/issues/2)   |
| References management — internal + external, with source citation  | [#3](https://github.com/dsebastien/obsidian-ai-editor/issues/3)   |
| Per-editor learning loop — the writer the v1 memory field lacks    | [#4](https://github.com/dsebastien/obsidian-ai-editor/issues/4)   |
| Interview-first drafting                                           | [#5](https://github.com/dsebastien/obsidian-ai-editor/issues/5)   |
| Community packs                                                    | [#6](https://github.com/dsebastien/obsidian-ai-editor/issues/6)   |
| Publish gates — panel-as-gate, public API, status-bar verdict      | [#7](https://github.com/dsebastien/obsidian-ai-editor/issues/7)   |
| Metadata review — frontmatter first, any property later            | [#8](https://github.com/dsebastien/obsidian-ai-editor/issues/8)   |
| Session summary                                                    | [#9](https://github.com/dsebastien/obsidian-ai-editor/issues/9)   |
| AI Providers plugin as an optional backend source                  | [#10](https://github.com/dsebastien/obsidian-ai-editor/issues/10) |

Everything raised after v1 — the bugs found in live testing and the UX asks that came with them — is in the same tracker (issues #11-#29 at the time of writing) and is deliberately NOT mirrored here.

**The one cross-cutting design note:** external-reference tracking (#3) needs no separate plumbing. The operation contract's **evidence entries** — already shipped, already carried per finding — are the citation source; a backend reporting the sources behind its suggestion is what makes "add the references" honest rather than reconstructed. Anything that changes the evidence shape changes #3.

## 8. Open design questions

The v1-era open questions are decided. What survives is design work nobody has done and no issue owns.

- **Action vocabulary expansion.** The built-in verb list (rephrase, summarize, critique, say-more, find-evidence, identify-assumptions, simplify, humanize, continue) is a starting set, not a ceiling. Candidates from the OSK skill catalog and the Juri/Maggie affordances: fact-check, add-examples, add-analogies, strengthen-hook, tighten-structure, extract-outline, translate, change-tone, make-scannable, title-suggestions, counter-argue, steelman, devils-advocate, explain-simpler (ELI5), add-transitions, remove-jargon. **The selection criteria are the actual content of this item**: a verb earns its place only if it is meaningfully distinct as a ONE-SHOT operation, if it benefits from a specific instruction prompt rather than just picking a different editor, and if it maps cleanly onto an existing operation kind (transform-selection or review). New verbs ship unbound; the Actions tab lists them from the schema automatically.
- **Post-run token usage.** Providers return usage; showing it per run would build trust in what a review costs. Never required, never designed.
- **"Get research" in practice.** Whether web-grounded research is realistically API-backend-gated or CLI-only was never settled — the capability toggle exists on every editor, and the honest answer depends on which backends the user configures.
- **Backlinks as opt-in context.** Context assembly follows OUTGOING links only, depth 1. Incoming links are a different and much larger set, and no capping or ordering policy was designed for them.

**Decided, recorded so they are not re-opened.** Interaction surfaces (menus, the command inventory, the CLI) were researched, adversarially critiqued and shipped — `interaction-surfaces-design.md` is the spec and also records what was rejected: no submenus (`setSubmenu` is not public API), no default hotkeys (community guideline), no batch review until cost estimation exists. Diff granularity went WORD-level (`domain/diff/word-diff.ts`, patience-anchored above the LCS budget). Publish gates moved to issue #7.

## 9. References

- Juri Strumpflohner's Quill demos: x.com/juristr statuses 2074494746484236459, 2077036970895872368, 2079297727364464700
- Maggie Appleton, Language Model Sketchbook: https://maggieappleton.com/lm-sketchbook
- Vault: [[AI Assistant Architecture]], DeveloPassion Ghostwriter SOUL, osk-panel-publish, osk-writing-humanizer, osk-writing-rigor, developassion-style-police, user-voice-profile
- Obsidian plugin guidelines: https://docs.obsidian.md/Plugins/Releasing/Plugin+guidelines
