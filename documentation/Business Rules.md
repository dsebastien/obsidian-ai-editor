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
9. **CLI backends are a security boundary.** Spawn without shell, content over stdin, isolated working directory, allowlisted environment, tools/session persistence off by default, read-only sandbox flags, process-tree kill on cancel/unload. Two separate consents, both revocable: (a) launching the tool at all, (b) tool/research mode — stronger, off by default, and revoking it must not disable the backend. **Consent records WHICH executable it was granted for**, never a bare boolean: `data.json` syncs (rule 12), so a changed, imported or sync-merged executable path invalidates the consent and the user is asked again about the program that is actually there. `enabled` is not consent — an enabled backend without matching consent is refused by backend resolution. Imported settings never carry CLI consent or enablement.
10. **Nothing is renamed to change only casing** (repo files); Conventional Commits enforced; hooks never bypassed.
11. **Editors vs Panels are visually distinguishable** in every surface (rail, menus, cards, side panel).
12. **API keys** live in plugin `data.json` (may sync) — documented prominently; keys and prompts are redacted from logs and error reports.
