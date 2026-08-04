# Release Notes

## 0.5.0 (2026-08-04)

### ⚠ BREAKING CHANGES

- **plugin:** Obsidian 1.12.2 is now the minimum supported version.
  Installs below it no longer receive the plugin.

### Features

- **plugin:** raise minAppVersion to 1.12.2

### Bug Fixes

- **build:** ship CHANGELOG.md and eslint.config.ts in the source archive

## 0.4.0 (2026-08-04)

### Features

- **actions:** Find references — sources you can vet, then cite ([#30](https://github.com/dsebastien/obsidian-ai-editor/issues/30))

### Bug Fixes

- **plugin:** rename to "AI Editors" to clear a catalog name collision

## 0.3.0 (2026-08-04)

### Features

- **actions:** Expand section and Continue the note — the placement verbs ([#31](https://github.com/dsebastien/obsidian-ai-editor/issues/31))
- **ask:** panels join the picker, and the ask becomes 'Ask a question' ([#27](https://github.com/dsebastien/obsidian-ai-editor/issues/27))
- **panel:** up/down section cycling from the pinned header
- **rail:** an empty editor chip summons a review with just that editor
- **rail:** summoning an idle editor JOINS the note's run instead of being blocked by it

### Bug Fixes

- **editor:** a finding over a link opens the card on plain click, not the link
- **panel:** pin the header and tab bar while the findings list scrolls
- **panel:** the pinned header owns the leaf padding so nothing scrolls through it
- **panel:** the section-nav pair aligns with its neighbors as one split control
- **rail:** findings toggle becomes a labelled button owning the row; collapse becomes a drawn chevron
- **rail:** give the head's utility buttons real button chrome, on one row [#28](https://github.com/dsebastien/obsidian-ai-editor/issues/28)
- **rail:** retry joins its row as a split segment
- **review:** size guard prices the selection, not the note around it
- round-3 adversarial review — non-destructive hydrate, submit-time panel re-check, deduped request count

## 0.2.0 (2026-08-02)

### ⚠ BREAKING CHANGES

- **contract:** structured edits replace free-text suggestions (#17, #22)

### Features

- **backends:** classify failures, retry only what is retryable, daemon auto-off ([#23](https://github.com/dsebastien/obsidian-ai-editor/issues/23))
- **contract:** structured edits replace free-text suggestions ([#17](https://github.com/dsebastien/obsidian-ai-editor/issues/17), [#22](https://github.com/dsebastien/obsidian-ai-editor/issues/22))
- **panel:** acknowledge an all-good editor to clear its section ([#24](https://github.com/dsebastien/obsidian-ai-editor/issues/24))
- **panel:** History tab — session archive, durable per file behind a setting ([#21](https://github.com/dsebastien/obsidian-ai-editor/issues/21))
- **rail:** appearing Selection segment reviews only the selected text ([#26](https://github.com/dsebastien/obsidian-ai-editor/issues/26)), closes [28/#33](https://github.com/28/obsidian-ai-editor/issues/33) [#14](https://github.com/dsebastien/obsidian-ai-editor/issues/14) [#33](https://github.com/dsebastien/obsidian-ai-editor/issues/33)
- **rail:** collapse to the daemon toggle, expand back ([#28](https://github.com/dsebastien/obsidian-ai-editor/issues/28))
- **review:** show/hide findings per note, pausing the daemon while hidden ([#29](https://github.com/dsebastien/obsidian-ai-editor/issues/29))
- **ui:** rail fades when idle, finding text is selectable and copyable ([#33](https://github.com/dsebastien/obsidian-ai-editor/issues/33), [#34](https://github.com/dsebastien/obsidian-ai-editor/issues/34))

### Bug Fixes

- **backends:** truncation is its own failure, and near-JSON is recovered ([#18](https://github.com/dsebastien/obsidian-ai-editor/issues/18))
- **daemon:** 3s idle default, any interaction resets the window ([#20](https://github.com/dsebastien/obsidian-ai-editor/issues/20))
- harden JSON recovery, quota sniff, daemon pause and acknowledgements [#18](https://github.com/dsebastien/obsidian-ai-editor/issues/18) [#29](https://github.com/dsebastien/obsidian-ai-editor/issues/29)
- **review:** re-reviewing keeps findings and the user's triage ([#19](https://github.com/dsebastien/obsidian-ai-editor/issues/19))
- second adversarial round + lint currency (obsidianmd 0.4.1) [#35](https://github.com/dsebastien/obsidian-ai-editor/issues/35)
- **settings:** the last three ai-editor-prefixed identifiers finish the rename

## 0.1.0 (2026-08-01)

### Features

- **a11y:** a finding highlight says whose it is without its colour
- **actions:** a custom action states what it does to the note
- **actions:** action-binding resolution to dispatchable targets
- **actions:** built-in verb registry with per-verb instruction prompts
- **actions:** custom actions dispatch like built-ins, class and all
- **actions:** humanize built-in action verb
- **backends:** dedicated OpenRouter backend kind
- **backends:** per-backend thinking settings for all API providers
- **cli:** a CLI backend resolves like any other, everywhere
- **cli:** a health check that runs the real thing, and a detector that runs nothing
- **cli:** a panel review returns its scorecard instead of paying for one and dropping it
- **cli:** add ai-editor:cancel subcommand
- **cli:** add ai-editor:status subcommand
- **cli:** buffered ai-editor:review CLI handler
- **cli:** cancelling a run kills the whole tree, and checks
- **cli:** claude code and codex invocation contracts
- **cli:** CLI editor executor behind the same contract as API backends
- **cli:** consent is a record of which binary, not a yes [#12](https://github.com/dsebastien/obsidian-ai-editor/issues/12)
- **cli:** the note reaches the tool over stdin, in a sandbox it cannot escape
- **cli:** what runs, what it can see, and what it may say are decided before anything starts
- **commands:** bulk accept and dismiss per editor and for the whole run
- **commands:** dynamic per-action palette commands follow the settings
- **commands:** static palette commands for review dispatch and finding navigation
- **commands:** toggle daemon mode from the palette
- **commands:** unified memory-based triage stepping engine
- **comments:** ask for comments, from three surfaces
- **comments:** background comment runs, keyed by comment and not by view
- **comments:** background job lifecycle with honest interrupted-job semantics
- **comments:** background jobs yield to foreground work
- **comments:** durable comment schema and cross-session re-anchoring
- **comments:** margin column geometry and card model
- **comments:** sidecar repository with atomic writes and corruption recovery
- **comments:** the durable store loads with the plugin and follows the vault
- **comments:** the job registry joins the durable store to the live runs
- **comments:** the margin column follows the note
- **comments:** the margin column renders
- **comments:** the side panel shows background jobs with live timers
- **context:** follow links from prompt-source notes into the prompt
- **context:** one budget policy, and it reports what it dropped
- **context:** one prompt-build entry point, and a preview that reads it
- **daemon:** daemon controller glue, rail armed indicator, editor-set redispatch seam
- **daemon:** pure daemon scheduler core (idle windows, coalescing, fire gates)
- **diff:** word-level LCS diff with whitespace preservation and bridge folding
- **domain:** M0 contracts and anchoring engine
- **editor:** dispatch incremental stale-marking while the user types
- end-to-end review flow - transport, backend glue, review UI wiring
- M1-M2 slice - providers, orchestration, context assembly, settings UI, CM6 skeleton
- **orchestration:** enforce behavior.maxConcurrentRequests across all runs
- **orchestration:** lean TransformRunHandle + TransformController sharing the review gate [3/#4](https://github.com/3/obsidian-ai-editor/issues/4)
- **orchestration:** per-editor retry inside an existing run, closes [3/#4](https://github.com/3/obsidian-ai-editor/issues/4)
- **panel:** decide per-editor finding navigation, purely
- **panel:** Review button in the side-panel header, bound to the panel's note
- **panels:** a panel run is one run, aggregation and all
- **panels:** every surface that convenes a panel starts a panel run
- **panels:** one vocabulary for telling an editor from a panel
- **panel:** step through one editor's findings from its section
- **panels:** the aggregation request fits a budget, and says what it left out
- **panels:** the charter reaches every member's prompt
- **panels:** the scorecard is a typed shape, not a bag of strings
- **panels:** the scorecard is on screen, and its fixes point at the text
- **plugin:** present transform results inline with rail spinner and shared cancel
- **plugin:** rail chip tooltips name each editor with its live status
- **plugin:** show what's new in a tab instead of a modal dialog
- **rail:** a panel run is one ringed entity that owns its members [#11](https://github.com/dsebastien/obsidian-ai-editor/issues/11)
- **rail:** flip daemon mode from above the Review button
- **rail:** name every row, ring every status
- **rail:** render named rows, status rings and motion cues
- **review:** ask an editor for more without throwing away what it said, closes [3/#4](https://github.com/3/obsidian-ai-editor/issues/4)
- **review:** bulk triage planning and severity filter state
- **review:** one reviewability gate that says why, and the panel button state it feeds
- **review:** per-finding push-back thread state
- **review:** run instructions target a set of editors
- **review:** the "Generate more" affordance, priced in the label
- **review:** thread turn orchestration and dispatch [#7](https://github.com/dsebastien/obsidian-ai-editor/issues/7)
- **rules:** binding rules filter the dispatch path (closes SEAM M6)
- **rules:** pure binding-rule engine and note-type resolver
- **rules:** vault seam for note facts and the optional OSK adapter
- **services:** selection scope plumbing for review runs
- **services:** shared reviewability predicate + settings mutation observer
- **services:** transform service dispatches built-in action verbs end-to-end
- **settings:** actions tab enforces review-only panel bindings and surfaces hidden actions
- **settings:** CLI backends are creatable, behind two separate consents
- **settings:** configurable request timeout replacing hardcoded 300s
- **settings:** daemon mode schema and behavior tab controls
- **settings:** import and export dialogs in the Behavior tab
- **settings:** Rules tab states the real evaluation order and what each rule does
- **settings:** schema-versioned settings model with salvage load and referential integrity
- **settings:** settings transfer — export a subset, import it as a plan
- **settings:** setup wizard core — step machine, one shared backend rule, real health check
- **settings:** starter pack seeds default action bindings
- **settings:** the Actions tab can actually author a custom action
- **settings:** the CLI backend dialog states which tool it runs
- **settings:** the settings tab asks for support, like every other plugin
- **settings:** the setup wizard, its copy, the command and the first-run trigger
- **settings:** vault note autocomplete on note-reference fields
- **starter-pack:** humanizer persona from osk-writing-humanizer taxonomy
- **starter:** the charter says what "top" means and what to do with dissent
- **transport:** chunk-safe SSE decoder with adversarial chunking tests
- **ui:** a modal that shows exactly what will be sent
- **ui:** a rule-disabled note shows no rail, no menus, no commands
- **ui:** adaptive narrow-pane layout for the rail and cards
- **ui:** bound actions dispatch from the editor context menu
- **ui:** current-finding decoration state and programmatic card open
- **ui:** editor and file context menus for review dispatch
- **ui:** finding card push-back threads
- **ui:** freeform ask-an-editor modal entry point (design §6 decision 1)
- **ui:** inline transform preview widget with word-level diff and accept/reject
- **ui:** keyboard triage loop — cursor, card-on-jump, accept/dismiss commands
- **ui:** per-file severity filter over decorations, panel and triage
- **ui:** rail chip click reveals and cycles the editor's findings
- **ui:** retry affordance on failed editors in rail chip and side panel

### Bug Fixes

- **a11y:** a colour swatch says which colour is chosen
- **a11y:** six of the seven settings tabs pointed aria-controls at nothing
- **a11y:** the settings tab bar keeps the promise its roles make
- **a11y:** the side panel names what it shows
- **backends:** adaptive thinking for current Anthropic models, legacy budget clamps, compatible reasoning progress
- **backends:** launch consent is enforced where a backend becomes a process
- **backends:** stream the OpenRouter kind
- **cli:** --editors stops being resolved against the rule it should override
- **cli:** distinct bad-args error code and state-derived settled report
- **cli:** every run ends with the tree verified gone, and an aborted run never starts one
- **cli:** report mid-retry editors as retrying skips in one-shot review output
- **cli:** the Windows kill goes through the boundary's own gate
- **comments:** margin column follows the right note, and costs nothing on quiet panes
- **comments:** the durable store stops losing comments to its own edge cases
- **comments:** the margin answers, and a refusal never strands a comment
- **comments:** the margin column stops eating focus, cards and names
- **daemon:** abort dispatch on mid-flight disable/unload, clear schedule on same-pane navigation, reduced-motion guard
- **orchestration:** occurrence-aware finding dedupe and run eviction
- **orchestration:** release concurrency permit when an editor goes terminal
- **panel:** Ask for comments finds the note the panel is showing
- **panels:** a member's findings dropped by the contract cap are counted as omitted
- **panels:** a run being aggregated is still running, and the scorecard is checked against the roster
- **panel:** the finding stepper answers a keyboard, and says where it landed
- **plugin:** heal registerView double-load race instead of dying on load
- **preview,docs:** an excluded note keeps its preview command, and the guide stops calling push-back a placeholder
- **preview,review:** the preview accounts for the panel charter, and an unavailable panel refuses before the size guard
- **preview,rules:** the preview accounts for action instructions, and a foreign regex cannot freeze the UI
- **providers:** ollama think:false and advisory-hint clamping from live-vault verification
- **rail:** reconcile the rows, and say what is happening
- **review:** a detached run never opens a thread turn
- **review:** actionable requires an anchored text like accept does
- **review:** close CLI/selection contract holes from adversarial fix pass
- **review:** rebase the triage cursor onto live anchors
- **review:** report disabled and deleted instruction editors as typed skips
- **rules,review:** one note-scoped answer to "who would review this note"
- **rules:** detect the Starter Kit, and pick note types from its list
- **rules:** the Starter Kit is only mentioned when it is there
- **settings:** an export never carries CLI launch consent
- **settings:** an import is a destination, and a cap must not orphan a reference
- **settings:** repair duplicate entity ids and settings-tab paper cuts
- **settings:** the CLI surfaces stop overstating what they know
- **settings:** the seeded panel's name is sentence case like everything else
- **settings:** the two Behavior toggles that promised things and did nothing
- **settings:** the wizard saves what it validated, and refuses the case it says it refuses
- **styles:** the stylesheet stops styling the whole app
- **transport:** name CORS in the opaque fetch network failure message
- **ui:** a renamed folder no longer strands a run under every note in it
- **ui:** accessible names for the filter, the thread and the rail button
- **ui:** ask-editor submit guards note switch and collapsed-capture scope
- **ui:** card-on-jump survives the reveal scroll
- **ui:** isolate finding accept from adjacent undo history
- **ui:** panel bulk actions act on the file the panel shows
- **ui:** push-back locks the card immediately and never loses the message
- **ui:** sentence case stops being an opinion and becomes a rule
- **ui:** status-bar fallback, file lifecycle cleanup, timer and card guards
- **ui:** the panel is called AI Editor Review everywhere
- **ui:** the two asks stop being hidden by a rule they override
- **ui:** the two strings the panel rename missed
- **ui:** the verdict reaches the rail's accessible name, cards say which panel, and the fan-out prices itself
- **ui:** transform preview survives note-switch loads and isolates accept undo
- **ui:** user-facing names say AI Editor, and the wizard gets its spacing
- **ui:** verdict pills say what the verdict means, not the wire token
- **ui:** wider finding card and live-view fallback for panel binding
- **whats-new:** the unload path stops detaching the tab's leaves

### Performance Improvements

- **anchoring:** one normalization pass per document, not per quote
- **context:** one view of the vault per run, not one per editor
- **diff:** a large rewrite gets a real diff, not a before/after
- **ui:** the highlights are capped, and the panel says by how much
