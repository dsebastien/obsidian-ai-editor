# Architecture

High-level structure of the AI Editor plugin. See `Domain Model.md` for entities, `Business Rules.md` for invariants, and `plans/ai-editor-v1-implementation-plan.md` for the roadmap.

## Layers

```
src/app/
├── types/        # Settings interfaces, branded IDs
├── domain/       # Pure logic: operation contract (Zod), anchoring engine, snapshots
│                 # No Obsidian imports — fully unit-testable under bun test
├── services/     # Backends (API providers, CLI agents), context assembly,
│                 # run orchestration, persistence (sidecar repository)
├── commands/     # Obsidian command registrations (review, triage, actions)
├── ui/           # CM6 integration (decorations, rail, cards, diffs), side panel,
│                 # settings tab, wizard, modals
└── settings/     # Settings tab + components
```

Dependency direction: `ui`/`commands` → `services` → `domain` → `types`. The domain layer never imports from Obsidian or CM6 — editor-position mapping is abstracted behind `TextChange` (adapted from CM6 `ChangeDesc` at the ui boundary).

## Core flow (a review run)

1. User triggers Review (command/rail). The active note is snapshotted (`DocumentSnapshot`: text + hash + id).
2. Binding rules are consulted (`domain/rules/`): a kill-switch rule refuses the run with its own typed status (distinct from a privacy exclusion) and suppresses every surface for that note; an assign rule supplies the default participant pool. An explicit ask/bound action, and a daemon re-dispatch, both override the rule's pool.
3. Context is assembled per editor through the ONE prompt-build entry point, `buildEditorPrompt` (`services/review-service.ts`): system prompt (voice profile + persona prompt text + memory), then the vault notes that ride along — prompt note refs, wikilinks in the prompt text, links followed from prompt notes, and the reviewed note's own links when the editor opts in — all after privacy exclusions and under the character budget whose policy lives in `services/context/context-budget.ts`. The system prompt and the reviewed note are never truncated; attachments are spent in that order and the last ones are dropped first, with every candidate reported. Transforms, push-back threads and the "what will be sent" preview call the SAME function, so the preview cannot drift from the request.
    - A bound ACTION resolves its verb before that step (`resolveActionVerb`): built-in verbs come from the registry, a custom action supplies its own label, class and vault-resolved instruction. The class then picks the pipeline — `transform-selection`, `insert-at`, or the review pipeline with the instruction augmented onto the system prompt — identically for built-in and custom actions.
4. Each enabled editor's backend runs an `Operation` (see contract in `src/app/domain/operations/`). Backends emit `OperationEvent`s: findings (as they complete, when streaming is verified for the provider), progress, exactly one terminal event (result/error), all tagged with the run id.
5. Findings are anchored against the snapshot (exact → normalized → contextual; ambiguous/fuzzy = display-only) and projected into CM6 decorations. User edits remap positions via change-mapping; edits intersecting a finding's range mark it stale.
6. Triage: cards, diffs, threads, keyboard commands, bulk operations. Accept re-verifies the precondition text, applies as a single undoable transaction.
7. Panel runs add an aggregation operation over member results, producing a typed `PanelResult` scorecard. A run is "busy" until BOTH its editors and its aggregation settle (`RunHandle.isBusy()`; `isSettled()` is editor-only and gates the aggregation itself). The scorecard is model-authored text, so both renderers (side panel, CLI) reconcile it through `domain/panels/scorecard-model.ts` — member names against the run's roster, a top fix's credit against the finding it actually resolves to.

## Backends

Two families behind one adapter contract (per-instance capability negotiation: streaming?, JSON schema?, usage?):

- **API providers** (v1 core): Anthropic, OpenAI, OpenRouter, OpenAI-compatible (custom base URL), Azure OpenAI (deployment-based), Ollama. A backend's "Test connection" (`services/backends/health-check.ts`) runs one probe operation through the SAME executor a review uses, so a pass means reviews will work rather than "the endpoint answers"; a reachable endpoint whose model ignores the required structure is reported as its own outcome. Buffered structured output is the baseline; per-provider streaming decoders only where verified. Transport constraint: Obsidian's `requestUrl` does not stream; renderer `fetch` is used where CORS permits, `requestUrl` as buffered fallback.
- **CLI agents** (opt-in, late milestone): Claude Code, Codex — headless spawns behind the security boundary defined in Business Rules #9.

## UI integration points

- CM6 `StateField` for finding decorations (mapped through transactions), single active tooltip per view for cards, view-owned panel element for the persona rail, `ItemView` workspace leaf for the side panel (a header bound to the note — name + Review button — over the findings list, scorecards and comments), status-bar item (finding count / gate verdict).
- Every surface that gates on "can a review start here" asks ONE function, `reviewGate` (`services/reviewability.ts`), which returns the reason (`excluded` / `rule-disabled` with the rule label / `no-editor` / `ok`); `isReviewable` and `isPluginEnabledForNote` are projections of it. Surfaces that must SAY WHY (the panel's Review button) read the gate itself, so an explanation cannot drift from the decision it explains.
- The panel's Review button dispatches the shared whole-note review path and REFUSES while a run or retry is in flight (same `canCancelRun` predicate the Cancel command uses) — `RunController.startRun` cancel-replaces an existing run, and destroying findings from the surface displaying them is never what a click meant. Cancelling stays on the rail and the palette.
- Multiple leaves/popouts: a file-level run controller with per-view projections; all DOM created via the owning view's document.

## Persistence

- Settings (editors, panels, actions, rules, providers): plugin `data.json`, schema-versioned with migrations, stable UUIDs, referential integrity on delete. Transfer in and out of a vault goes through `domain/settings/settings-transfer.ts` (pure): export strips API keys and declares the fields that can still hold one; import validates per entity, applies section caps BEFORE remapping (so a capped-out entity leaves no dangling reference), regenerates ids, remaps references, brings API backends in disabled, and returns a plan — destinations included — that the user confirms before anything is written.
- Findings/runs: ephemeral (in-memory per session).
- Async margin comments: sidecar repository under the plugin data dir — schema version, quote+prefix+suffix anchors with fuzzy re-anchor on open, rename handling, corruption recovery, interrupted-job semantics on restart (Retry; no fake resumption).
