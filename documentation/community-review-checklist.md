# Community review checklist

Swept 2026-07-30 against Obsidian's [plugin guidelines](https://docs.obsidian.md/Plugins/Releasing/Plugin+guidelines) (fetched, not recalled), the `eslint-plugin-obsidianmd` **0.1.9** `recommended` rule set (the reviewer's own lint), and the live community catalog.

Every verdict below carries the command that produced it. Re-run them before submitting: the catalog changes, and so does the rule set.

**Updated 2026-07-31**: the § 0 naming blocker is resolved — the plugin is now `editor-ai-daemons` / "AI Editor", re-verified free against the live catalog. Nothing else in the sweep changed.

**Re-verified 2026-08-02** after ~20 commits (contract v2, carryover, retry/quota, rail collapse/fade, hide findings, acknowledgements, selectable text). Every command in this document re-run:

- Catalog (now **6 268** entries): `editor-ai-daemons` id and name still free, still zero "daemon" entries, `ai-editor` still held by `buszk/obsidian-ai-editor`. `desktop-releases.json` `latestVersion` still `1.13.4` ≥ `minAppVersion` 1.8.7.
- New-API check re-run: none of the >1.8.7 APIs used (the session's additions use only `registerDomEvent`, plain DOM and `navigator.clipboard` — not Obsidian APIs).
- HTML sinks: still zero call sites (4 comment mentions). `!important`: still comment-only. `.obsidian` hardcodes: none. Placeholder commands: none.
- Bundle: `dist/main.js` 741 KB, `dist/styles.css` 55 KB; the one `console.warn` is still zod's (§ 7).
- **One regression caught and fixed**: `.ai-editor-settings-textarea` (plus the unstyled `ai-editor-settings-panel` DOM id and `ai-editor-settings-content` class) had survived the § 0 rename with the RETIRED prefix — the § 11 selector check failed on the shipped stylesheet. All three renamed to `editor-ai-daemons-*`; the selector check is clean again (only the `.modal` compound). The export format marker `ai-editor-settings` and default export filename stay, per the § 0 rename table.
- Gates: format + validate (tsc, eslint `--max-warnings 0`, **2 472** specs) + build all green.

**Lint currency (2026-08-02, later):** `eslint-plugin-obsidianmd` upgraded **0.1.9 → 0.4.1** (the reviewer's own lint moved; the checklist's step 5 exists for exactly this). The new preset surfaced 20 errors + 134 warnings, resolved as:

- **Fixed in code**: two cross-window-unsafe `instanceof HTMLInputElement` checks in the finding card became Obsidian's `.instanceOf` (a REAL popout bug class — a popout's constructor identities differ); perf benchmarks now report via `process.stdout.write` (0.4.1 forbids disabling `no-console` even described); three `require-yield` disables gained the required descriptions; the two sentence-case inline disables became config vocabulary (`AI Editor Review` in `brands` — 0.4.1 forbids inline sentence-case disables).
- ~~**Config-scoped with documented reasons**~~ — **SUPERSEDED 2026-08-04.** Five `obsidianmd/*` rules were switched off in `eslint.config.ts` with written rationales. The 0.4.0 catalog review reported every one of them anyway: the reviewer runs **its own** ruleset against the source archive, so a local disable never suppressed anything on their side — it only hid the finding from us until submission. All five are now fixed in code and BR #20 forbids the pattern outright.

**Catalog review of 0.4.0 (2026-08-04)** — first machine review of a submitted release; entry still in draft. Reported 2 errors + ~230 warnings + a failed build. Resolved as:

- **BUILD VERIFICATION (the actual failure)**: `.gitattributes` carried `CHANGELOG.md export-ignore`, and `src/app/whats-new.ts` imports it (`with { type: 'text' }`). The reviewer builds the **git archive**, where `export-ignore` strips the file — so the build failed there and passed everywhere else. `CHANGELOG.md` and `eslint.config.ts` are no longer export-ignored, and `.gitattributes` now carries the rule: never export-ignore a file the build or the lint reads. Verified by building an actual `git archive --worktree-attributes` extract in a clean `bun install`.
- **`no-unsupported-api` (Error)**: cleared by raising `minAppVersion` 1.8.7 → **1.12.2**, the release that shipped `registerCliHandler`. Latest public is 1.13.4, so the floor is well inside public territory. This also cleared the five CSS `text-decoration` partial-support warnings, which were gated on 1.7.4.
- **`prefer-create-el` (92)**: `doc.createElement(x)` → `doc.win.createDiv()` / `createSpan()` / `createEl(x)`. The rule's own suggested spelling does not compile against Obsidian's typings — `createEl` is declared as a bare ambient function and `win: Window` separately on `Node`, never joined. `src/obsidian-window.d.ts` joins them. Detachment, ownership and popout correctness are all unchanged; the stub documents in `rail.spec.ts` grew a matching `win`.
- **`prefer-window-timers` (40) / `no-global-this` (13)**: two new single-purpose modules, `src/utils/timers.ts` and `src/app/services/backends/resolve-fetch.ts`. Production resolves off the window; headless specs fall back to `node:timers` (an import, not a global) or inject. `resolve-fetch` prefers `activeWindow`; `timers` deliberately does not, because the timer rule reports `activeWindow` just as loudly. Resolution is LAZY — every service resolves its transport at the top of a function whose next act may be a refusal, and those paths must not require a transport to exist.
- **`@typescript-eslint/no-unsafe-*` (~80 on their side, 10 locally)**: the gap was `typeof fetch`, which resolves through whatever ambient types are installed. Replaced with a narrow `FetchFn`; `log.spec.ts` names `{ mockRestore }` instead of `ReturnType<typeof spyOn>`.
- **CSS `:has` (5)**: three selectors became state classes the rail already knew the answer for (`-split`, `-hover`), set by `syncSelectionSegment` and `syncRetry`. Note what `:has()` gave for free and the class does not: a retry removed mid-hover never fires `mouseleave`, so the hover class is cleared explicitly on removal. Covered by four new specs.
- **Dependencies**: `brace-expansion` 2.0.3 → 2.1.4 and `js-yaml` 4.2.0 → 4.3.1 in the existing `overrides` block. Both transitive devDependencies; neither ships in `main.js`.
- **`settings-tab/prefer-setting-definitions` (1) — NOT fixed, tracked as issue #35.** `display()` is **not called at all** when `getSettingDefinitions()` returns a non-empty array (`obsidian.d.ts`, `SettingTab.display`), so there is no partial adoption: a handful of declarative rows would REPLACE the whole 7-tab, ~3000-line settings UI. That is a deliberate port with live verification, not a lint fix. The rule stays enabled and keeps reporting (BR #20); `bun run lint` runs `--max-warnings 1` to admit exactly this one. **If that count ever needs raising, the answer is to fix the new warning, not the number.**
- **Not defects**: "Dynamic Code Execution" is Zod v4's `new Function("")` CSP capability probe — there is no `eval` or `new Function` in this codebase, and none in `dist/main.js` beyond that probe. "Direct Filesystem Access" and "Shell Execution" are what a CLI backend IS (BR #9); "Vault Enumeration" and "Clipboard" are Recommendations, and the clipboard use is write-only.
- **Typings**: `obsidian` devDep 1.12.3 → **1.13.1**. 1.13 was Catalyst-only in May but 1.13.4 (2026-07-30) is public, so this respects the "latest public release" rule. It immediately caught one real thing: `Plugin.settings` exists on the 1.13 base, so the plugin's narrowed field now needs `override`.

| Verdict         | Meaning                                                              |
| --------------- | -------------------------------------------------------------------- |
| **PASS**        | Verified compliant.                                                  |
| **PASS (note)** | Compliant, with a deviation that is deliberate and justified inline. |
| **DECIDE**      | Needs Sébastien. Cannot be fixed by an agent.                        |

---

## 0. Blocker first

### The catalog name collision — **RESOLVED 2026-07-31**

**The blocker was**: `id` `ai-editor` and `name` "AI Editor" are both already published in the community catalog by another author (`buszk/obsidian-ai-editor`). A duplicate `id` is refused outright; a duplicate display name is refused or challenged by the reviewer. The catalog also pins the slug from the **first** submission, and the `id` is locked forever once accepted — so this had to be settled before the first submission, not after.

**Sébastien's decision (2026-07-31)**: rename the plugin to `editor-ai-daemons` / "AI Editor". Nothing had shipped (`manifest.json` still says `0.0.0`), so the `id` moved at zero user cost. Two facts were checked first: `editor-ai-daemons` is free in the catalog, and no recent plugin uses an `obsidian-` `id` prefix, so dropping the prefix costs nothing in discoverability.

**The GitHub repository name does NOT change.** It stays `dsebastien/obsidian-ai-editor`. Only the plugin's identity moved; every repo URL (README, funding, support links, `docs/_config.yml` `baseurl`, issue links, the OpenRouter `http-referer` attribution header) is untouched. The catalog gates the manifest `id`, not the repo name.

Availability re-verified on 2026-07-31, against the live catalog (6 210 entries):

```bash
curl -s -o /tmp/cp.json https://raw.githubusercontent.com/obsidianmd/obsidian-releases/master/community-plugins.json
jq 'length' /tmp/cp.json                                                    # 6210
jq -r '.[] | select(.id=="editor-ai-daemons")' /tmp/cp.json                 # (empty — id free)
jq -r '.[] | select(.name|ascii_downcase=="editor ai daemons")' /tmp/cp.json # (empty — name free)
jq -r '.[] | select(.id|test("daemon"))         | .id' /tmp/cp.json         # (empty)
jq -r '.[] | select(.name|ascii_downcase|test("daemon")) | .name' /tmp/cp.json # (empty)
jq -r '.[] | select(.id=="ai-editor") | "\(.id) — \(.name) — \(.repo)"' /tmp/cp.json
# ai-editor — AI Editor — buszk/obsidian-ai-editor   (the entry that forced the rename)
```

No catalog entry has "daemon" anywhere in its `id` or `name` — the new identity collides with nothing, not even partially.

The rename landed in three commits and touched:

| Surface                   | From                                       | To                                                 |
| ------------------------- | ------------------------------------------ | -------------------------------------------------- |
| `manifest.json` `id`      | `ai-editor`                                | `editor-ai-daemons`                                |
| `manifest.json` `name`    | AI Editor                                  | AI Editor                                          |
| `package.json` `name`     | `ai-editor`                                | `editor-ai-daemons`                                |
| CSS class prefix          | `ai-editor-*`                              | `editor-ai-daemons-*`                              |
| CLI subcommands           | `ai-editor:review` / `:cancel` / `:status` | `editor-ai-daemons:review` / `:cancel` / `:status` |
| Review panel view type    | `ai-editor-review`                         | `editor-ai-daemons-review`                         |
| Context-menu section id   | `ai-editor`                                | `editor-ai-daemons`                                |
| Settings export marker    | `ai-editor-settings`                       | `ai-editor-settings`                               |
| Frontmatter opt-out key   | `ai_editor: false`                         | `ai_editor: false`                                 |
| Plugin folder             | `.obsidian/plugins/ai-editor/`             | `.obsidian/plugins/editor-ai-daemons/`             |
| User-visible notices/copy | "AI Editor: …"                             | "AI Editor: …"                                     |

`description`, `author`, `authorUrl`, `fundingUrl`, `isDesktopOnly` and `minAppVersion` were deliberately left alone; the description carries no "Obsidian" and still passes the catalog rules (§ 1). Command ids were checked and needed nothing — none of them embeds the plugin id, because Obsidian namespaces them at registration.

Verified after the rename: `dist/styles.css` contains **zero** `ai-editor` occurrences, with 327 rule bodies and 219 unique class selectors — both identical to the pre-rename build, and the selector set matches exactly once the prefix is normalised. Gates green: `bun run format`, `bun run validate` (tsc + eslint `--max-warnings 0` + 2 258 specs), `bun run build`.

Nothing else in this document is a blocker.

### Display name kept as "AI Editor" — **DECIDED 2026-07-31 (Sébastien)**

The `id` moved (it must be unique; `ai-editor` is owned by `buszk/obsidian-ai-editor`).
The DISPLAY NAME did not: the manifest `name` is back to `"AI Editor"`, which is what the
community-plugin browser and the installed-plugin list show.

No guideline is broken — only `id` uniqueness is enforced; `name` rules are "no Obsidian",
"not all-uppercase", "description does not start with it", all PASS. The known consequence,
accepted deliberately: `buszk/obsidian-ai-editor` publishes under the same display name, so
the browser will list two entries called "AI Editor" (different authors, different ids). A
reviewer may comment on it; the answer is that the ids are distinct and the name is not
reserved.

```bash
jq -r '.[] | select(.name|test("^AI Editor$";"i")) | "\(.id) | \(.name) | \(.repo)"' community-plugins.json
# ai-editor | AI Editor | buszk/obsidian-ai-editor   <- the only other holder
```

---

## 1. Manifest, naming and versions

| Item                                          | Verdict         | Evidence                                                                                                                                                   |
| --------------------------------------------- | --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id` free of the word "obsidian"              | **PASS**        | `"id": "editor-ai-daemons"`.                                                                                                                               |
| `id` uniqueness                               | **PASS**        | Renamed 2026-07-31. Re-verified against the live catalog — see § 0.                                                                                        |
| `name` free of "Obsidian"                     | **PASS**        | `"name": "AI Editor"`.                                                                                                                                     |
| `name` not all-uppercase                      | **PASS**        | "Editor" is lowercase past the initial. Acronym-chain check does not fire on the single "AI".                                                              |
| `description` free of "Obsidian"              | **PASS**        | "Review, edit, and draft notes collaboratively with configurable AI editors and panels."                                                                   |
| `description` does not start with the name    | **PASS**        | Starts on "Review".                                                                                                                                        |
| `description` ends with `.`/`!`/`?`           | **PASS**        | Ends with `.`.                                                                                                                                             |
| Manifest ↔ `package.json` consistency         | **PASS**        | `package.json` `name` = `id` = `editor-ai-daemons`; manifest `name` is the display name "AI Editor"; `version` both `0.0.0`; `description` byte-identical. |
| Required manifest fields present              | **PASS**        | `id`, `name`, `version`, `minAppVersion`, `description`, `isDesktopOnly`, plus `author`, `authorUrl`, `fundingUrl`.                                        |
| `obsidianmd/validate-manifest`                | **PASS**        | `bun run lint` → 0 problems.                                                                                                                               |
| `minAppVersion` ≤ latest public release       | **PASS**        | `1.12.2` vs latest public `1.13.4` (2026-07-30). Not a Catalyst-only version.                                                                              |
| `minAppVersion` high enough for the APIs used | **PASS**        | See below.                                                                                                                                                 |
| `isDesktopOnly` correct                       | **PASS**        | `true`. The CLI backends spawn child processes through `node:child_process`; Business Rules #5 locks desktop-only as a product rule.                       |
| `versions.json`                               | **PASS (note)** | `{}` — correct for a plugin that has never released. See below.                                                                                            |

### `minAppVersion` is accurate

Method: extract every `@since` in the pinned `obsidian` typings, keep those newer than `1.8.7`, and check each against usage.

```bash
grep -rn "@since" node_modules/obsidian/obsidian.d.ts   # then filter > 1.8.7
```

Everything newer than the floor falls into six groups — Bases (`1.10.x`), `SecretStorage`/`SecretComponent` (`1.11.x`), `SettingGroup`/`Setting.addComponent` (`1.11.0`), `Modal.setCloseCallback` (`1.10.0`), `App.isDarkMode` (`1.10.0`), `Vault.appendBinary` (`1.12.3`), and the CLI handler API (`1.12.2`).

```bash
grep -rn "SettingGroup\|SecretComponent\|secretStorage\|appendBinary\|setCloseCallback\|isDarkMode\|registerBasesView\|addComponent(" src/ | grep -v spec
# (no matches)
```

Only `registerCliHandler` is used. It stayed runtime-guarded (`src/app/plugin.ts`):

```ts
if (Platform.isDesktop && requireApiVersion('1.12.2')) { … }
```

**Raised 1.8.7 → 1.12.2 on 2026-08-04.** The guard was correct but `obsidianmd/no-unsupported-api` is static, so the 0.4.0 catalog review reported it as an **Error** — the one blocking lint finding. The floor now matches the release that shipped the API. It is a real cost (installs below 1.12.2 lose the plugin) paid because the entry is still in draft with 8 downloads, and 1.12.2 is nearly a year inside public territory. The guard stays: it costs nothing and keeps the failure mode a missing command rather than a crash.

Raising the floor also silenced five CSS `text-decoration` "partially supported by Obsidian 1.7.4" warnings for free.

The `obsidian` dev dependency is pinned to `1.13.1` — the newest typings on npm, and public since 1.13.4 (2026-07-30). Never `latest`, never a Catalyst build.

### `versions.json` is empty on purpose

`{}` is correct while `manifest.json` says `0.0.0`: the file maps _released_ plugin versions to their minimum app version, and there are none. `scripts/version-bump.ts` writes the first entry during the release `prepare` job:

```ts
if (!Object.values(versions).includes(minAppVersion)) {
    versions[targetVersion] = minAppVersion
}
```

**Verify after the first `prepare` run** that `versions.json` contains `"<version>": "1.8.7"` before the tag is pushed.

---

## 2. DOM safety

| Item                                                   | Verdict  | Evidence                                                                                             |
| ------------------------------------------------------ | -------- | ---------------------------------------------------------------------------------------------------- |
| No `innerHTML` / `outerHTML` / `insertAdjacentHTML`    | **PASS** | See below.                                                                                           |
| No `document.createElement`                            | **PASS** | `grep -rn "document.createElement\|createElementNS" src/` → no matches.                              |
| DOM built with `createEl` / `createDiv` / `createSpan` | **PASS** | Every UI module builds through the Obsidian helpers or the owning view's `Document`.                 |
| No forbidden elements                                  | **PASS** | `obsidianmd/no-forbidden-elements` clean.                                                            |
| `setHeading` rather than `<h1>`/`<h2>`                 | **PASS** | `obsidianmd/settings-tab/no-manual-html-headings` clean; 12 `new Setting(…).setHeading()` sites.     |
| No "settings" in settings headings                     | **PASS** | `obsidianmd/settings-tab/no-problematic-settings-headings` clean.                                    |
| No global `app` instance                               | **PASS** | Every `app.` reference destructures from `this.deps`, `plugin`, or a parameter — never `window.app`. |

Proof for the HTML sinks:

```bash
grep -rn "innerHTML\|outerHTML\|insertAdjacentHTML" src/
```

Five matches, **all inside comments** asserting the constraint:

| File                                 | Line |
| ------------------------------------ | ---- |
| `src/app/settings/components.ts`     | 10   |
| `src/app/ui/editor/rail.ts`          | 166  |
| `src/app/ui/editor/rail-model.ts`    | 186  |
| `src/app/ui/editor/margin-column.ts` | 17   |
| `src/app/ui/side-panel.ts`           | 33   |

Zero call sites. The rail, the margin column and the transform preview are deliberately Obsidian-free DOM (no `setIcon`), so their glyphs are text nodes rather than injected markup.

---

## 3. Paths and file access

| Item                                                   | Verdict         | Evidence                                                                                                                             |
| ------------------------------------------------------ | --------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| No hardcoded `.obsidian`                               | **PASS**        | `grep -rn "\.obsidian" src/` → 3 matches, all comments explaining why it is _not_ hardcoded.                                         |
| `obsidianmd/hardcoded-config-path`                     | **PASS**        | Clean.                                                                                                                               |
| Plugin data folder resolved correctly                  | **PASS**        | `pluginDataDir` (`src/app/ui/comment-store.ts:55`) uses `manifest.dir`, falling back to `${vault.configDir}/plugins/${manifest.id}`. |
| `normalizePath()` on user-supplied paths               | **PASS**        | `normalizePath` on the comment store path, on CLI `--file` resolution, and on export paths.                                          |
| No absolute paths outside their purpose                | **PASS (note)** | Four `/usr/…` literals, all in CLI-tool detection. See below.                                                                        |
| No writes outside the plugin folder                    | **PASS (note)** | One user-initiated export. See below.                                                                                                |
| Adapter API used only where the Vault API cannot reach | **PASS (note)** | See below.                                                                                                                           |
| `Vault.getFileByPath` rather than iteration            | **PASS**        | `obsidianmd/vault/iterate` clean.                                                                                                    |
| No `TFile`/`TFolder` casts                             | **PASS**        | `obsidianmd/no-tfile-tfolder-cast` clean; `instanceof` used at `transfer-modals.ts:169/173`.                                         |
| `FileManager.trashFile` preference                     | **PASS**        | `obsidianmd/prefer-file-manager-trash-file` clean — the plugin never deletes a vault file.                                           |

**The `/usr/…` literals** (`src/app/services/backends/cli/detect.ts:48-58`, plus one settings placeholder) are candidate install locations for `claude` and `codex` on POSIX. Detection only _probes_ them; `cli-backend-modal.ts:210` says so in the button tooltip ("Look in common install locations. Nothing is run."), and the resulting path is still subject to `validateExecutablePath`.

**The one write outside the plugin folder** is `Export settings` (`src/app/settings/transfer-modals.ts:181/187`), which writes a JSON file to a vault path the user typed. It is explicitly user-initiated, path traversal is refused rather than normalised away (`transfer-model.ts:47`), and overwriting an existing file goes through a confirmation modal.

**The Adapter API** (`vault.adapter.read/write/exists/rename/remove`, `src/app/ui/comment-store.ts:22-48`) is used for exactly one file: the durable margin-comment sidecar in the plugin's own data folder. The Vault API only addresses vault-visible files and cannot reach inside `<configDir>/plugins/<id>/`, which is the documented exception to "prefer the Vault API". Every other file operation in the plugin goes through the Vault API.

---

## 4. Sentence case in UI text

**Verdict: PASS.** `obsidianmd/ui/sentence-case` is now enforced as an **error** and the codebase is clean:

```bash
bun run lint    # eslint . --max-warnings 0 → 0 problems
```

This was the sweep's largest finding. The rule ships **in the `recommended` config as `["error", { enforceCamelCaseLower: true }]`** — i.e. the reviewer runs it — and this repo had it switched off wholesale with the comment "it has false positives for already-correct text". Turning it back on reported **34 strings**.

Four of the 34 were genuinely wrong and are now fixed (commit `7b76f22`):

| Was                                                         | Now                                               | Why                                                                                  |
| ----------------------------------------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `Imported entities are ADDED to …`                          | `… are added to …`                                | All caps for emphasis; the only place in the plugin that shouts.                     |
| `(Obsidian Sync, iCloud, git…)`                             | `(Obsidian Sync, iCloud, Git…)`                   | Proper noun, in a list of two other proper nouns.                                    |
| `How hard reasoning models think. 'Default' sends nothing.` | `… The 'Default' option sends nothing.`           | A sentence opening on a quoted option label reads as a typo whichever case it takes. |
| `“Disable plugin” is a kill switch: …`                      | `The “Disable plugin” action is a kill switch: …` | Same shape, same fix.                                                                |

The other 30 were the rule not knowing this plugin's vocabulary. Rather than mangling correct copy ("AI editor", "Azure openai", "Join knowii") or blanket-disabling the rule again, the vocabulary is **declared** in `eslint.config.ts`. Each entry:

| Option        | Entries                                                                                                                                                                                                    | Why                                                                                                                                                                                                                                                       |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `brands`      | `Obsidian`, `Obsidian Sync`, `Obsidian Publish`, `iCloud`, `iOS`, `macOS`, `Windows`, `Linux`, `Android`, `GitHub`, `GitHub Sponsors`, `Git`, `YouTube`, `Markdown`, `JavaScript`, `TypeScript`, `Node.js` | The plugin's default brand list is **replaced**, not merged (`options?.brands ?? DEFAULT_BRANDS`), so everything relied on must be restated.                                                                                                              |
| `brands`      | `AI Editor`, `Anthropic`, `Azure OpenAI`, `Claude`, `Claude Code`, `Codex`, `Knowii`, `LM Studio`, `Ollama`, `OpenAI`, `OpenRouter`                                                                        | Product names this plugin's copy uses. A new brand is reported until it is added — loud, which is the point.                                                                                                                                              |
| `ignoreWords` | `Actions`, `Backends`, `Default`, `Disable`, `Editors`, `Inject`, `None`, `Test`                                                                                                                           | Literal UI labels quoted inside prose ("Select **Test connection** again", "leaving it on **None**"). Lowercasing them would name a control that does not exist.                                                                                          |
| `ignoreWords` | `api-version`                                                                                                                                                                                              | Azure's literal query-parameter name. The rule would render it `API-version`, which Azure rejects.                                                                                                                                                        |
| `ignoreWords` | `Enter`, `Esc`                                                                                                                                                                                             | Key names ("Enter to accept · Esc to reject").                                                                                                                                                                                                            |
| `ignoreWords` | `PATH`                                                                                                                                                                                                     | The environment variable, named in the CLI-backend security copy.                                                                                                                                                                                         |
| `ignoreRegex` | `^e\.g\. `                                                                                                                                                                                                 | Input placeholders are sentence fragments; the rule would capitalise them into "E.g.".                                                                                                                                                                    |
| `ignoreRegex` | `ai_editor`                                                                                                                                                                                                | Frontmatter key. The rule reads `ai` as the AI acronym and proposes `AI_editor`.                                                                                                                                                                          |
| `ignoreRegex` | `Personal Knowledge Management`                                                                                                                                                                            | The newsletter line in `support-links.ts` / `whats-new-view.ts`, which are kept **byte-identical** with `obsidian-plugin-template` across all 22 repos. Excluded in config so the source files do not have to carry a disable comment the template lacks. |

`ignoreWords` is only consulted for tokens **after** the first in a sentence, which is why the two label-opening strings were reworded rather than added to the list.

Beyond the linted call sites, commands, tab labels and modal titles were swept by hand:

```bash
grep -rn "id: '\|name: '" src/app/commands/ | grep -v spec
```

16 static commands (`Review current note`, `Review selection`, `Ask a question`, `Ask for comments`, `Preview what will be sent`, `Open review panel`, `Cancel review or action`, `Next finding`, `Previous finding`, `Accept current finding`, `Dismiss current finding`, `Cycle severity filter`, `Accept all non-conflicting findings`, `Generate more findings from every finished editor`, `Toggle the margin comment column`, `Run setup wizard`) plus the dynamic `Accept all from <editor>` / `Dismiss all from <editor>` / action-binding commands — all sentence case. Settings tabs: `Backends`, `Editors`, `Panels`, `Actions`, `Voice & style`, `Rules`, `Behavior`.

---

## 5. Commands

| Item                                      | Verdict  | Evidence                                                                                                                                                        |
| ----------------------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No default hotkeys                        | **PASS** | `obsidianmd/commands/no-default-hotkeys` clean; no `hotkeys:` key on any `addCommand` call.                                                                     |
| Plugin name not repeated in command names | **PASS** | `obsidianmd/commands/no-plugin-name-in-command-name` clean — Obsidian already prefixes with the plugin name.                                                    |
| Plugin id not repeated in command ids     | **PASS** | `obsidianmd/commands/no-plugin-id-in-command-id` clean.                                                                                                         |
| No "command" in ids or names              | **PASS** | Both `no-command-in-command-id` and `no-command-in-command-name` clean.                                                                                         |
| Correct callback type                     | **PASS** | See below.                                                                                                                                                      |
| No non-functional commands                | **PASS** | See below.                                                                                                                                                      |
| Stable ids across renames                 | **PASS** | Dynamic commands key on the entity UUID (`action-commands.ts:15`, `bulk-commands.ts:15`), so renaming an editor re-registers in place and user hotkeys survive. |

**Callback types.** Every command that depends on context uses `checkCallback` or `editorCheckCallback` and returns `false` when unavailable, so it is _hidden_ from the palette rather than shown dead — `src/app/commands/command-gates.ts` is the one place that decides. Only `Open review panel` and `Run setup wizard` use a plain `callback`, and both are unconditionally available.

**Non-functional commands.** The 2026-07-29 review recorded `review-current-note` as a placeholder that "must not reach a submitted release" (plan § "Original findings", item 7). It is now wired to the full run pipeline and gated on `reviewGate`; there is no remaining "not connected to a backend yet" Notice anywhere:

```bash
grep -rn "not connected to a backend" src/    # (no matches)
```

---

## 6. Resource cleanup

**Verdict: PASS.** Every listener, timer, observer and child process is released. Full enumeration:

| Resource                                                                   | Registered                                                                            | Released                                                                                                   |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `workspace.on('layout-change' \| 'active-leaf-change' \| 'file-open')`     | `review-controller.ts:491-508` via `plugin.registerEvent`                             | Obsidian, on unload                                                                                        |
| `vault.on('rename' \| 'delete')` (findings)                                | `review-controller.ts:509-533` via `plugin.registerEvent`                             | Obsidian, on unload                                                                                        |
| `vault.on('rename' \| 'delete')` (comment store)                           | `comment-store.ts:115/130` via `plugin.registerEvent`                                 | Obsidian, on unload                                                                                        |
| `workspace.on('editor-menu')`, `on('file-menu')`                           | `editor-menu.ts:26`, `file-menu.ts:18` via `registerEvent`                            | Obsidian, on unload                                                                                        |
| Settings-mutation subscriptions (daemon, action commands, bulk commands)   | `plugin.ts:149`, `action-commands.ts:98`, `bulk-commands.ts:91` via `plugin.register` | Obsidian, on unload                                                                                        |
| `registerView` (review panel, what's new)                                  | `plugin.ts:247`, `whats-new.ts:40`                                                    | Obsidian, on unload; `whats-new.ts` registers a flag-only teardown that detaches nothing (see § below)     |
| CM6 editor extensions                                                      | `plugin.ts:125` via `registerEditorExtension`                                         | Obsidian, on unload                                                                                        |
| `registerCliHandler` × 3                                                   | `plugin.ts:196-209`                                                                   | Obsidian (no public unregister; each registration is individually try/caught against the double-load race) |
| Status bar item                                                            | `plugin.ts:94` via `addStatusBarItem`                                                 | Obsidian, on unload                                                                                        |
| Per-view `ResizeObserver`                                                  | `review-controller.ts:2992`, constructed from the view's own window                   | `destroyGlue` → `glue.paneObserver?.disconnect()` (`:3032`)                                                |
| Capture-phase `scroll` listener on `view.contentEl`                        | `review-controller.ts:2978`                                                           | `removeEventListener` at `:2980`, stored on the glue and called on destroy                                 |
| Card `document` `mousedown`/`keydown`, `scrollDOM` scroll, window `resize` | `finding-card.ts:551-558`, on the card's OWN document/window                          | `finding-card.ts:590-593` in the CM6 view plugin's `destroy()`                                             |
| `requestAnimationFrame` (card scroll arming)                               | `finding-card.ts:578`                                                                 | `cancelAnimationFrame` at `:571` and `:595`                                                                |
| Refresh / emphasis / reveal `window.setTimeout`                            | `review-controller.ts:1714/2792/3877`                                                 | `window.clearTimeout` at `:604`, `:608`, `:1728`; `dispose()` drains the map                               |
| Daemon per-file `window.setTimeout`                                        | `daemon-controller.ts:140`                                                            | `window.clearTimeout` at `:119`/`:153`; `dispose()` from `onunload`                                        |
| Comment-store debounce `window.setTimeout`                                 | `plugin.ts:432` / `comment-store.ts:69`                                               | `clearTimer`; `flush()` from `onunload` cancels and writes now                                             |
| Background-gate retry `window.setTimeout`                                  | `plugin.ts:432`                                                                       | `backgroundGate.dispose()` first thing in `onunload`                                                       |
| Comment-job elapsed-timer `window.setInterval`                             | `plugin.ts:441`                                                                       | `commentJobs.dispose()` in `onunload`                                                                      |
| In-flight HTTP requests                                                    | `AbortController` per run                                                             | `runController.cancelAll()` + `transformController.cancelAll()` in `onunload`                              |
| **Child processes (CLI backends)**                                         | `spawn.ts`                                                                            | See below                                                                                                  |

Timers use `window.setTimeout` / `window.setInterval` and are typed as plain `number`, per AGENTS.md.

**Child processes** are the sharpest case, and the rule is stronger than "kill on cancel": `spawn.ts:415-437` probes and kills the whole process tree on **every** exit path including a clean `exit 0`, because a tool that starts an MCP server or a watcher and then exits successfully leaves those children holding the note text that went in on stdin. `killProcessTree` escalates POSIX signals (and uses `taskkill` on Windows). The unload chain is `onunload` → `runController.cancelAll()` → per-run `AbortController.abort()` → `spawn.ts`'s abort listener → `settle()` → tree kill.

`obsidianmd/detach-leaves` is clean, and so is the unload path the rule cannot see. The rule only inspects a literal `onunload` body, so a teardown registered through `plugin.register` is invisible to it — this plugin used to detach the "What's new" leaves there, against the guideline ("Don't detach leaves in onunload": an update reinitialises open leaves at their original position, so detaching loses the user's tab placement on every update). The call is gone; the registered teardown only flips the `unloaded` flag that guards the async open path.
`obsidianmd/no-view-references-in-plugin` is clean: the plugin holds controllers, never a view instance.

---

## 7. Logging, network and privacy

| Item                                        | Verdict         | Evidence                                                                                                                                     |
| ------------------------------------------- | --------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| No `console.*` in plugin code               | **PASS**        | See below.                                                                                                                                   |
| One `console.warn` in the bundle            | **PASS (note)** | From `zod`, not from plugin code. See below.                                                                                                 |
| No network calls beyond configured backends | **PASS**        | See below.                                                                                                                                   |
| No telemetry                                | **PASS**        | No analytics endpoint, no beacon, no usage reporting anywhere in `src/`.                                                                     |
| No remote code execution                    | **PASS**        | Nothing is fetched and evaluated; `no-eval` / `no-implied-eval` clean. CLI backends run a user-chosen local binary through the § 6 boundary. |
| Secrets kept out of logs                    | **PASS**        | Business Rules #12; the run's redaction seam is applied to every surfaced error message.                                                     |
| API-key storage disclosed                   | **PASS**        | Callout at the top of the Backends tab ("API keys are stored in plain text"), plus `docs/privacy-and-security.md`.                           |

**Plugin logging.** `src/utils/log.ts` keeps the level switch but every `console.*` line is commented out, so the shipped bundle emits nothing. Catch blocks route through `log(msg, 'error', err)` rather than calling the console directly.

The one uncommented `console.log` in the repo is `src/app/perf/bench.ts:145`, carrying a described disable:

```ts
// eslint-disable-next-line no-console -- reason: the whole point of a benchmark is to report the number it measured; this file is test-only and never bundled into the plugin.
```

Verified as test-only — nothing outside `perf/*.spec.ts` imports it, and it does not reach `main.js`:

```bash
bun run build && grep -o "console\.[a-z]*" dist/main.js
# console.warn        (one hit)
```

That single hit is inside `zod`'s JSON-Schema emitter (`Invalid target: ${this.target}`), reached only through `z.toJSONSchema`, which this plugin never calls. It is dependency code in a bundled dependency, not plugin logging. Worth mentioning to the reviewer pre-emptively rather than being asked about it.

**Network.** Every outbound request is a backend call the user configured. Hostnames in `src/` are: the three provider defaults (`api.anthropic.com`, `api.openai.com/v1`, `openrouter.ai/api/v1`), `*.openai.azure.com` composed from the user's own resource name, and `localhost`/`127.0.0.1` for Ollama and LM Studio. The rest are `*.example`/`*.test` fixtures in specs. Production paths inject `window.fetch.bind(window)` (`review-controller.ts:701/974/1445/2569`, `register-review-cli.ts:65`); the `globalThis.fetch` defaults in the service modules are unreachable fallbacks for the pure-logic tests.

**The support CTAs** (`support-links.ts`) are links the user clicks, not requests the plugin makes.

---

## 8. Startup cost

**Verdict: PASS.** `onload` (`src/app/plugin.ts:85`) does two awaited reads — `loadData()` and the comment sidecar — then pure construction and registration. No vault scan, no network call, no model probe.

The two surfaces that could block a restoring workspace are deferred to `onLayoutReady`:

- the setup wizard, on first run only (`plugin.ts:227`), re-checking `onboarded` inside the callback because a synced `data.json` may have arrived meanwhile;
- the review controller's own layout-ready pass (`review-controller.ts:541`).

Reviews are never automatic (Business Rules #1); even daemon mode only re-dispatches after the user pauses editing a note they already changed. Findings decoration is capped and measured — `documentation/Architecture.md` § Performance contracts carries the numbers.

---

## 9. Styling

| Item                                     | Verdict         | Evidence                                                                                                                                                                                           |
| ---------------------------------------- | --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No hardcoded styling                     | **PASS (note)** | Nine literal colour values in `src/styles.src.css`, all justified. See below. Verified against **`dist/styles.css`** too — see the global-selector check in § 10.                                  |
| `obsidianmd/no-static-styles-assignment` | **PASS**        | Clean — no literal style assignments on DOM elements.                                                                                                                                              |
| No `!important`                          | **PASS**        | `grep -n "!important" src/styles.src.css` → one match, inside a comment.                                                                                                                           |
| Theme tokens                             | **PASS**        | All 34 custom properties used were verified against Obsidian's own `app.css` during the M9 theming pass (history 2026-07-30). Radius and shadow come from `--radius-*` / `--shadow-*`.             |
| No global styles                         | **PASS**        | Every selector in `dist/styles.css` is `editor-ai-daemons-*`, `.support-header-margin` or the compound `.modal.editor-ai-daemons-*`. Enforced by the § 10 command, not by reading the source file. |
| Reduced motion                           | **PASS**        | One blanket `prefers-reduced-motion` block scoped to the plugin's class prefix, last in the file, no `!important`.                                                                                 |

The nine literals:

- six are **fallbacks inside `var()` / `color-mix()`** — `var(--shadow-s, 0 2px 8px rgb(0 0 0 / 0.15))`, `var(--color-red, #e93147)`, `var(--color-green, #08b94e)` — so the theme token wins whenever the theme defines it;
- three are the swatch checkmark (`styles.src.css:258-262`): white glyph with a dark halo, drawn on top of a **user-picked hue**. No theme token is guaranteed to contrast with an arbitrary colour, and this glyph exists precisely to be the non-colour indicator of which swatch is selected. The reasoning is in the stylesheet above the rule.

---

## 10. Build output and release

| Item                                              | Verdict  | Evidence                                                                                                                                                                      |
| ------------------------------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `main.js`, `manifest.json`, `styles.css` produced | **PASS** | `bun run build` → `dist/main.js` (664 KB), `dist/manifest.json`, `dist/styles.css` (42 KB).                                                                                   |
| `dist/styles.css` ships no global selectors       | **PASS** | Command below. This is the artefact a reviewer downloads — § 9 verdicts are checked against it, not only against `src/styles.src.css`.                                        |
| `dist/manifest.json` matches the source           | **PASS** | Copied verbatim by `scripts/build.ts`.                                                                                                                                        |
| Build artefacts not committed                     | **PASS** | `.gitignore` covers `main.js`, `styles.css`, `dist/`, `data.json`, `*.map`.                                                                                                   |
| Release attaches the three files only, no zip     | **PASS** | `release.yml` `files:` lists `dist/main.js`, `dist/manifest.json`, `dist/styles.css`.                                                                                         |
| Tag is bare SemVer                                | **PASS** | The `publish` job refuses a `v`-prefixed tag and refuses a tag that disagrees with `manifest.json`.                                                                           |
| Provenance bound to the tag commit                | **PASS** | Two-phase by design: `prepare` tags first (lightweight tag) and re-dispatches at the tag; `publish` builds and attests with `github.sha` == the tagged commit.                |
| Attestation configured                            | **PASS** | `actions/attest-build-provenance@v3` over the same three paths.                                                                                                               |
| No post-edit of `main.js`                         | **PASS** | Built in CI by `bun run build`; nothing touches the output afterwards.                                                                                                        |
| Bun pinned across CI and release                  | **PASS** | `bun-version-file: package.json` in both workflows; `packageManager: bun@1.3.14`.                                                                                             |
| Release body carries the CTAs                     | **PASS** | The changelog step appends `printf '\n---\n\n'` then `.github/release-footer.md` (which must not open with `---`; Prettier would read it as frontmatter).                     |
| CI gate                                           | **PASS** | `ci.yml` runs tsc, lint, tests and `format:check` on every push and PR to `main`.                                                                                             |
| Release gate matches CI                           | **PASS** | `release.yml`'s "Build (release gate)" step runs `lint`, `format:check`, `build` (which chains tsc) and `bun test` BEFORE the release commit is tagged.                       |
| `CHANGELOG.md`                                    | **PASS** | Header only, no template leakage. `docs/release-notes.md` regenerated from this repo's own changelog.                                                                         |
| `LICENSE`                                         | **PASS** | `obsidianmd/validate-license` clean.                                                                                                                                          |
| No template leftovers                             | **PASS** | No `TEMPLATE_USAGE.md`, no `scripts/init-from-template.ts`, no `init` script; `obsidianmd/no-sample-code` and `sample-names` clean; zero `TODO`/`FIXME` in `src/` or `docs/`. |

---

## 11. Gates

Green at the time of this sweep:

```bash
bun run format
bun run validate     # tsc + eslint --max-warnings 0 + bun test  → 2258 pass, 0 fail
bun run build

# No global selectors in the artefact a reviewer downloads. Must print
# nothing but this plugin's own non-prefixed classes.
grep -oE '(^|[}])\.[a-zA-Z0-9_-]+' dist/styles.css | sed 's/^}//' | sort -u | grep -v '^\.editor-ai-daemons'
# → .modal   (only ever as the compound `.modal.editor-ai-daemons-*`)
```

---

## Before submitting

1. **Resolve § 0.** Nothing else matters until the `id` and `name` are unique.
2. Re-run `curl … community-plugins.json` — the catalog moves.
3. Re-check `minAppVersion` against `desktop-releases.json` `latestVersion`.
4. After the release `prepare` job, confirm `versions.json` gained its first entry before the tag is pushed.
5. Re-run `bun run lint` with the current `eslint-plugin-obsidianmd`; a new version can add rules.
   5b. Re-run the § 11 `dist/styles.css` selector check — the Tailwind `source(none)` constraint is one token away from being dropped.
6. Mention the `zod` `console.warn` (§ 7) pre-emptively if the reviewer greps the bundle.

## The One Thing

Submit the plugin: the naming blocker is gone (`editor-ai-daemons` / "AI Editor", re-verified free on 2026-07-31), so the "Before submitting" list above is now the only thing between this repo and the catalog.
