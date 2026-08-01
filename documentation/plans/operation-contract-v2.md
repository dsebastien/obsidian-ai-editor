# Operation contract v2 — structured edits

Design record for issues #17 (Accept data loss) and #22 (request/response contract rework). Decisions locked with Sébastien on 2026-08-01. This is a reference document: the shapes, the reasoning, the rejected alternatives, and the measured evidence. The authoritative schemas live in `src/app/domain/operations/contract.ts`; when this document and the code disagree, the code wins.

## The problem being solved

v1's `rawFindingSchema.suggestion` was one free-text string that Accept applied verbatim over the anchored span. Nothing structurally separated "what I am telling you" from "what to write", and replacement was the only expressible operation — so a model that wanted to _add_ something could only approximate it with a replace that silently deleted the quoted line (#17, found in live use: real data loss).

## Locked decisions

### 1. A finding proposes `edits[]`; `suggestion` is deleted

```
edits: [
  {
    op: 'replace' | 'insert-before' | 'insert-after' | 'delete',
    quote?: string,        // verbatim target span; ABSENT → the finding's own span
    prefix?: string, suffix?: string, occurrence?: number,   // same hints as findings
    text?: string          // the content written into the note — required unless op = 'delete'
  }
]
```

- Cap: 10 edits per finding. `text` capped at `SHORT_TEXT_MAX`.
- The explanation lives ONLY in `critique`/`rationale`. No accept path ever writes them.
- `delete` is explicit. `replace`/`insert-*` require non-empty `text` (Zod refinement); a `replace` with empty text is invalid, not a covert delete. `text` present on a `delete` is ignored.
- A finding with zero edits is valid and common: critique-only, display-only.

**Rejected — separate `replacements[]` + `additions[]` arrays** (the #22 sketch): an addition still needs a before/after placement field, so separate arrays don't make invalid states unrepresentable — they split one concept across two lists and force parallel anchoring/precondition/diff/accept machinery through the whole stack. One array also keeps ordering between interleaved edits meaningful, and gives `delete` a vocabulary.

**Rejected — single `suggestion` + one `op` field**: fixes #17's symptoms but forfeits multi-edit proposals, which #22 asked for and which the probe showed even a 4B model can produce correctly.

### 2. Edit targeting: optional own anchor, default = the finding's span

An edit without `quote` applies to the finding's anchored span. An edit with `quote` anchors independently through the same matcher ladder (exact → normalized; ambiguous → not anchored; Business Rules #4 unchanged).

Reasoning: the dominant case is one edit on the finding's own span — making every edit repeat the quote wastes tokens and gives a weak model a second chance to mis-quote. The finding's own `quote` keeps its v1 meaning: the span the observation is _about_ (highlight, card, thread context).

**Rejected — mandatory per-edit quotes**: uniform but pays duplication on ~90% of findings and regresses weak-model reliability.
**Rejected — finding-span-only edits**: "fix here AND add a caveat there" would need two findings; multi-place proposals were an explicit #22 requirement.

### 3. Wire encoding: flat edit object + Zod refinement

One compact schema for every provider; the "text required unless delete" conditional is enforced at the Zod boundary, not in the wire schema (refinements do not serialize). After validation, apply-side code narrows on `op` with the refinement's guarantee.

**Rejected — discriminated union on `op`**: `anyOf` of four near-identical variants quadruples the wire schema, and branchy schemas degrade worst exactly on the local-model path (#22's own constraint). Structured-output support for `anyOf` is the shakiest corner of the provider matrix.

### 4. Accept is all-or-nothing, one transaction

A finding is actionable iff EVERY edit resolves: anchored (own quote or finding span), mutually non-overlapping (touching is fine — CM6 accepts adjacent changes), and each passing `verifyPrecondition` against the live text. Accept dispatches all edits as ONE CM6 transaction — one undo step. Any edit failing → the whole finding is display-only, with the reason on the card.

Bulk accept-all: a finding participates fully or not at all; a finding whose span-set overlaps an earlier planned finding is skipped and counted, as in v1.

**Rejected — per-edit accept**: half-applied proposals can mangle intent (delete-here + insert-there taken by half is #17 again), and every surface would grow per-edit status. The prompt tells models: independently acceptable changes belong in separate findings.

### 5. Strict envelope, per-finding salvage

- The result envelope (kind, findings array, summary) stays strict: malformed envelope is `invalid-output`, as in v1.
- Each finding then validates individually:
    - invalid `edits` (bad op, missing text, over cap) → edits dropped, finding kept **display-only** with a visible "proposal could not be validated" marker;
    - invalid observation core (quote/critique) → finding dropped and **counted in a visible notice** — never silently.

This is the fail-closed mechanism #17 required: an unsafe proposal degrades to critique, never to a wrong write. v1's all-or-nothing result validation would have turned the richer structure into a reliability regression (one bad edit killing a 20-finding review — feeding #18's failure mode).

**Rejected — prose-detection heuristics** on edit text: the structural split is the mechanism (#17 demotes heuristics to fallback explicitly); false positives would silently strip legitimate edits, and the per-op diff preview already shows exactly what would be written before Accept.

### 6. Convergence across kinds

- **Thread turns**: `revisedSuggestion: string` → `revisedEdits?: Edit[]`, re-anchored on arrival against the live text (the same weakness #17 called out; a holding editor can now revise into an insertion).
- **`refine-proposal`: deleted.** It was contract-only — no service, UI or command dispatched it. Dead surface costs prompt rules, schemas and specs forever; a future refine flow speaks edits.
- **`transform-selection` / `insert-at`: unchanged.** The user chose the span/position explicitly; the result is pure content by definition, previewed before apply; no explanation/content ambiguity exists in that apply path. Converging them would let a transform edit outside the selection — a product change, not a contract fix.

### 7. References stay `evidence`

`evidence` (title, url?, claim?, `verification: verified | requires-verification`) IS the references model. Levels: finding-level and transform/insert result-level (both exist). `verification` is kept — it is what stops hallucinated links being presented as consulted sources.

**Rejected — edit-level references**: nesting a weak model will fumble, no accept-path benefit; an edit's justification is its finding's critique + evidence.
**Rejected — response-level reading list / scorecard-level references**: no consumer; speculative.
**Deferred — vault-internal `[[wikilink]]` references** (locally verifiable, openable in place): separable feature, own backlog issue.

### 8. Panel aggregation embeds edits, clipped

Member findings sent to the chairperson carry their edits with per-edit `text` clipped to the aggregation budget (v1 clipped `suggestion` the same way) — top-fix ranking sees what members proposed, not only what they observed.

### 9. Identity: proposals excluded from cross-run identity

- Stream-vs-result dedupe (`rawFindingIdentity`) stays full-content, now serializing `edits` in place of `suggestion`.
- Cross-run identity (issue #19's re-review triage preservation) keys on the OBSERVATION — quote + hints + critique family — never on proposal content, so a re-run that rephrases its edit still matches the user's dismissal. Exact matching/merge rules are #19's to finalize; this document fixes only the principle.

### 10. Versioning

`CONTRACT_VERSION = 2`. No migrations, no compatibility code (no-users policy). Persisted v1 sidecar comment findings load with the unknown `suggestion` key stripped by Zod and degrade to display-only critiques; the comment store's existing unreadable-store safeguards cover everything else.

## Measured evidence (2026-08-01)

Probe: qwen3:4b via Ollama (the small-local-model floor #22 required), 3 documents each engineered for one op (missing intro → insert-before, wordy sentence → replace, duplicated line → delete), 2 runs each, temperature 0.2, v2 flat schema.

- **`format: 'json'` (the weakest structured-output path, and what the Ollama adapter ships today): 6/6** — valid JSON, valid under the v2 Zod schema, the CORRECT op chosen every time, quotes verbatim 6/6, zero explanation prose in any edit `text`.
- **`format: <json schema>` (Ollama server-side enforcement): fails for reasons independent of v2.** llama.cpp's schema→grammar converter errors (`Failed to initialize samplers: failed to parse grammar`) on any string `maxLength` ≥ ~2000 (500 passes); v1's caps (`QUOTE_MAX` 2000, `SHORT_TEXT_MAX` 10000) already trip it. The adapter's `format: 'json'` choice is therefore correct as-is. If Ollama-side schema enforcement is ever wanted, emit a format payload with string length bounds stripped (Zod at the boundary enforces the caps regardless) — noted for #18/#23 error-handling work.

Native OpenAI (`json_schema`) and Anthropic (forced tool input) get the v2 schema server-side via the existing `resultJsonSchema` derivation; the flat edit object avoids the `anyOf` support matrix entirely.

## Consequences for the rest of the system

- `FindingStore`/`TrackedFinding`: per-edit anchors + anchored texts; `isActionable` = every-edit-resolves; accept returns the full edit list; text-change mapping remaps every edit anchor.
- Card/preview: per-op diff rendering (replace → word diff; insert → pure insertion with placement label; delete → struck text). The op is visible BEFORE Accept — a wrong operation is caught by eyes, not by undo.
- Bulk planner: flattens per-finding edit lists under the all-or-nothing rule.
- CLI (`editor-ai-daemons:*`): finding shape replaces `suggestion` with `edits` (op, text, anchor each).
- Prompts: per-kind rules rewritten around edits, including an insertion example; `critique` explicitly "never written into the document".
