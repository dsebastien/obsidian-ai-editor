# Interaction Surfaces — design

> Researched against (Obsidian API typings, the obsidian-note-toolbar CLI pattern, this repo's contracts) plus adversarial critique, then built across six slices and amended to what actually shipped. It is kept as the spec of the menu / command / CLI surface and of what was rejected — not as work to do. The API facts below were true for typings 1.12.x and are the reason several things are shaped the way they are; re-verify them against `node_modules/obsidian/obsidian.d.ts` before relying on one.

## Verified API facts (evidence-backed)

- `workspace.on('editor-menu')` / `('file-menu')` / `('files-menu')` all exist (obsidian.d.ts 1.12.x). `files-menu` receives `TAbstractFile[]` (multi-selection); folder entries are `TFolder` instances — filter them.
- `Menu.addItem` / `addSeparator`, `MenuItem.setTitle/setIcon/setDisabled/setSection` exist. **`setSubmenu` is NOT public API** — no submenus; flatten.
- `addCommand` / `removeCommand` are public (1.7.2+); user hotkeys persist across unregister/re-register **as long as command ids are stable**. Ids must derive from entity UUIDs, never display names.
- `registerCliHandler(command, description, flags, handler)` is **`@public` `@since 1.12.2`** on `Plugin`, with `CliData`/`CliFlag`/`CliFlags`/`CliHandler` exported types. The repo's typings were pinned at 1.12.0, which predates it; they were bumped to 1.12.3 at the time (the pin has since moved with the fleet — `package.json` is authoritative, 1.13.1 as of 2026-08-12) and `minAppVersion` was deliberately left alone. Guard registration with `Platform.isDesktop && requireApiVersion('1.12.2')`. Reference implementation: obsidian-note-toolbar `CliManager`/`CliHandlers` (passes community review).

## 1. Editor context menu (selection)

Shown when: right-click with a non-empty selection in an editable markdown view, note not excluded, and ≥1 dispatchable target exists.

Structure (flat — no submenus; `setSection` for grouping):

1. **Bound actions** — one item per action binding whose target editor/panel is enabled and whose backend resolves, capped at 10. Alphabetical by action label — and the sort is on the BARE label, so the `(panel: …)` marker a panel-bound verb carries cannot shuffle a menu navigated by verb (MRU ordering is a later polish pass). Icons by verb class: `wand-2` generation (continue, say-more, humanize), `check` transformation (rephrase, summarize, simplify), `message-circle` critique/analysis (critique, find-evidence, identify-assumptions) — note "Review selection" is critique-class → `message-circle`.
2. **Review selection** — runs all enabled review-capable editors on the selection (`message-circle`). Hidden when the note is not reviewable (no enabled editors, excluded, …).
3. **Ask for comments…** — parks a durable margin comment on the selection, answered by a background job (M8). Requires a selection, like everything else in this menu.
4. **Ask an editor…** — freeform prompt affordance; opens the freeform modal, under the same gate as Review selection.

**Shipped order**: bound actions → Review selection → Ask for comments… → Ask an editor…

**Resolved rule (as shipped, slice 3)**: unavailable items are HIDDEN, never disabled — an item that cannot dispatch is simply not added (consistent with §2's no-placeholder rule). `setDisabled(true)` is not used anywhere; a future backend-health surface may revisit transient-disable, but that is explicitly out of v1 scope. Cap at 10 action items; beyond that the palette is the surface.

**Selection-capture contract (as shipped, slices 2 + fix pass)**: the selection range is captured synchronously in the menu-item callback and passed into the review pipeline as `requestedSelection: { from, to, capturedHash }` — `capturedHash` is the hash of the text the offsets were captured against, filled from the capture-time snapshot and carried unchanged through the size-confirmation round trip (validating against the post-modal snapshot's own hash would be vacuous). At run start the pipeline re-validates range + hash against the fresh snapshot; if invalid, fall back to whole-note scope with a Notice ("Selection changed — reviewing the whole note"). Selection scope is EXCLUSIVELY this contract: the file menu's "Review note" and the CLI snapshot whole-note explicitly, so a live selection never silently narrows those runs.

## 2. File-explorer context menus

- **`file-menu`** (single note, tab, link): "Review note" (opens the file if needed, dispatches the whole-note review) + "Open review panel". Only for `TFile` with `.md` extension, not excluded.
- **`files-menu`** (multi-selection): **batch review is DEFERRED post-M4.** Rationale: batch runs multiply cost with no cost-estimation machinery yet (rates not fetched/cached), RunController + review UI are single-file-keyed, and per-file confirm UX is unresolved. Do NOT ship a disabled placeholder item (review-guidelines critique: non-functional UI) — simply register nothing on `files-menu` until the feature exists. **Not filed as an issue yet** — file one before it is re-discussed.
- **Folders**: excluded everywhere. Review scope stays explicit per note; no recursive traversal.

## 3. Command palette inventory

No default hotkeys anywhere (community review guideline — plugins must not ship hotkey defaults). Recommended bindings documented in README only.

| Command id (stable)                                | Name (sentence case)                | Gating                                                                                                                                                                                                                                                                          | Dynamic?    |
| -------------------------------------------------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| `review-current-note`                              | Review current note                 | `checkCallback`: active md view + not excluded + ≥1 enabled editor                                                                                                                                                                                                              | no (exists) |
| `review-selection`                                 | Review selection                    | `editorCheckCallback`: selection non-empty + reviewable                                                                                                                                                                                                                         | no          |
| `ask-editor`                                       | Ask an editor                       | `editorCheckCallback`: selection non-empty + reviewable                                                                                                                                                                                                                         | no          |
| `open-review-panel`                                | Open review panel                   | plain `callback`                                                                                                                                                                                                                                                                | no (exists) |
| `cancel-run`                                       | Cancel review                       | `checkCallback`: a run for the active file is unsettled                                                                                                                                                                                                                         | no          |
| `action-<actionId>`                                | <Action label>                      | `editorCheckCallback`: selection/doc per verb + target enabled                                                                                                                                                                                                                  | yes         |
| `next-finding` / `prev-finding`                    | Next/previous finding               | `checkCallback`: active run has anchored findings (since 2026-07-30 these are triage steps: move the per-file cursor, ring the current finding, open its card)                                                                                                                  | no (exists) |
| `accept-finding` / `dismiss-finding`               | Accept/dismiss current finding      | `checkCallback`: a current triage finding exists (shipped 2026-07-30: accept additionally needs the finding store-actionable + the note open in an editor; both auto-advance)                                                                                                   | no (exists) |
| `accept-all-<editorId>` / `dismiss-all-<editorId>` | Accept/dismiss all from <Editor>    | `checkCallback`: run has open findings from that editor (shipped 2026-07-30: registration follows the EDITOR entities via the settings observer, availability is re-checked per invocation against the active note's run; accept additionally needs the note open in an editor) | yes         |
| `filter-severity`                                  | Cycle severity filter               | `checkCallback`: findings present (shipped 2026-07-30: per-file lens, all → warnings and suggestions → warnings only; Notice reports the mode + hidden count)                                                                                                                   | no (exists) |
| `accept-all`                                       | Accept all non-conflicting findings | `checkCallback`: the active run has an acceptable finding and its note is open (shipped 2026-07-30: every editor of the run at once, ONE undoable transaction)                                                                                                                  | no (exists) |

Dynamic registration: on every settings mutation, diff desired vs registered command sets; `removeCommand` the stale, `addCommand` the new (debounced). Never register a command whose target cannot dispatch (Business Rule #14: nothing non-functional is offered). Command ids embed entity UUIDs so hotkeys survive renames; removing an entity orphans its hotkey binding (Obsidian behaviour).

The mutation-observer hook this needed shipped in slice 1: `SettingsFacade.subscribe(listener)` notifies after every successful update or persist, including load-time repairs, and never on a rejected update.

**Also shipped, after this table was written** — the commands that exist today beyond the rows above: `ask-for-comments` ("Ask for comments"), `preview-context` ("Preview what will be sent"), `generate-more` ("Generate more findings from every finished editor"), `toggle-margin-comments` ("Toggle the margin comment column"), `toggle-daemon-mode` ("Toggle daemon mode for the current note") and `run-setup-wizard` ("Run setup wizard"). `cancel-run` kept its id and is named "Cancel review or action", because it cancels a transform too.

## 4. Obsidian CLI extensions — GO

- `obsidian` devDependency at 1.12.3. Guard: `Platform.isDesktop && requireApiVersion('1.12.2')`, each subcommand individually try/catch-wrapped.
- v1 surface (decision §6.3): **three** subcommands — `editor-ai-daemons:review`, `editor-ai-daemons:cancel`, `editor-ai-daemons:status`. Shared machinery lives in `src/app/services/cli/cli-shared.ts` (flag parsing, the finding shape, text finding lines) so the subcommands stay in lockstep by construction; `--file` resolution is one shared resolver (`src/app/cli/resolve-note-path.ts`, wikilink-tolerant, markdown only).

### `editor-ai-daemons:review`

- Flags: `file` (required), `editors` (comma-separated ids or names; an unknown OR disabled token fails the whole invocation — no partial reviews for scripts), `format` (`json` default | `text`), `confirm-large` (boolean; without it an oversized note returns `needs-confirmation` instead of running). A `scope` flag (`note`|`selection`) was designed but **dropped for v1** (selection unsupported from the CLI; no non-functional flags are registered) — add it when CLI selection support lands. Every CLI run is whole-note.
- Handler is buffered: runs the review, waits for settle, returns one JSON document: `{ ok, file, findings: [{ id, editor, severity, quote, critique, suggestion, anchor: {from,to,state}|null }], skips, summaryByEditor, error }` — `anchor` is `null` for findings whose quote could not be located. Machine-readable for scripting/agents; `text` mode prints one line per finding.
- Open-note semantics (as shipped, fix pass): when the target note is open in a markdown view, the run snapshots the LIVE editor buffer (unsaved edits included) and binds to the view glue synchronously, so it shows in the rail/panel/highlights and edits typed during the run keep remapping anchors. When the note is not open, the run reviews the saved vault state and is discarded from the `RunController` after the output document is shaped (no unbounded accumulation from batch usage).
- Errors are typed codes (`bad-args`, `file-not-found`, `excluded`, `needs-confirmation`, `no-editors`, `backend-error`, `timeout`), status-only messages (BR #12 redaction applies). `bad-args` (missing/blank required flag) is distinct from `file-not-found` so scripts can tell the two apart by code; it is mostly defensive since Obsidian enforces `required: true` flags before the handler runs.

### `editor-ai-daemons:cancel`

- Flags: `file` (required). Cancels the unsettled run for that note. Always one JSON document: `{ ok: true, file, cancelled: true }` | `{ ok: true, file, cancelled: false, reason: 'no-run' | 'already-settled' }` | typed error (`bad-args` | `file-not-found`). Nothing-to-cancel is `ok: true` — the invocation worked; the reason says why nothing changed.
- Cancelling **never discards the run**: the findings collected so far stay inspectable via `editor-ai-daemons:status` and the review UI. Discard remains a UI lifecycle concern (file closed/deleted/renamed), not a cancel side effect.

### `editor-ai-daemons:status`

- Flags: `file` (required), `format` (`json` default | `text`). Reports the current run for the note WITHOUT running anything: `{ ok: true, file, run: null }` when none; otherwise `{ ok: true, file, run: { settled, editors: [{ id, name, status, error }], findings: [same shape as review output], summaryByEditor } }` (errors: `bad-args` | `file-not-found`). Per-editor `error` entries already passed the run's redaction seam (BR #12). `settled` is derived from the editor states (all in done/error/cancelled), NOT from the run's settle promise: `cancelRun` marks every editor terminal synchronously while the aborted loops are still unwinding, and a status poll in that window must not report the run as in progress.
- `text` mode: one status headline (`Run in progress (1 running, 1 done) — 2 findings so far` / `Run settled (2 done) — 5 findings`) + one line per finding in the exact review line format.
- This is the poll loop for external agents driving long reviews: start via `editor-ai-daemons:review` (or the UI), poll `editor-ai-daemons:status` until `settled`, optionally `editor-ai-daemons:cancel` — findings remain readable throughout.

### Common

- No streaming (CLI API returns a single string), no CLI-side backend overrides (keys stay in data.json), no background jobs in v1.
- Registration (all three): guarded by `Platform.isDesktop && requireApiVersion('1.12.2')`, each subcommand individually wrapped in try/catch (double-load race degrades that subcommand only).

## 5. Implementation slices — all shipped

The order is the record: the reviewability helper before the surfaces that gate on it, the selection contract before the menus that capture selections, and the CLI last because it reuses everything above.

1. **Typings bump + reviewability helper**: `obsidian` → 1.12.3; extract `isReviewable(path, settings)` (exclusions + enabled editors) shared by command gates, menus, CLI; settings facade mutation observer.
2. **Selection scope plumbing**: `requestedSelection` through review-service (capture → re-validate → fallback + Notice). Spec-covered.
3. **Editor context menu** (`src/app/ui/menus/editor-menu.ts`): bound actions + review selection. The v1 slice shipped review-class items only, because transform ops were not wired yet; they landed later, so bound actions of every verb class now appear.
4. **File context menu** (`src/app/ui/menus/file-menu.ts`): review note + open panel.
5. **Command inventory** (`src/app/commands/`): static commands + dynamic per-action/per-editor registration diffing.
6. **CLI handler** (`src/app/services/cli/review-cli.ts` + registration): arg parsing, JSON shaping, error codes. Pure core (spec-covered) + thin Obsidian glue.

## 6. Decisions (2026-07-29)

The former "Open questions for Sébastien", all decided and all shipped:

1. **Freeform "Ask an editor" = BOTH surfaces**: a context-menu entry opening a freeform modal (the note-level entry point; M3-adjacent) AND per-finding push-back threads embedded in the finding card (finding-level back-and-forth with the editor persona; M4). The §1 menu item stays hidden until the modal exists — never a dead menu item.
2. **Batch review = deferred until cost estimation exists** (confirmed): §2 stands as written — no `files-menu` registration, no disabled placeholder. Revisit once rates are fetched/cached and a batch confirm UX is designed.
3. **CLI v1 surface = review + cancel + status** (shipped 2026-07-29): `editor-ai-daemons:cancel` and `editor-ai-daemons:status` join `editor-ai-daemons:review` per §4 — status gives external agents a poll loop for long reviews; cancel never discards the run, so findings stay inspectable after cancellation.
