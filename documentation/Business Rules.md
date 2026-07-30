# Business Rules

This document defines the core business rules. These rules MUST be respected in all implementations unless explicitly approved otherwise.

---

## Documentation Guidelines

When a new business rule is mentioned:

1. Add it to this document immediately
2. Use a concise format (single line or brief paragraph)
3. Maintain precision - do not lose important details for brevity
4. Include rationale where it adds clarity

## Product invariants (locked 2026-07-29)

1. **User-initiated only.** No AI call ever runs automatically — not on note open, not on file change. Every backend request is triggered by an explicit user action (Review, an action verb, a push-back, a comment submission, a gate run). **Carve-out (2026-07-29, daemon mode):** enabling the `Daemon mode` settings toggle IS that explicit action — with it on, editors re-dispatch a review automatically after the user pauses editing a reviewable note whose text actually changed since its last run (idle delay configurable; oversized notes silently skipped; never while a run is in flight). Default off; the settings copy states the cost implication plainly.
2. **Suggestions, never silent mutations.** Every AI-proposed change goes through a visible diff with Accept/Reject. There is no code path that writes AI output into a note without user confirmation.
3. **Accept verifies preconditions.** A proposal may only be applied if the target text still equals the text the proposal was computed against. Stale proposals are marked and must be regenerated — never silently fuzzy-relocated.
4. **Findings must quote verbatim.** Backends return exact quotes from the submitted snapshot; anchoring resolves quotes to positions. Only exact or uniquely-contextualized matches are actionable; fuzzy matches are display-only.
5. **Desktop only.** `isDesktopOnly: true`. Mobile is out of scope.
6. **Live Preview and Source mode: equivalent semantics.** Every interaction works in both modes; rendering may differ (Live Preview hides syntax), behavior may not.
7. **Privacy exclusions are absolute.** Notes excluded by folder/tag/frontmatter flag are never sent to any backend — not as the review target, not as linked context, not via an explicit wikilink reference.
8. **Vault as configuration.** Every prompt field (persona, panel charter, voice profile) accepts direct text AND/OR ordered vault note references, resolved fresh at run time.
9. **CLI backends are a security boundary.** Spawn without shell, content over stdin, isolated working directory, allowlisted environment (no configurable additions), tools/session persistence off by default, the strongest sandbox flag each tool actually offers (`--sandbox read-only` for Codex; Claude Code has none, and the docs say so rather than implying otherwise), process-tree kill on EVERY run including a clean exit, and on cancel/unload. What the plugin cannot bound — each tool's own user configuration, which is loaded — is stated in the consent dialog rather than omitted. Two separate consents, both revocable: (a) launching the tool at all, (b) tool/research mode — stronger, off by default, and revoking it must not disable the backend. **Consent records WHICH executable it was granted for**, never a bare boolean: `data.json` syncs (rule 12), so a changed, imported or sync-merged executable path invalidates the consent and the user is asked again about the program that is actually there. `enabled` is not consent — an enabled backend without matching consent is refused by backend resolution. Imported settings never carry CLI consent or enablement.
10. **Nothing is renamed to change only casing** (repo files); Conventional Commits enforced; hooks never bypassed.
11. **Editors vs Panels are visually distinguishable** in every surface (rail, menus, cards, side panel).
12. **API keys** live in plugin `data.json` (may sync) — documented prominently; keys and prompts are redacted from logs and error reports.
13. **Durable margin comments never write into the vault, and never restore a position.** They persist to ONE sidecar in the plugin data folder (never next to a note, never in a note's frontmatter, never in `data.json`), storing quote + prefix/suffix/occurrence and no offsets; every comment is RE-ANCHORED against the live text on load through the same matcher findings use. A comment that no longer resolves is kept and shown as orphaned with its quote — never silently deleted, never guessed into a position (rules #3/#4). A vault rename moves its entry, a delete drops it (no path-keyed tombstone: a note later created at that path would inherit a stranger's comments). A store that cannot be read is preserved as a backup copy and reported, never overwritten. A comment persisted as in-flight loads back as `interrupted` and offers Retry — nothing is ever resumed automatically (rule #1). **Resolving** a comment closes it and KEEPS it (so the same question is not re-asked); **deleting** one removes it for good and is only ever reachable through an explicit confirmation — the rule forbids deleting a comment silently, not deleting one at all.

14. **Background comment jobs yield to the foreground, and cancel cleanly.** A background comment run shares the ONE plugin-wide concurrency budget (`behavior.maxConcurrentRequests`) with reviews, transforms and threads, but never queues for it: it takes a permit only while the gate would admit synchronously (nothing queued) and the pool is one short of the cap, so a parked question can never be ordered ahead of a review the user is watching. At a cap of 1 the reserve floors at one permit rather than disabling the feature. Running background work is never preempted — the request is already paid for. Every job is individually cancellable; plugin unload cancels every in-flight job and records it as `interrupted` before the store is flushed (rule #13), and a cancelled job is `interrupted` rather than `failed` because nothing is known about why it ended.
