# Interaction Surfaces — Design (M3 prerequisite)

> Status: APPROVED DESIGN — produced 2026-07-29 via research (Obsidian API typings, obsidian-note-toolbar CLI pattern, this repo's contracts) + adversarial critique (api-truth, repo-fit, review-guidelines lenses). Supersedes plan §8 "Interaction surfaces design (needs research)" — the research happened.

## Verified API facts (evidence-backed)

- `workspace.on('editor-menu')` / `('file-menu')` / `('files-menu')` all exist (obsidian.d.ts 1.12.x). `files-menu` receives `TAbstractFile[]` (multi-selection); folder entries are `TFolder` instances — filter them.
- `Menu.addItem` / `addSeparator`, `MenuItem.setTitle/setIcon/setDisabled/setSection` exist. **`setSubmenu` is NOT public API** — no submenus; flatten.
- `addCommand` / `removeCommand` are public (1.7.2+); user hotkeys persist across unregister/re-register **as long as command ids are stable**. Ids must derive from entity UUIDs, never display names.
- `registerCliHandler(command, description, flags, handler)` is **`@public` `@since 1.12.2`** on `Plugin`, with `CliData`/`CliFlag`/`CliFlags`/`CliHandler` exported types. The repo's `obsidian` typings are pinned at 1.12.0, which predates it — **bump typings to 1.12.3** (≤ latest public release 1.12.7; fleet compatibility rule holds). Guard registration with `Platform.isDesktop && requireApiVersion('1.12.2')`. Reference implementation: obsidian-note-toolbar `CliManager`/`CliHandlers` (passes community review).

## 1. Editor context menu (selection)

Shown when: right-click with a non-empty selection in an editable markdown view, note not excluded, and ≥1 dispatchable target exists.

Structure (flat — no submenus; `setSection` for grouping):

1. **Bound actions** — one item per action binding whose target editor/panel is enabled and whose backend resolves. Alphabetical by action label (MRU ordering is a later polish pass). Icons by verb class: `wand-2` generation (continue, say-more, humanize), `check` transformation (rephrase, summarize, simplify), `message-circle` critique/analysis (critique, find-evidence, identify-assumptions) — note "Review selection" is critique-class → `message-circle`.
2. **Review selection** — runs all enabled review-capable editors on the selection (`message-circle`). Disabled (with reason in title) when none are enabled.
3. **Ask an editor…** — freeform prompt affordance; opens the freeform modal (M4; ships as a hidden item until the modal exists — never a dead menu item).

Unavailable-but-visible items use `setDisabled(true)` only when the disabled reason is transient (backend health); permanently unavailable items are simply not added. Cap at 10 action items; beyond that the palette is the surface.

**Selection-capture contract**: the selection range is captured synchronously in the menu-item callback and passed into the review pipeline as `requestedSelection`. At run start the pipeline re-validates it against the fresh snapshot (hash + bounds); if invalid, fall back to whole-note scope with a Notice ("Selection changed — reviewing the whole note"). This needs `StartReviewInput.requestedSelection?: { from: number; to: number }` — today `startReview` derives scope itself.

## 2. File-explorer context menus

- **`file-menu`** (single note, tab, link): "Review note" (opens the file if needed, dispatches the whole-note review) + "Open review panel". Only for `TFile` with `.md` extension, not excluded.
- **`files-menu`** (multi-selection): **batch review is DEFERRED post-M4.** Rationale: batch runs multiply cost with no cost-estimation machinery yet (rates not fetched/cached), RunController + review UI are single-file-keyed, and per-file confirm UX is unresolved. Do NOT ship a disabled placeholder item (review-guidelines critique: non-functional UI) — simply register nothing on `files-menu` until the feature exists. Tracked as a GitHub issue.
- **Folders**: excluded everywhere. Review scope stays explicit per note; no recursive traversal.

## 3. Command palette inventory

No default hotkeys anywhere (community review guideline — plugins must not ship hotkey defaults). Recommended bindings documented in README only.

| Command id (stable)                                | Name (sentence case)             | Gating                                                             | Dynamic?    |
| -------------------------------------------------- | -------------------------------- | ------------------------------------------------------------------ | ----------- |
| `review-current-note`                              | Review current note              | `checkCallback`: active md view + not excluded + ≥1 enabled editor | no (exists) |
| `review-selection`                                 | Review selection                 | `editorCheckCallback`: selection non-empty + reviewable            | no          |
| `open-review-panel`                                | Open review panel                | plain `callback`                                                   | no (exists) |
| `cancel-run`                                       | Cancel review                    | `checkCallback`: a run for the active file is unsettled            | no          |
| `action-<actionId>`                                | <Action label>                   | `editorCheckCallback`: selection/doc per verb + target enabled     | yes         |
| `next-finding` / `prev-finding`                    | Next/previous finding            | `checkCallback`: active run has anchored findings                  | no          |
| `accept-finding` / `dismiss-finding`               | Accept/dismiss current finding   | `checkCallback`: a current finding is selected (triage state)      | no          |
| `accept-all-<editorId>` / `dismiss-all-<editorId>` | Accept/dismiss all from <Editor> | `checkCallback`: run has open findings from that editor            | yes         |
| `filter-severity`                                  | Cycle severity filter            | `checkCallback`: findings present                                  | no          |

Dynamic registration: on every settings mutation, diff desired vs registered command sets; `removeCommand` the stale, `addCommand` the new (debounced). Never register a command whose target cannot dispatch (plan debt #7 rule: no non-functional commands). Command ids embed entity UUIDs so hotkeys survive renames; removing an entity orphans its hotkey binding (Obsidian behavior — document in settings UI).

Prereq: the plugin settings facade needs a mutation-observer hook (subscribe/notify on `update`) — doesn't exist yet; small addition to `settings-facade.ts`.

## 4. Obsidian CLI extensions — GO

- Bump `obsidian` devDependency to 1.12.3. Guard: `Platform.isDesktop && requireApiVersion('1.12.2')`.
- v1 surface: **one** subcommand — `ai-editor:review` with flags `file` (required), `editors` (comma-separated ids or names), `scope` (`note`|`selection` — selection unsupported from CLI v1, reserved), `format` (`json` default | `text`), `confirm-large` (boolean; without it an oversized note returns `needs-confirmation` instead of running).
- Handler is buffered: runs the review, waits for settle, returns one JSON document: `{ ok, file, findings: [{ id, editor, severity, quote, critique, suggestion, anchor: {from,to,state} }], skips, summaryByEditor, error }`. Machine-readable for scripting/agents; `text` mode prints one line per finding.
- Errors are typed codes (`file-not-found`, `excluded`, `needs-confirmation`, `no-editors`, `backend-error`, `timeout`), status-only messages (BR #12 redaction applies).
- No streaming (CLI API returns a single string), no CLI-side backend overrides (keys stay in data.json), no background jobs in v1.

## 5. Implementation slices (each lands green)

1. **Typings bump + reviewability helper**: `obsidian` → 1.12.3; extract `isReviewable(path, settings)` (exclusions + enabled editors) shared by command gates, menus, CLI; settings facade mutation observer.
2. **Selection scope plumbing**: `requestedSelection` through review-service (capture → re-validate → fallback + Notice). Spec-covered.
3. **Editor context menu** (`src/app/ui/menus/editor-menu.ts`): bound actions + review selection. Note: action _dispatch_ for non-review verbs (rephrase etc.) is M3 work — until transform ops are wired, only review-class items appear.
4. **File context menu** (`src/app/ui/menus/file-menu.ts`): review note + open panel.
5. **Command inventory** (`src/app/commands/`): static commands + dynamic per-action/per-editor registration diffing.
6. **CLI handler** (`src/app/services/cli/review-cli.ts` + registration): arg parsing, JSON shaping, error codes. Pure core (spec-covered) + thin Obsidian glue.

## 6. Open questions for Sébastien

1. Freeform "Ask an editor": context-menu entry opening a modal (recommended) vs card-embedded input only?
2. Batch review: is post-M4 deferral acceptable, or is a naive sequential batch (N independent runs + N confirms) wanted earlier?
3. CLI: is `ai-editor:review` enough for v1, or also `ai-editor:cancel` / `ai-editor:status`?
