---
title: The command line
nav_order: 12
---

# The command line

The plugin registers three subcommands with Obsidian's own CLI, so a review can be driven from a terminal, a script, or an agent.

```bash
obsidian editor-ai-daemons:review --file "Some Note" --format text
obsidian editor-ai-daemons:status --file "Some Note" --format text
obsidian editor-ai-daemons:cancel --file "Some Note"
```

**Desktop only.** The API this uses shipped in Obsidian 1.12.2, below the 1.13.0 floor the plugin itself requires, so any Obsidian that can run the plugin can run these.

Not to be confused with [CLI backends](cli-backends.md), which are the other direction: an AI agent running on your machine _as_ a backend.

## `editor-ai-daemons:review`

_Review a note with the configured AI editors._

| Flag              | Value            | Notes                                                                    |
| ----------------- | ---------------- | ------------------------------------------------------------------------ |
| `--file`          | `<path>`         | **Required.** Vault path, with or without `.md`, or link text            |
| `--editors`       | `<ids-or-names>` | Comma-separated; overrides a matching rule. Default: the note's own pool |
| `--format`        | `json` \| `text` | Default `json`                                                           |
| `--confirm-large` | flag             | Confirm reviewing a note above the size warning threshold                |

It runs through the **exact same pipeline** as the **Review current note** command, so it refuses for the same reasons and honours the same rules, exclusions and size guard. `--editors` is a choice you made, so it wins over a [rule](rules.md) that assigns a reviewer to the note — rules only supply the default. An unknown or disabled name fails the whole call rather than silently reviewing with fewer editors. It waits for the run to settle — including the [panel scorecard](panels.md) when the run is a panel run — and then prints one document.

If the note is **open in a markdown view**, the snapshot comes from the live editor buffer (unsaved edits included), the run is bound to that view, and the findings show up on the rail, in the highlights and in the panel just like a review you started by hand. If the note is not open, the saved file is used and the run is discarded once the output is shaped.

### JSON output

```json
{
    "ok": true,
    "file": "Some Note.md",
    "findings": [
        {
            "id": "…",
            "editor": "Concision Editor",
            "severity": "suggestion",
            "quote": "in order to",
            "critique": "…",
            "edits": [
                {
                    "op": "replace",
                    "text": "to",
                    "anchor": { "from": 412, "to": 423, "state": "anchored" }
                }
            ],
            "anchor": { "from": 412, "to": 423, "state": "anchored" }
        }
    ],
    "skips": [{ "editor": "Fact Checker", "reason": "no model configured" }],
    "summaryByEditor": { "Concision Editor": "…" },
    "panel": null,
    "error": null
}
```

`anchor` is `null` when the quote could not be located in the note. `panel` carries the scorecard — verdict, rationale, per-member verdicts, ranked top fixes with the quote they point at, dissent, and the members that produced nothing — on a panel run, and is `null` otherwise.

### Text output

One line per finding:

```
[suggestion] Concision Editor 412-423: "in order to" — Three words doing one word's work -> [replace] to
Skipped Fact Checker: no model configured
```

An unanchored finding prints `unanchored` where the offsets would be; a stale one prints `412-423 (stale)`. `No findings.` when there are none. A panel run appends its verdict, one line per member, the ranked fixes and each disagreement.

### Error codes

Errors are typed so a script can branch on them, and the messages are status-only — nothing model- or backend-derived is echoed.

| Code                 | Meaning                                                                   |
| -------------------- | ------------------------------------------------------------------------- |
| `bad-args`           | A flag is missing or unparseable — distinct from the note not existing    |
| `file-not-found`     | No markdown note at that path                                             |
| `excluded`           | The note is [privacy-excluded](privacy-and-security.md)                   |
| `rule-disabled`      | A [binding rule](rules.md) switched the plugin off for it; names the rule |
| `needs-confirmation` | Above the size threshold; re-run with `--confirm-large`                   |
| `no-editors`         | Nothing could run; `skips` says why for each                              |
| `panel-unavailable`  | The assigned panel cannot run                                             |
| `backend-error`      | The run failed                                                            |
| `timeout`            | The run timed out                                                         |

## `editor-ai-daemons:status`

_Show the state of the AI review run for a note._ Read-only: it starts nothing and spends nothing.

| Flag       | Value            | Notes          |
| ---------- | ---------------- | -------------- |
| `--file`   | `<path>`         | **Required**   |
| `--format` | `json` \| `text` | Default `json` |

Text output is a headline plus the same finding lines as `review`:

```
Run in progress (2 running, 1 done) — 4 findings so far
```

or `Run settled (3 done) — 7 findings`, or `No run for Some Note.md.` when nothing is tracked. The JSON document carries `run.settled`, one entry per editor with its status and (redacted) error, the findings in the same shape as `review`, and the per-editor summaries.

## `editor-ai-daemons:cancel`

_Cancel the in-flight AI review of a note._

| Flag     | Value    | Notes        |
| -------- | -------- | ------------ |
| `--file` | `<path>` | **Required** |

JSON only. `{"ok":true,"file":"…","cancelled":true}` when something was cancelled, or `cancelled: false` with a reason of `no-run` or `already-settled`. Both of those are successes: asking to cancel nothing is not an error.

## Scripting notes

- Every subcommand **always answers with parseable output**, including on failure. Nothing throws through the CLI surface.
- `--format text` is for humans and greps; `--format json` is for programs. The finding line format is identical between `review` and `status`.
- A CLI review of an **open** note behaves as a real review of that note: cancel it with `editor-ai-daemons:cancel`, or from the rail.
- Batch use: prefer notes that are **not** open. Runs on open notes stay in memory so their highlights keep working.

## Next

- [Review a note](usage.md)
- [CLI backends](cli-backends.md)
- [Troubleshooting](troubleshooting.md)
