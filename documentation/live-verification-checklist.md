# Live verification checklist

Everything below needs a human in a running Obsidian vault — no agent verified any of it.
Extracted 2026-07-31 from the per-day development history before that history was removed;
grouped by the feature that introduced the check. Work through this before submitting.

Test vault note: the plugin folder is `.obsidian/plugins/editor-ai-daemons/`, and
`editor_ai_daemons: false` (not the old key) is the frontmatter opt-out.

---

## Theming, reduced motion and accessibility sweep (v1 sweep stage I, slice 1 — M9)

- Switch to Border and to Minimal, light and dark: cards, chips, the rail, the margin column and every dialog take the theme's corner radius, and the margin card's shadow matches the finding card's.
- Turn on the OS "reduce motion" setting: the rail dots, the daemon dot, the panel ring, the review spinner, the chip-click flash and the in-flight thread message all stop moving, and every one of those states is still readable.
- Three editors on one note: their highlights differ by underline STYLE as well as by tint. Hover one — the tooltip names the editor, the severity and, in a panel run, the panel. Edit the quoted text: the tooltip says stale.
- A theme that restyles `mark` in reading view must not change anything in the editor (the marks are still `<span>`s — this is the check that the rejected `<mark>` decision was the right one).
- Settings, keyboard only: Tab lands ONCE on the tab bar, Arrow Left/Right cycles with wrap, Home/End jump, the panel changes with the tab, and focus stays on the tab after each move. Then Tab moves into the settings themselves.
- Pick a persona colour with the keyboard: the check appears on the chosen swatch and focus is on it, not lost to the document.
- Tab to a finding row in the side panel: the ring is clearly distinct from the hover tint. Same for the transform preview widget.
- Screen reader over the side panel: each section announces its editor (and its panel when there is one), each finding announces its severity, each scorecard row announces one sentence rather than running into the next.

## Stage H review fix pass

- Park a comment and WATCH IT without touching anything: "Queued" → "Reviewing 0:07" with a ticking timer → the answer, all without scrolling or clicking. Expand a long answer and let the timer tick on another card: the expansion must not collapse and focus must stay where it was.
- Type three lines above a comment: the card follows its line. Delete the quoted text: the card moves into the orphan group at the top.
- Expand four orphan cards on a note that also has anchored ones: the anchored cards must still be there, and the orphan box scrolls rather than swallowing the column.
- Kill Obsidian mid-write (or delete `comments.json` leaving `comments.json.tmp`): the next start says the last save was interrupted and the comments are back.
- Two devices: park a comment on B while A has the vault open, then add one on A. Both survive, and A shows a Notice about the merge.
- Retry a comment on an oversized note: the size confirmation appears and, if dismissed, the card is still "Failed"/"Interrupted" with Retry — never "Queued" forever.
- Corrupt `comments.json` AND make the plugin folder read-only: the startup Notice appears and "Ask for comments…" refuses with its own Notice instead of sending a request.
- Screen reader on an orphan card: it announces the editor, the state, the question, and that the text it was about is gone.

## The margin column, and a way to ask for a comment at all (v1 sweep stage H, slice 3)

- Select a sentence → **Ask for comments…** → pick an editor → the card appears beside that line reading "Queued", then "Reviewing 0:07" with a live timer, then the answer.
- Type above the comment: the card follows the line. Scroll: it stays glued to its text, and comments whose lines leave the pane disappear without the note's text reflowing.
- Readable line length ON: the column sits in the empty margin and the text does not shift when the first comment lands. Turn it OFF: the editor is padded once and the cards never overlap the prose. Toggle it back and forth — the column must not flicker between the two.
- Two comments on the same line: one "2 comments" chip that expands to both cards and collapses again.
- Edit away the text a comment was about: the card moves into the collapsed group at the top, its quote is shown, and Retry is not offered.
- **Delete** asks first and never comes back; **Resolve** removes the card from the margin but the comment is still listed in the review panel.
- Narrow the pane below ~700px: the column disappears and the comments are still in the panel; `Toggle the margin comment column` says where they went.
- Restart Obsidian with a job in flight: the card comes back as "Interrupted" with Retry, and Retry re-anchors against the note as it reads now.
- Popout window and two panes on the same note: each pane renders its own column and each follows its own scroll.
- A long answer shows "Show more"; expanding it must survive scrolling and the once-a-second timer tick without collapsing.

## Action dispatch — bindings become real (v1 sweep stage C, slice 3)

- Context menu on a selection shows bound actions with class icons, capped and alphabetical; Review selection / Ask an editor unchanged.
- Fresh install (or `starterPackSeeded` reset): the seven default bindings appear pre-wired in the Actions tab and in the menu/palette.
- Palette: `action-<verb>` commands appear/disappear live as bindings change in settings (no reload); a hotkey bound to Humanize survives renaming its editor.
- Transform verb dispatch end-to-end: select text → Humanize → chip pulses "transforming" → inline diff widget → Accept is ONE undo step; Esc rejects.
- Review-class verb bound to the starter panel: every member runs with the instruction; members without a usable backend reported as skips.
- Actions tab: bind a verb, disable its editor → warning line appears; transform verbs offer no panels in the dropdown.

## Chip click reveals and cycles findings (v1 sweep stage D, slice 0)

- Click a chip with findings: first click scrolls to and briefly selects the FIRST finding while all of that editor's highlights flash stronger for ~2 s; repeated clicks walk the findings in document order and wrap.
- Two editors with findings: clicking chip A then chip B flashes only B's highlights and starts B's cycle at its first finding.
- Chip of an editor that reported nothing but returned a summary (or failed): the side panel opens scrolled to that editor's section.
- Clicking a chip mid-review does nothing.
- OS reduced-motion on: the flash is a static stronger tint, no pulse.
- The retry glyph under a failed chip still retries (chip click behavior does not swallow it).

## Stage C review fix pass

- Note switch onto a file with a completed (still pending-presentation) transform: the inline diff appears after the switch instead of dying with "The text changed".
- Type at the end of a selection, accept the transform within half a second: one Ctrl+Z reverts ONLY the transform; a second reverts the typing. Same isolation when typing immediately after accepting.
- Review-class verb bound to a panel with one disabled member: the run reports "skipped <name>: the editor is disabled" (side panel / Notice) while the other members run.

## Keyboard triage state machine (v1 sweep stage D, slice 1)

- `Next finding` from anywhere: reveals the finding after the cursor position, rings it, opens its card; repeated presses walk ALL editors' findings in document order and wrap.
- With the card open from a triage step: Escape closes the card only; the ring stays; the next `Next finding` continues from the ringed finding. Escape again (no card) drops the ring.
- `Accept current finding` on a ringed finding: the edit applies as ONE undo step, the ring jumps to the next remaining finding and its card opens; `Dismiss current finding` likewise without an edit.
- Judge the last finding: Notice "No more findings to triage.", no ring, no card.
- Edit inside the ringed finding's span: it dims (stale), the ring disappears with it; the next step resumes from that position instead of restarting at the first finding.
- Card scroll-close race: verify the card opened by a triage jump does not immediately close on the reveal scroll (if it does, the card's scroll-close listener needs a grace window for programmatic reveals).
- Reduced motion: the current ring is static (nothing to check beyond presence).

## Bulk operations and severity filter (v1 sweep stage D, slice 2)

- Panel section with several findings: `Accept all (n)` applies them all at once, ONE Ctrl+Z restores the whole batch, and the Notice matches what happened.
- Two findings overlapping the same span: only the earlier one applies, the Notice says "Skipped 1 overlapping", and the later one is still in the panel (re-review it).
- Edit a finding's span, then `Accept all`: that one is skipped as "no longer matching the text" while the others apply.
- `Dismiss all (m)` clears that editor's highlights and the panel list; an open card closes; no undo entry is created.
- Palette: `Accept all from <Editor>` appears only while that editor has something acceptable in the active note; renaming the editor renames the command and keeps a bound hotkey working; disabling the editor removes both commands without a reload.
- `Cycle severity filter` (or the panel button): info findings disappear from the highlights AND the panel, the hidden count matches, `Next finding` walks only the visible ones, and `Accept all` counts drop accordingly. Cycling back to "All severities" restores everything (nothing was mutated).
- Filter + triage: with the ringed finding hidden by a filter change, the ring disappears and the next step resumes from that position.

## Per-finding push-back threads (v1 sweep stage D, slice 3)

- Open a finding card, type an objection, press Enter: the message appears greyed with a pulse, the input locks and reads "Waiting for <Editor>…", and the reply appears under it a moment later.
- Same again but close the card immediately: a Notice announces the reply, and reopening the card shows the full exchange.
- Editor concedes: the finding's highlight disappears, the Notice says it withdrew it, and the panel count drops.
- Editor revises: the card's old/new diff shows the NEW suggestion and Accept applies that one; edit the span first and Accept is disabled ("The text changed since this suggestion was made").
- Six exchanges on one finding: the input disables and reads "Push-back limit reached for this finding".
- Kill the network (or use a bad key) and push back: the message stays with "Push-back failed: …", the input is repopulated, and sending again works once the backend is back.
- `Cancel review` while a reply is in flight: the pending row turns into "Cancelled" and no Notice fires.
- Type a second message while the first is still in flight (from another pane's card): the refusal Notice says the editor is still answering.
- Reduced motion: the pending row is static (dimmed only).

## Adaptive narrow-pane layout (v1 sweep stage D, slice 4)

- Split the editor until a pane is under ~500px: the rail shrinks and the button becomes a glyph; hovering it says what it does and points at "AI Editor: Open review panel".
- Drag the split slowly across ~500-560px: the rail switches once per direction, no flicker inside the band.
- With a narrow right-hand split, click a finding highlight near the split boundary: the card stays inside that pane (it may be as narrow as ~240px) and its Accept/Dismiss row wraps rather than clipping.
- Same in a popout window, and with the note open in two panes at once (each pane's rail follows its OWN width).
- Collapse the left sidebar / switch tabs: rails in other panes must not flip form (widths measured while hidden are ignored).
- Run a transform in a narrow pane: the preview's Accept/Reject row and the "Enter to accept · Esc to reject" hint wrap instead of overflowing.
- Reload with a pane already narrow: the rail comes up compact immediately (no wide-then-compact flash).

## Stage D review fix pass

- Findings A, B, C down the note; `Next finding` twice to ring B; delete a paragraph ABOVE all three; dismiss B from its card; `Next finding` must land on C, not back on A.
- Push back on a finding: the message greys out with the pulse and the input locks INSTANTLY (before the reply), and a second Enter in that window does nothing instead of losing the message.
- Make the push-back fail (bad key): the message comes back in the input and Send works once the backend is up.
- Tab into an open card's thread list and scroll it with the arrow keys; with a screen reader on, a reply arriving in the open card is announced.
- Trigger a triage jump that scrolls the view: the card stays open.
- Panel showing note A's findings while note B is active in another pane: `Accept all` in the panel must edit A.
- OpenRouter backend: findings appear one by one during the review (streaming), not all at once at the end.
- Narrow pane: the Review glyph announces "Review this note with the enabled editors" and its tooltip points at "AI Editor: Open review panel" — which opens the panel.

## Binding rules actually filter, and note types are real (v1 sweep stage E, slice 1)

- Add a rule `folder "Private"` → **Disable plugin**. Open a note in `Private/`: no rail at all, right-click a selection gives no AI Editor items, and `Review current note` / the action commands / `Next finding` are absent from the palette. `Cancel review` is still there if a run is somehow in flight.
- Review a note, then add a kill switch matching it while its findings are on screen: the highlights disappear, an open card closes, the side panel shows its empty state. Delete the rule again: the highlights come back on the SAME spans, even after typing above them.
- Add a rule `tag "draft"` → **Assign reviewer** → one editor. Review a `#draft` note: only that editor runs (rail shows one chip). Review a note without the tag: every enabled editor runs.
- Point a rule at the Pre-publish panel: every member runs, and a member you disable shows up as a skip Notice rather than vanishing.
- Delete the panel a rule points at (accept the impact dialog), then re-add a rule pointing at a panel and delete the panel from `data.json` by hand: the review refuses with "the matching rule's panel no longer exists" instead of reviewing with everyone.
- With rules present, restart Obsidian and immediately open a note matching a TAG kill switch: the rail must not flash before the metadata cache warms up.
- Rules tab with the Starter Kit enabled: the paragraph says "detected", and a rule `osk-note-type "Permanent Notes"` matches a `type/permanent_note` note (via the registry's tag mapping). Disable the Starter Kit and reload: the paragraph says "not detected", the same rule stops matching, and `osk-note-type "permanent_note"` matches instead.
- Ask an editor on a note a rule assigns to a DIFFERENT editor: the editor you picked answers, not the rule's.
- Daemon mode on, with a kill switch matching the note: no automatic refresh, no armed dot, no log spam.
- `obsidian ai-editor:review --file <switched-off note>` returns `"code": "rule-disabled"` and names the rule.

## The context budget is a policy, and the plugin will show you what it sends (v1 sweep stage E, slice 2)

- Run "Preview what will be sent" on a note with a persona note, a wikilink in the persona prompt and `Include linked notes` on: the section list shows the system prompt, the reviewed note, then one row per attached note, each labelled with why it is there, and the totals add up to the number in the first summary line.
- Type into the note without saving, then preview again: the reviewed-note row grows. (The settings-dialog Preview button will NOT show the unsaved text — it reads the vault. That is the documented difference.)
- Set the context budget to 2000 on a long note: the summary says the request is over budget by N characters, every attachment row reads "Dropped — budget exhausted", and the row still shows how big each dropped note was.
- Set the budget so exactly one attachment straddles it: that row reads "Truncated to fit the budget" with `sent of source`, and the rows after it read dropped.
- Copy, then paste into a scratch note: the summary, the section table, and the verbatim system prompt come through, prompt last.
- Preview on a note in an excluded folder: the modal says nothing would be sent and points at the Behavior tab. Add a kill-switch rule instead: the command disappears from the palette entirely (the rule suppresses every surface); remove the rule and it comes back.
- Open the editor dialog, change the persona prompt WITHOUT saving, click Preview: the shown prompt contains the unsaved text.
- Delete an editor from another window while its preview is open, then switch the picker to it: "this editor no longer exists", not a stale prompt.
- Preview with the picker on an editor whose backend is disabled: the prompt is still shown and a line says the editor cannot run.

## Custom actions grow up, and settings become portable (v1 sweep stage E, slice 3)

- Add a custom action, leave the class unpicked: its row says "needs an action type", and it appears in neither the selection menu nor the palette. Pick "Rewrite the selection" and bind an editor: it appears in both, and running it shows the inline diff.
- Same action switched to "Report findings": running it produces highlights instead of a diff, and the Actions tab now offers panels in its binding dropdown. Bind the Pre-publish panel, then switch the class back to "Rewrite the selection": the binding clears itself in front of you rather than the action silently disappearing.
- A custom action set to "Write more at the cursor", run with a collapsed cursor: the insertion preview appears; it must NOT demand a selection.
- Give a custom action an instruction note plus **Follow links**, and run "Preview what will be sent" — the linked notes are not in the system prompt (an instruction is not context); confirm the instruction reached the request by watching the action's result, or by checking the request in a proxy if one is configured.
- A custom action whose only instruction note sits in an excluded folder: the Notice says its instruction notes are missing or excluded, and no request goes out.
- Export with everything ticked to `ai-editor-settings.json`: open the file — every `apiKey` is `""`. Export again to the same path: an overwrite confirmation appears first.
- Export with nothing ticked: a Notice asks for at least one section; no file is written.
- Export to a path inside a folder that does not exist: the Notice says the write failed and the dialog stays open.
- Copy to clipboard, then Import… and paste: the summary says what will be added, the voice-profile line says REPLACED, and the key notice points at the Backends tab. Confirm, and the counts match what the settings tabs then show; the entities you already had are untouched and still bound to each other.
- Import the same file a second time: two independent copies, no merge, no renumbering of the originals.
- Import a file containing only panels, into the vault they came from: the panels keep their original member editors (no "members dropped" line).
- Import a file containing only editors that referenced a backend: each arrives with "will use your default backend".
- Import a file whose actions include a verb you already bound: that row is listed under Skipped as "already bound here", and the rest still imports.
- Paste something that is not JSON, then a JSON array, then `{"hello":"world"}`: three different messages, Import stays disabled throughout.
- Import a file with an empty `editors: []` and nothing else: the summary says nothing would be added and Import stays disabled.
- Import → Load with a path that does not exist: a Notice, no crash.

## The panel can start a review (GitHub issue #16)

- Open the review panel with no note open: the header says "No note", the button is disabled, its tooltip says to open a note.
- Open a note that was never reviewed: the header shows its name, the button is enabled, the body says "No review yet. Select Review to start one." Select it: the note is revealed, the review starts, the rail and the panel fill in together.
- Click Review from the panel while focus is IN the panel (not the editor): it runs on the last active note, not on nothing.
- While a run is in flight: the button reads "Reviewing…" with a spinner, is not clickable, and its tooltip says to cancel first. Cancel from the rail: the spinner stops and the button returns to "Review" without any interaction with the panel.
- Retry a failed editor from the panel: the button goes busy again for the duration of the retry (`isSettled()` flips back).
- Start a transform action instead: the panel button stays enabled (a review does not destroy a transform).
- With the OS set to reduce motion, the spinner does not rotate; the label still says "Reviewing…".
- Add a kill-switch rule for the note: the findings list disappears, the button goes disabled and its tooltip names the rule. Remove the rule: everything comes back.
- Put the note in an excluded folder: the tooltip names the privacy settings (Behavior tab).
- Disable every editor: the tooltip says no editor can review.
- Tab to the button and press Enter/Space on each of those states: it activates only when enabled.

## The setup wizard, and M5 is feature-complete

- Fresh install: the wizard opens once the workspace has finished restoring (not before), and the "What's new" tab does not appear alongside it.
- Walk it with Enter only, touching nothing: six steps, then "AI Editor is set up." Settings are unchanged except `onboarded`, the editor toggles you did not move, and daemon mode staying off.
- Escape on step 3, then restart Obsidian: the wizard does NOT reopen. Run "AI Editor: Run setup wizard": it opens, and its editor toggles reflect the current settings.
- Pick OpenRouter, paste a key, leave the model empty, select Test connection: a Notice asks for a model, and no request goes out.
- Pick OpenAI-compatible, leave the base URL empty, select Next: it refuses with the same sentence the Backends tab gives.
- Ollama with a running server and a small model: Test connection reports success in green. Stop the server and retest: a red failure naming CORS/reachability.
- Point at a real API with a valid key but a tiny model that cannot follow the schema: the result is the yellow "Reached, but not usable" line, not a red failure.
- Start a test against a cold Ollama model that takes over a minute: the failure line says a real run may still work with a higher request timeout.
- Type into the model field while a test is running: the result still lands when it returns (id-keyed guard). Switch the provider mid-test: the result is discarded.
- Turn off every editor on step 3 and finish: the last step leads with "No editor is enabled, so nothing will run yet."
- Skip the backend step entirely and finish: the last step leads with "No usable backend yet".
- Pick daemon mode: the cost warning appears; switch back to summon and it disappears.
- Add a voice profile note on step 4 and finish, then run "Preview what will be sent": that note is in the system prompt.
- Cancel on the last step (before Finish): nothing was written except `onboarded` — no backend, no toggle changes.
- Run the wizard from Behavior → Setup and finish: the settings tab re-renders with the new backend visible in the Backends tab.

## Stage E review fix pass

- Import a file whose backend points at a foreign host: the review lists "Where these backends send your notes" with that URL before you confirm, the backend arrives disabled in the Backends tab, and the adjustment says to check it before enabling.
- Import a file with enabled editors: the notice says how many would take part in every review.
- Export with a backend whose base URL is `https://gw.example/v1?api-key=X`, or one with a custom request body: the export dialog names it and says why, and no longer calls the file safe to share.
- Type `../escape.json` as the export path: a Notice refuses it and nothing is written; `Backups/settings` still works.
- Delete an editor a rule assigns, then open a note the rule matches: the panel button is disabled and its tooltip names the RULE (not "no editor"), the Rules tab row says the rule blocks reviews, and the command does not offer a review that would fail.
- Disable the only editor a rule assigns: same result, and a note the rule does not match still reviews normally.
- Run "Preview what will be sent" and pick a custom action from the Action picker: its instruction notes appear in the shown prompt for a "Report findings" action, and as a separate Instruction line with its size for a "Rewrite the selection" one. Copy: the transform case carries the instruction text, the review case does not (it is already in the prompt).
- Preview on a note in an excluded folder: the command is now in the palette and the modal says nothing would be sent, pointing at the Behavior tab. A kill-switch rule still removes the command entirely.
- Double-click the panel Review button fast on a cold Ollama: the second click is refused with a Notice instead of starting a second run.
- Open the review panel on a kill-switched note: the body states the refusal, not "Select Review to start one".
- Run the setup wizard, paste a base URL with a trailing space, finish: the Backends tab shows it trimmed and reviews reach the endpoint.
- In the wizard, fill a provider and a key but no model, select Next: it refuses and asks for a model.

## A panel run becomes one run (v1 sweep stage F, slice 1 — plan M6)

- Add a binding rule assigning the Pre-publish Review panel to a folder, then review a note in it: four editors run in parallel, the rail shows four chips, and every finding keeps its member's colour and name.
- Run "Preview what will be sent" on that note: the panel charter appears in the shown prompt, after the persona and before any action instruction.
- Disable the panel and review again: the same four editors still run, and the charter is NOT in the preview.
- Cancel mid-panel: every chip goes to cancelled and no aggregation request goes out (check the backend's logs / a local Ollama).
- Let one member time out (a tiny request timeout, or stop Ollama mid-run): the other members finish, the failed one keeps its retry affordance, and the aggregation still happens.
- Retry that member from the rail chip: it re-runs inside the same run, and the aggregation runs a second time once it settles.
- Point the panel's aggregation backend at a deleted backend: the members still review and nothing crashes.

## The scorecard is typed, budgeted and on screen (v1 sweep stage F, slice 2 — plan M6)

- Review a note through a panel: the rail shows ONE hollow ringed chip with the members' solid dots bracketed under it, and an enabled non-member editor still has its own dot outside the group.
- Hover the ring: it says "<Panel> (panel) — waiting for the members", then "writing the scorecard", then "scorecard ready"; a badge with the verdict appears next to it at the end.
- Select the ring: the side panel opens with the scorecard at the top — overall verdict pill, one row per member with its verdict and one-line rationale, numbered top fixes, and a dissent block naming each side.
- Select a top fix that quotes a finding: the note scrolls to that span and briefly selects it. A structural fix ("cut the second half") is plain text, not a button.
- Break the aggregation backend (bad key on the panel's backend) and review: the member sections and all their findings are still there, with the scorecard block above saying the scorecard could not be written and why.
- Point the panel at a deleted aggregation backend: the block says there is no usable aggregation backend and points at Settings → Panels.
- Cancel mid-panel: the block says the scorecard was cancelled; the findings the members already produced stay inspectable.
- Let one member fail: the scorecard lists it as "No review — not weighed" even if the model never mentioned it, and the top fixes still come from the members that ran.
- Set the context budget very low, then run a panel over a long note with many findings: every member still appears in the scorecard (none is starved), and the chairperson does not claim a member found nothing else.
- Narrow pane: the ring stays, the verdict badge disappears, and the tooltip still carries the verdict.

## Editors stop looking like panels, and an editor can be asked for more (v1 sweep stage F, slice 3 — plan M6)

- Bind `Critique` to the Pre-publish Review panel: the context menu item and the palette entry both read "Critique (panel: Pre-publish Review)", and the item still sits in alphabetical position for "Critique".
- Review a note with a panel: the side panel shows the scorecard headed "Pre-publish Review (panel)", and each member section below is indented with an accent rail. A screen reader announces each section as "<Editor> — member of Pre-publish Review (panel)".
- Review a note with a solo editor: no indent, no marker anywhere — the unmarked default.
- Let a review finish, then press **Generate more (n)** in a section: the button reads "Generating…" and is disabled, the chip pulses, and new findings appear ALONGSIDE the existing ones (nothing disappears). The count in the label goes up afterwards.
- Press it on an editor that reported nothing: the button reads "Generate more (0)" and the round runs.
- Press it twice quickly: only one round starts.
- Break the editor's backend, then press it: the section says "Could not generate more: …" next to the button, every existing finding is still there, the editor still reads as finished, and NO retry icon appears on its section header or its rail chip.
- Cancel from the rail while a "Generate more" round runs: same outcome — findings intact, editor finished, "Could not generate more: Cancelled".
- Run **Generate more findings** from the palette with a panel run open: every member starts one round, and the scorecard goes back to "waiting for the members" and is rewritten when they settle.
- Ask a long note for more twice and check the second request in the console/proxy: `alreadyReported` lists both rounds' findings, and the model's reply does not repeat them.

## Stage F review fix pass — and the CLI finally sees a panel (v1 sweep stage F — plan M6)

- Run a panel and watch the moment the members finish: the rail chip keeps pulsing and still says Cancel, the palette still offers **Cancel review or action**, and `ai-editor cancel --file …` reports `cancelled: true` while the scorecard is being written.
- Press Cancel during that window: the scorecard says it was cancelled, every member finding stays.
- With a scorecard on screen, press **Generate more (n)** on a member: the scorecard stays visible with the line "From the previous round — …", and is rewritten when the round lands. Cancel the round instead: the previous scorecard is still there, still marked as previous.
- Break the aggregation backend, then generate more: the scorecard block says it could not be written AND the previous scorecard is still readable.
- Screen reader on the rail's panel chip: the name includes the verdict ("Pre-publish Review (panel) — Needs work, scorecard ready"). Narrow the pane until the badge disappears: the tooltip still carries the verdict.
- Open a finding card from a panel member: the section reads "<Editor> — member of <Panel> (panel)" and shows the accent rail.
- `ai-editor:review --file <note>` on a note a rule binds to a panel, with the note NOT open: the JSON carries `panel` with the verdict and the fixes; `--format text` prints the `Panel …` / `Member …` / `Fix …` lines under the findings.
- Preview "what will be sent" on that same note: the summary lists "Panel charter (…)" and the system prompt contains the `<charter-note …>` blocks.
- Run **Generate more findings from every finished editor**: a notice states how many editors were asked.

## The CLI security boundary (v1 sweep stage G, slice 1 — M7)

- On Windows: `taskkill` path resolution and `/T` tree semantics — the escalation state machine is spec-covered, the Windows `send` implementation is not exercised by any spec on Linux/macOS.
- In the Obsidian renderer: that `require("node:child_process")` resolves. The bundle was verified to emit the require; only a live desktop run proves Electron answers it.
- Real-world grandchild behaviour of `claude`/`codex` under cancellation (slice 2, with a tool actually configured).

## Claude Code and Codex adapters (v1 sweep stage G, slice 2 — M7)

- A REAL review through a CLI backend end to end. Both tools were exercised with the shipped argv and answered, but with a trivial prompt — not with an assembled persona, a real note, and the operation schema. How often an agent CLI wraps the JSON in prose (and whether the closing directive is enough) is a question only real runs answer.
- Claude Code's behaviour when `allowTools` is on: which tools survive `--permission-mode manual` in a headless run, and whether `permission_denials` in the envelope should be surfaced to the user.
- Older/newer versions of either binary. The failure mode is designed to be loud (unknown option → non-zero exit → named on stderr), but no version other than the two probed has been tried.
- Cancellation against a real `claude`/`codex` process tree — the grandchild behaviour slice 1 flagged as open is still open, and now has a tool to try it with.

## CLI backends become reachable, behind two consents (v1 sweep stage G, slice 3 — M7)

- **A real review through a CLI backend, end to end** — still the big one. Both tools answered the shipped argv with a trivial prompt in slice 2; nothing has yet sent an assembled persona, a real note and the operation schema through one, and how often an agent wraps its JSON in prose is a question only real runs answer.
- Nested modals: the consent dialog opens from inside the CLI backend dialog. Obsidian stacks modals, but the interaction (focus, Escape ordering, the parent re-rendering after the child confirms) is not something a spec can check here.
- **Test connection** against a real `claude` / `codex`: the 120 s bound, the "reached but unusable" classification when the agent answers in prose, and whether the message reads usefully.
- **Detect** on a real machine: whether the curated location list actually finds a normal install of either tool. Its failure mode is benign (nothing found → paste the path), but the list is only as good as the locations in it.
- Consent revocation from the tab (Withdraw switches the backend off) and the stale-path dialog wording after editing an executable path.
- Cancellation against a real `claude` / `codex` process tree — open since slice 1, and now reachable from the UI for the first time.

---

## Stage G review fix pass (CLI boundary, adapters, settings, docs)

- `--setting-sources`: what it actually drops, measured on a machine with
  plugins, hooks and pre-approved permission rules configured. If it drops them,
  emitting it lets two consent sentences go back to being unqualified.
- The Windows kill path is spec-covered but has never run on Windows. The
  resolution and the environment are pinned; the `taskkill /T /F` behaviour
  behind them is not.
- A run that genuinely reports `survived` — now a run FAILURE — has no live
  exercise. It requires a process that ignores SIGKILL, which is not something
  a spec can portably create.

## Comments that outlive the session (v1 sweep stage H, slice 1)

- No user-visible surface ships in this slice; the checks below need a comment to exist, so they land with the next one. What CAN be checked now:
- Plugin loads in a live vault with no `comments.json` present: no Notice, no error, nothing written.
- Put invalid JSON in `<pluginDataDir>/comments.json` and reload: the plugin still loads, a Notice names the `comments.corrupt-*.json` it kept, and the original bytes are in that backup.
- Make the plugin folder read-only and reload with a corrupt store: the Notice says comments will not be saved this session.
- Confirm the store path follows a vault with a NON-default config folder (`manifest.dir`), not `.obsidian`.

## Background comment runs, and jobs that admit they died (M8 stage H, slice 2)

- With a job in flight, the side panel row ticks `Reviewing 0:01`, `0:02`… and the row does not jitter as the digits change; when it finishes the ticker stops (no permanent 1s interval).
- Quit Obsidian with a job in flight, reopen: the row reads **Interrupted**, says nothing was resumed, and offers **Retry**. No request fires on load.
- Retry after editing the text around the span: the job re-anchors and asks about the current text. Delete the span entirely and retry: a Notice says the text is no longer in the note and the comment stays listed as interrupted.
- Set `Max concurrent requests` to 2, park two comments, then press Review: the review starts immediately (the reserve) rather than waiting behind them.
- Set it to 1, park a comment, press Review while it runs: the review waits for at most that one job, and no background job ever overtakes it.
- Cancel a running job: the row becomes Interrupted immediately (not on the next stream event) and Retry appears.
- Dismiss a job: the row disappears from the panel and does not come back after a reload.
- Rename the note while a job runs: the answer still lands on the comment under the new path. Delete the note while a job runs: nothing is written back.
- Screen reader on a row: one sentence naming the editor, the state and the elapsed time; the Retry/Cancel/Dismiss buttons say which comment they act on.

## Performance passes: measured, then fixed (M9 stage I, slice 2)

- Open a large note (100k+ characters) with a review in flight and type continuously: no stutter while findings land. Before the matcher change this was the worst case on the whole plugin.
- Park several comments on a large note, edit the text so some of them orphan, then type: the margin must not hitch on each edit batch.
- Run a transform over a long selection (2 000+ words): the preview must show word-level red/green, not one struck block followed by one inserted block.
- Run a panel of several members on a note with many `[[links]]`: the run should start noticeably sooner than before (each linked note is read once for the whole panel).
- Contrive more than 2 000 findings on one note (many editors, or repeated "Generate more"): the note keeps 2 000 highlights, the side panel says how many are listed but not highlighted, and keyboard triage can still step to — and ring — an undecorated finding.

## The support CTAs catch up with the fleet (v1 sweep stage I, slice 3 — plan M9)

- Open **Settings → AI Editor**: the support section (Knowii / GitHub Sponsors / Newsletter + YouTube, then the Buy me a coffee badge) appears below the tab content on every one of the seven tabs, and the badge image renders from the inlined data URL.
- Keyboard: arrowing across the settings tab bar must still land focus on the tab button, not on the support links now sitting after the panel.
- In **Settings → Community plugins**, the installed AI Editor entry should show three funding links rather than one.
