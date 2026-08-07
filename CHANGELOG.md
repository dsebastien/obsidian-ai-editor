# Changelog

All notable changes to this project will be documented in this file.

## [0.8.0](https://github.com/dsebastien/obsidian-ai-editor/compare/0.7.0...0.8.0) (2026-08-07)

### Features

* **plugin:** review the note as soon as daemon mode is enabled ([a5fcdcb](https://github.com/dsebastien/obsidian-ai-editor/commit/a5fcdcba1030ac5dac3ff583dc444d138f8b9487))

## [0.7.0](https://github.com/dsebastien/obsidian-ai-editor/compare/0.6.1...0.7.0) (2026-08-07)

### Features

* **plugin:** default the Fact Checker to yellow, the Grammar Editor to pink ([7465450](https://github.com/dsebastien/obsidian-ai-editor/commit/74654501e3074181c28361d75660ee93d221925a))
* **plugin:** free color picker for editor and panel colors ([#44](https://github.com/dsebastien/obsidian-ai-editor/issues/44)) ([dc21823](https://github.com/dsebastien/obsidian-ai-editor/commit/dc21823df1ea8a65589293da45d30c5ccd2fed16))
* **plugin:** per-editor learning loop — distill triage decisions into editor memory ([#4](https://github.com/dsebastien/obsidian-ai-editor/issues/4)) ([fe2e11c](https://github.com/dsebastien/obsidian-ai-editor/commit/fe2e11cfe6988c796d29d57ffe59eb96cfeb1759))
* **plugin:** review-surface batch — sources UX, finding lifecycle, highlight contrast, per-note daemon ([#42](https://github.com/dsebastien/obsidian-ai-editor/issues/42), [#43](https://github.com/dsebastien/obsidian-ai-editor/issues/43)) ([fd23e91](https://github.com/dsebastien/obsidian-ai-editor/commit/fd23e91e52b2e7d3527355b63b2e99453a4c79bb)), closes [#30](https://github.com/dsebastien/obsidian-ai-editor/issues/30) [#23](https://github.com/dsebastien/obsidian-ai-editor/issues/23)

### Bug Fixes

* **plugin:** pre-mix keyframe colors outside [@keyframes](https://github.com/keyframes) so the minifier keeps them ([#45](https://github.com/dsebastien/obsidian-ai-editor/issues/45)) ([291bf6c](https://github.com/dsebastien/obsidian-ai-editor/commit/291bf6c07587d2129f470c12c0451f9a999cc3a4))

## [0.6.1](https://github.com/dsebastien/obsidian-ai-editor/compare/0.6.0...0.6.1) (2026-08-05)

### Bug Fixes

* **plugin:** classify Claude Code's not-logged-in envelope as auth ([#39](https://github.com/dsebastien/obsidian-ai-editor/issues/39)) ([67a5692](https://github.com/dsebastien/obsidian-ai-editor/commit/67a56922d929e348cdc64d8f7a496801ad8079c0))
* **plugin:** forward USER/LOGNAME to CLI children — the macOS Keychain lookup key ([#39](https://github.com/dsebastien/obsidian-ai-editor/issues/39)) ([b10c9d4](https://github.com/dsebastien/obsidian-ai-editor/commit/b10c9d49e002de833c3a805537a7c8923d448693))

## [0.6.0](https://github.com/dsebastien/obsidian-ai-editor/compare/0.5.2...0.6.0) (2026-08-05)

### Features

* **plugin:** add the Grammar Editor starter persona ([#37](https://github.com/dsebastien/obsidian-ai-editor/issues/37)) ([6ad308f](https://github.com/dsebastien/obsidian-ai-editor/commit/6ad308ffbbe8c90c049ab2159c8c15568079b1d8)), closes [#4](https://github.com/dsebastien/obsidian-ai-editor/issues/4)
* **plugin:** motion where state used to teleport ([#14](https://github.com/dsebastien/obsidian-ai-editor/issues/14)) ([660e74d](https://github.com/dsebastien/obsidian-ai-editor/commit/660e74dcc0c935da8e1c2d994d69bc0b2af2b44e))

### Bug Fixes

* **plugin:** adversarial round fixes for the [#39](https://github.com/dsebastien/obsidian-ai-editor/issues/39)/[#37](https://github.com/dsebastien/obsidian-ai-editor/issues/37)/[#14](https://github.com/dsebastien/obsidian-ai-editor/issues/14) batch ([ad19bc2](https://github.com/dsebastien/obsidian-ai-editor/commit/ad19bc2d917c4273b2fd86ef9995b293ca3cd194))
* **plugin:** classify Anthropic's empty-credit 400 as quota; document the Claude Code version floor ([#39](https://github.com/dsebastien/obsidian-ai-editor/issues/39)) ([0242d0a](https://github.com/dsebastien/obsidian-ai-editor/commit/0242d0aaaa9c253e66a1af9a0acb337e5c11f029))
* **plugin:** make backend failures diagnosable ([#39](https://github.com/dsebastien/obsidian-ai-editor/issues/39)) ([6bb4bdd](https://github.com/dsebastien/obsidian-ai-editor/commit/6bb4bddb18ed7afd1d16f3e7dde1ed551f4b709f))

## [0.5.2](https://github.com/dsebastien/obsidian-ai-editor/compare/0.5.1...0.5.2) (2026-08-05)

### Bug Fixes

* **plugin:** give the panel's note name its own line, above the controls ([4df2a1a](https://github.com/dsebastien/obsidian-ai-editor/commit/4df2a1ac6a857a01045a8f55c44f7f97c61ea403))

## [0.5.1](https://github.com/dsebastien/obsidian-ai-editor/compare/0.5.0...0.5.1) (2026-08-05)

### Bug Fixes

* **deps:** pin Node/Bun types directly so they cannot go missing ([0bba8f9](https://github.com/dsebastien/obsidian-ai-editor/commit/0bba8f94b4d2505f3afcabf7ca695620bbce8cce))
* **release:** map 1.12.2 to 0.5.0 in versions.json, not a phantom 0.4.1 ([3ed08c2](https://github.com/dsebastien/obsidian-ai-editor/commit/3ed08c2f75c12d3f9e358b970d46fb734c23d4a1))

## [0.5.0](https://github.com/dsebastien/obsidian-ai-editor/compare/0.4.0...0.5.0) (2026-08-04)

### ⚠ BREAKING CHANGES

* **plugin:** Obsidian 1.12.2 is now the minimum supported version.
Installs below it no longer receive the plugin.

### Features

* **plugin:** raise minAppVersion to 1.12.2 ([cf0f15c](https://github.com/dsebastien/obsidian-ai-editor/commit/cf0f15ccc2f0fd41221f0e597c094796cfb582dd))

### Bug Fixes

* **build:** ship CHANGELOG.md and eslint.config.ts in the source archive ([7e1f601](https://github.com/dsebastien/obsidian-ai-editor/commit/7e1f601a7e76689b0472131652a2472d85b67443))

## [0.4.0](https://github.com/dsebastien/obsidian-ai-editor/compare/0.3.0...0.4.0) (2026-08-04)

### Features

* **actions:** Find references — sources you can vet, then cite ([#30](https://github.com/dsebastien/obsidian-ai-editor/issues/30)) ([9faeb54](https://github.com/dsebastien/obsidian-ai-editor/commit/9faeb54c84896879ee308726cb4dc40ca79830f7))

### Bug Fixes

* **plugin:** rename to "AI Editors" to clear a catalog name collision ([e561a9f](https://github.com/dsebastien/obsidian-ai-editor/commit/e561a9f23dedc70a980686f044236f215c488b8a))

## [0.3.0](https://github.com/dsebastien/obsidian-ai-editor/compare/0.2.0...0.3.0) (2026-08-04)

### Features

* **actions:** Expand section and Continue the note — the placement verbs ([#31](https://github.com/dsebastien/obsidian-ai-editor/issues/31)) ([e64b90c](https://github.com/dsebastien/obsidian-ai-editor/commit/e64b90cefbcd3867d4f45ba0c3d3c8a810798db0))
* **ask:** panels join the picker, and the ask becomes 'Ask a question' ([#27](https://github.com/dsebastien/obsidian-ai-editor/issues/27)) ([c601b8e](https://github.com/dsebastien/obsidian-ai-editor/commit/c601b8ebac150794c8828ed0d37fa54913a7ace2)), closes [#14](https://github.com/dsebastien/obsidian-ai-editor/issues/14)
* **panel:** up/down section cycling from the pinned header ([41be75c](https://github.com/dsebastien/obsidian-ai-editor/commit/41be75c315eeb3556a1722125db86bc4e65fde08)), closes [#14](https://github.com/dsebastien/obsidian-ai-editor/issues/14)
* **rail:** an empty editor chip summons a review with just that editor ([4bbb2e0](https://github.com/dsebastien/obsidian-ai-editor/commit/4bbb2e06be542195d70742cdb24e0d57d4ae3a10))
* **rail:** summoning an idle editor JOINS the note's run instead of being blocked by it ([b971f2a](https://github.com/dsebastien/obsidian-ai-editor/commit/b971f2ad76f3537e30a75e95e88bf2ee455a839c))

### Bug Fixes

* **editor:** a finding over a link opens the card on plain click, not the link ([a50cb99](https://github.com/dsebastien/obsidian-ai-editor/commit/a50cb99f4010e29e612d9c6dfac9e1cd14b43d9a))
* **panel:** pin the header and tab bar while the findings list scrolls ([d1fe519](https://github.com/dsebastien/obsidian-ai-editor/commit/d1fe51976bc26bd7fa245c1b9f0b53f724678839))
* **panel:** the pinned header owns the leaf padding so nothing scrolls through it ([fdeccee](https://github.com/dsebastien/obsidian-ai-editor/commit/fdecceeae44ae3ad1d1231c035f45bdca1d48b1c))
* **panel:** the section-nav pair aligns with its neighbors as one split control ([056e9f8](https://github.com/dsebastien/obsidian-ai-editor/commit/056e9f811d19be260b62906839b7f513e153b199))
* **rail:** findings toggle becomes a labelled button owning the row; collapse becomes a drawn chevron ([b9ad535](https://github.com/dsebastien/obsidian-ai-editor/commit/b9ad53521de7cb69c403d06d61117c90bd48a490))
* **rail:** give the head's utility buttons real button chrome, on one row ([4ea0c62](https://github.com/dsebastien/obsidian-ai-editor/commit/4ea0c62fd4631c4320736032d70ddfdd9f49bb0a)), closes [#29](https://github.com/dsebastien/obsidian-ai-editor/issues/29) [#28](https://github.com/dsebastien/obsidian-ai-editor/issues/28)
* **rail:** retry joins its row as a split segment ([53db919](https://github.com/dsebastien/obsidian-ai-editor/commit/53db91912b35214167f9fc5c08153d95cdc7a331))
* **review:** size guard prices the selection, not the note around it ([81fd819](https://github.com/dsebastien/obsidian-ai-editor/commit/81fd8190f661917a31901d12015cf89c94e0645c))
* round-3 adversarial review — non-destructive hydrate, submit-time panel re-check, deduped request count ([2a64321](https://github.com/dsebastien/obsidian-ai-editor/commit/2a64321889fed8403861d8ac3f584e3eaebb00ac)), closes [#19](https://github.com/dsebastien/obsidian-ai-editor/issues/19)

## [0.2.0](https://github.com/dsebastien/obsidian-ai-editor/compare/0.1.0...0.2.0) (2026-08-02)

### ⚠ BREAKING CHANGES

* **contract:** structured edits replace free-text suggestions (#17, #22)

### Features

* **backends:** classify failures, retry only what is retryable, daemon auto-off ([#23](https://github.com/dsebastien/obsidian-ai-editor/issues/23)) ([b520cfb](https://github.com/dsebastien/obsidian-ai-editor/commit/b520cfba7e4d728c9de6223dd667d86d737b8e76)), closes [#12](https://github.com/dsebastien/obsidian-ai-editor/issues/12)
* **contract:** structured edits replace free-text suggestions ([#17](https://github.com/dsebastien/obsidian-ai-editor/issues/17), [#22](https://github.com/dsebastien/obsidian-ai-editor/issues/22)) ([b164d7a](https://github.com/dsebastien/obsidian-ai-editor/commit/b164d7a570e1c401d83f75d3dcc5b7522c5de0af))
* **panel:** acknowledge an all-good editor to clear its section ([#24](https://github.com/dsebastien/obsidian-ai-editor/issues/24)) ([812cf2d](https://github.com/dsebastien/obsidian-ai-editor/commit/812cf2d2ec7b6623e5a26468aca389bd5f533be0))
* **panel:** History tab — session archive, durable per file behind a setting ([#21](https://github.com/dsebastien/obsidian-ai-editor/issues/21)) ([7925849](https://github.com/dsebastien/obsidian-ai-editor/commit/7925849bd611851bd4a25fcdd06918e91bb84789)), closes [#19](https://github.com/dsebastien/obsidian-ai-editor/issues/19)
* **rail:** appearing Selection segment reviews only the selected text ([#26](https://github.com/dsebastien/obsidian-ai-editor/issues/26)) ([2048bab](https://github.com/dsebastien/obsidian-ai-editor/commit/2048bab951235c8dc619a56c7979835775a4d7f4)), closes [28/#33](https://github.com/28/obsidian-ai-editor/issues/33) [#14](https://github.com/dsebastien/obsidian-ai-editor/issues/14) [#33](https://github.com/dsebastien/obsidian-ai-editor/issues/33)
* **rail:** collapse to the daemon toggle, expand back ([#28](https://github.com/dsebastien/obsidian-ai-editor/issues/28)) ([752f3aa](https://github.com/dsebastien/obsidian-ai-editor/commit/752f3aaab33e8252332ce3a5295465eb7a891663)), closes [#33](https://github.com/dsebastien/obsidian-ai-editor/issues/33)
* **review:** show/hide findings per note, pausing the daemon while hidden ([#29](https://github.com/dsebastien/obsidian-ai-editor/issues/29)) ([f39c442](https://github.com/dsebastien/obsidian-ai-editor/commit/f39c442c896dee1bbeea3867836f50d7a26f2583))
* **ui:** rail fades when idle, finding text is selectable and copyable ([#33](https://github.com/dsebastien/obsidian-ai-editor/issues/33), [#34](https://github.com/dsebastien/obsidian-ai-editor/issues/34)) ([5a5f43c](https://github.com/dsebastien/obsidian-ai-editor/commit/5a5f43c384185e79eeaa6cbe0c73125803a63c9c))

### Bug Fixes

* **backends:** truncation is its own failure, and near-JSON is recovered ([#18](https://github.com/dsebastien/obsidian-ai-editor/issues/18)) ([fc12545](https://github.com/dsebastien/obsidian-ai-editor/commit/fc1254530792e392d28de6d5ee05d93264f97a09)), closes [#23](https://github.com/dsebastien/obsidian-ai-editor/issues/23)
* **daemon:** 3s idle default, any interaction resets the window ([#20](https://github.com/dsebastien/obsidian-ai-editor/issues/20)) ([303f83c](https://github.com/dsebastien/obsidian-ai-editor/commit/303f83cca50ef73186551cefecfff28169d73728))
* harden JSON recovery, quota sniff, daemon pause and acknowledgements ([ce2fe2a](https://github.com/dsebastien/obsidian-ai-editor/commit/ce2fe2aa3635d7cf86089f83ae92e6772ff6a78f)), closes [#18](https://github.com/dsebastien/obsidian-ai-editor/issues/18) [#18](https://github.com/dsebastien/obsidian-ai-editor/issues/18) [#29](https://github.com/dsebastien/obsidian-ai-editor/issues/29)
* **review:** re-reviewing keeps findings and the user's triage ([#19](https://github.com/dsebastien/obsidian-ai-editor/issues/19)) ([9ae9cee](https://github.com/dsebastien/obsidian-ai-editor/commit/9ae9cee6291aa71d609b14766b9fe7549b0de7cb))
* second adversarial round + lint currency (obsidianmd 0.4.1) ([76b2bd7](https://github.com/dsebastien/obsidian-ai-editor/commit/76b2bd7f503921254229eade207751bb76fa8a86)), closes [#7](https://github.com/dsebastien/obsidian-ai-editor/issues/7) [#35](https://github.com/dsebastien/obsidian-ai-editor/issues/35)
* **settings:** the last three ai-editor-prefixed identifiers finish the rename ([1a21ebf](https://github.com/dsebastien/obsidian-ai-editor/commit/1a21ebfb417227618976ad7262918a1720c36260))

## 0.1.0 (2026-08-01)

### Features

* **a11y:** a finding highlight says whose it is without its colour ([110ba42](https://github.com/dsebastien/obsidian-ai-editor/commit/110ba4209b31f45ffba295d4bb140cc0543af750))
* **actions:** a custom action states what it does to the note ([8b2b589](https://github.com/dsebastien/obsidian-ai-editor/commit/8b2b5897755f24779c7aa68dfabb1f7ceefbd004))
* **actions:** action-binding resolution to dispatchable targets ([d670df1](https://github.com/dsebastien/obsidian-ai-editor/commit/d670df1567d0a147b9874f37d94c87d6be72c6ce)), closes [#7](https://github.com/dsebastien/obsidian-ai-editor/issues/7)
* **actions:** built-in verb registry with per-verb instruction prompts ([7c338c5](https://github.com/dsebastien/obsidian-ai-editor/commit/7c338c5ef0fa29d19c1814dfc8509298fb56a078))
* **actions:** custom actions dispatch like built-ins, class and all ([7ab0c51](https://github.com/dsebastien/obsidian-ai-editor/commit/7ab0c516f01c7852dee59ec80c16ba1f46a424ff))
* **actions:** humanize built-in action verb ([9fa9b51](https://github.com/dsebastien/obsidian-ai-editor/commit/9fa9b5179e391743c42f6920f3394b032317b304))
* **backends:** dedicated OpenRouter backend kind ([fb16f1c](https://github.com/dsebastien/obsidian-ai-editor/commit/fb16f1c198b09d9246e4c3ba4190345e6ea034e5))
* **backends:** per-backend thinking settings for all API providers ([fd97786](https://github.com/dsebastien/obsidian-ai-editor/commit/fd977865ae0df35437d2010842dfd5a5644d6fbd))
* **cli:** a CLI backend resolves like any other, everywhere ([926d9dd](https://github.com/dsebastien/obsidian-ai-editor/commit/926d9ddcb732c1580a190c6d690766fe23717bf5))
* **cli:** a health check that runs the real thing, and a detector that runs nothing ([86eb529](https://github.com/dsebastien/obsidian-ai-editor/commit/86eb529573bf88cb97cc8ee265f80735cfef8fd4))
* **cli:** a panel review returns its scorecard instead of paying for one and dropping it ([a2d5313](https://github.com/dsebastien/obsidian-ai-editor/commit/a2d5313e1e3284321515cb1f1f35d97c696d2b64))
* **cli:** add ai-editor:cancel subcommand ([e34e5f7](https://github.com/dsebastien/obsidian-ai-editor/commit/e34e5f742f98666d043398aab093b41fe1b0538b))
* **cli:** add ai-editor:status subcommand ([7be8452](https://github.com/dsebastien/obsidian-ai-editor/commit/7be84529e282f5986d60a307de7c46f5bac1de42))
* **cli:** buffered ai-editor:review CLI handler ([fa58134](https://github.com/dsebastien/obsidian-ai-editor/commit/fa58134957beb31b7125be7752a772af13e29431)), closes [#12](https://github.com/dsebastien/obsidian-ai-editor/issues/12)
* **cli:** cancelling a run kills the whole tree, and checks ([fff53ba](https://github.com/dsebastien/obsidian-ai-editor/commit/fff53ba9481c8ef999a01511787e501710f18ed2))
* **cli:** claude code and codex invocation contracts ([05b689d](https://github.com/dsebastien/obsidian-ai-editor/commit/05b689d943305efd6fd68ec7080e68588f79a6ae))
* **cli:** CLI editor executor behind the same contract as API backends ([f1324f2](https://github.com/dsebastien/obsidian-ai-editor/commit/f1324f22149dddc8b5682a8923c2a02dea0f5339))
* **cli:** consent is a record of which binary, not a yes ([a120cc0](https://github.com/dsebastien/obsidian-ai-editor/commit/a120cc0a3cdfa3961be1d9befe780007eb3c1949)), closes [#9](https://github.com/dsebastien/obsidian-ai-editor/issues/9) [#12](https://github.com/dsebastien/obsidian-ai-editor/issues/12)
* **cli:** the note reaches the tool over stdin, in a sandbox it cannot escape ([c403c14](https://github.com/dsebastien/obsidian-ai-editor/commit/c403c14811907b711b048c9ba857db2ef2242904))
* **cli:** what runs, what it can see, and what it may say are decided before anything starts ([988ee58](https://github.com/dsebastien/obsidian-ai-editor/commit/988ee589b774a0220be658f7e63462d526fdced1)), closes [#12](https://github.com/dsebastien/obsidian-ai-editor/issues/12)
* **commands:** bulk accept and dismiss per editor and for the whole run ([ec886ee](https://github.com/dsebastien/obsidian-ai-editor/commit/ec886ee1674d671bfe860c15bb494ed7e634a247)), closes [#3](https://github.com/dsebastien/obsidian-ai-editor/issues/3)
* **commands:** dynamic per-action palette commands follow the settings ([d04b3cc](https://github.com/dsebastien/obsidian-ai-editor/commit/d04b3cc5d496623be5542ee652ae27f3a1e10687))
* **commands:** static palette commands for review dispatch and finding navigation ([b6827c6](https://github.com/dsebastien/obsidian-ai-editor/commit/b6827c61530e0f191087e0838cabf2f8cb4daddc))
* **commands:** toggle daemon mode from the palette ([7ece5e7](https://github.com/dsebastien/obsidian-ai-editor/commit/7ece5e70cfebcd8b3e74b4636e8a37eba7b3eb11))
* **commands:** unified memory-based triage stepping engine ([f25912d](https://github.com/dsebastien/obsidian-ai-editor/commit/f25912daf85c15eb1c3649cad6d04e7e8a1682f4))
* **comments:** ask for comments, from three surfaces ([c08ab87](https://github.com/dsebastien/obsidian-ai-editor/commit/c08ab875ba214742b52adfff851dd7e2e28f142d)), closes [#13](https://github.com/dsebastien/obsidian-ai-editor/issues/13)
* **comments:** background comment runs, keyed by comment and not by view ([38d7374](https://github.com/dsebastien/obsidian-ai-editor/commit/38d737496fe9eb9eb18943b7f2bf5fcb9b36b2bd)), closes [#13](https://github.com/dsebastien/obsidian-ai-editor/issues/13)
* **comments:** background job lifecycle with honest interrupted-job semantics ([2638cde](https://github.com/dsebastien/obsidian-ai-editor/commit/2638cdee53dc8d9ea994f21bda751f26d7bb0a1f)), closes [#1](https://github.com/dsebastien/obsidian-ai-editor/issues/1)
* **comments:** background jobs yield to foreground work ([0728810](https://github.com/dsebastien/obsidian-ai-editor/commit/07288106ec5a70320e11ad585e684766f2d455f0))
* **comments:** durable comment schema and cross-session re-anchoring ([c3c665a](https://github.com/dsebastien/obsidian-ai-editor/commit/c3c665a409631522a8e27a5d02167afd0f783975))
* **comments:** margin column geometry and card model ([95d1711](https://github.com/dsebastien/obsidian-ai-editor/commit/95d1711e20a3bdc38292272e9e5a013504f41c0d))
* **comments:** sidecar repository with atomic writes and corruption recovery ([f69eea9](https://github.com/dsebastien/obsidian-ai-editor/commit/f69eea927e1f6e918e8b21902109fc5741c82d55))
* **comments:** the durable store loads with the plugin and follows the vault ([a0664f3](https://github.com/dsebastien/obsidian-ai-editor/commit/a0664f36f1c22145136b4894e31ebbaccfa5be47))
* **comments:** the job registry joins the durable store to the live runs ([ab3512e](https://github.com/dsebastien/obsidian-ai-editor/commit/ab3512ea84570cf11088a8989ffc54da86d782d5))
* **comments:** the margin column follows the note ([bec3414](https://github.com/dsebastien/obsidian-ai-editor/commit/bec3414a794d488199586fea7c68ca191e28633d)), closes [#13](https://github.com/dsebastien/obsidian-ai-editor/issues/13)
* **comments:** the margin column renders ([f31acdb](https://github.com/dsebastien/obsidian-ai-editor/commit/f31acdb3e49c6ce8cc235ae15f8de8291edc9ac2))
* **comments:** the side panel shows background jobs with live timers ([180cc1e](https://github.com/dsebastien/obsidian-ai-editor/commit/180cc1e1f8015b3429bb38b777a2eedfee09b614))
* **context:** follow links from prompt-source notes into the prompt ([9ecc949](https://github.com/dsebastien/obsidian-ai-editor/commit/9ecc9492f6e48120387b4bd7d97da6bb9bee726e))
* **context:** one budget policy, and it reports what it dropped ([094f41b](https://github.com/dsebastien/obsidian-ai-editor/commit/094f41ba1219709183b0e4a3ce42be0d9c84a465))
* **context:** one prompt-build entry point, and a preview that reads it ([5d05749](https://github.com/dsebastien/obsidian-ai-editor/commit/5d057494240ba85f812db80781bf02ea17ae04c5))
* **daemon:** daemon controller glue, rail armed indicator, editor-set redispatch seam ([8a02ba5](https://github.com/dsebastien/obsidian-ai-editor/commit/8a02ba5056a1be3421f8124522a2967e8ced5ea3))
* **daemon:** pure daemon scheduler core (idle windows, coalescing, fire gates) ([9121540](https://github.com/dsebastien/obsidian-ai-editor/commit/912154048625108936c8fd7bb45de1947dd736bf))
* **diff:** word-level LCS diff with whitespace preservation and bridge folding ([4fff879](https://github.com/dsebastien/obsidian-ai-editor/commit/4fff879a4ea3ff4b862d1508c537e686f67ebfdc))
* **domain:** M0 contracts and anchoring engine ([1430eb2](https://github.com/dsebastien/obsidian-ai-editor/commit/1430eb29b17d772e6c0690764fd5f32ee7954837))
* **editor:** dispatch incremental stale-marking while the user types ([5fd0080](https://github.com/dsebastien/obsidian-ai-editor/commit/5fd00806a1e557153da1aae8019832d42ee639a8))
* end-to-end review flow - transport, backend glue, review UI wiring ([6b55b11](https://github.com/dsebastien/obsidian-ai-editor/commit/6b55b11f25d3135ff3014ffbb440874b4547a91c))
* M1-M2 slice - providers, orchestration, context assembly, settings UI, CM6 skeleton ([326570f](https://github.com/dsebastien/obsidian-ai-editor/commit/326570f77be6bc3734258126e2181767b198f015))
* **orchestration:** enforce behavior.maxConcurrentRequests across all runs ([29bf5e5](https://github.com/dsebastien/obsidian-ai-editor/commit/29bf5e59c10255255c866a4e72fe0eaf4f9a0110))
* **orchestration:** lean TransformRunHandle + TransformController sharing the review gate ([6525525](https://github.com/dsebastien/obsidian-ai-editor/commit/6525525b7e4bd20ac141c9f40ad0110d0adcf988)), closes [#12](https://github.com/dsebastien/obsidian-ai-editor/issues/12) [3/#4](https://github.com/3/obsidian-ai-editor/issues/4)
* **orchestration:** per-editor retry inside an existing run ([4810a5b](https://github.com/dsebastien/obsidian-ai-editor/commit/4810a5b7bcd68a66518a1dfbc3016828eb6baffb)), closes [3/#4](https://github.com/3/obsidian-ai-editor/issues/4)
* **panel:** decide per-editor finding navigation, purely ([9de7ae3](https://github.com/dsebastien/obsidian-ai-editor/commit/9de7ae35d0ddf2794051eb2ea4f268bad3a455ea))
* **panel:** Review button in the side-panel header, bound to the panel's note ([e0d85ab](https://github.com/dsebastien/obsidian-ai-editor/commit/e0d85ab9b85ba226514f575416926441435fc095))
* **panels:** a panel run is one run, aggregation and all ([ef41d84](https://github.com/dsebastien/obsidian-ai-editor/commit/ef41d84b6cf3ddd2be1bd55ce615a00d9cdfe1d5))
* **panels:** every surface that convenes a panel starts a panel run ([89e8583](https://github.com/dsebastien/obsidian-ai-editor/commit/89e85838fc9f2bb045e9ebacd9bbbe1700fbfc34))
* **panels:** one vocabulary for telling an editor from a panel ([435e6ad](https://github.com/dsebastien/obsidian-ai-editor/commit/435e6ad25c7e3907aa106a03ff11dae1ae557e79)), closes [#11](https://github.com/dsebastien/obsidian-ai-editor/issues/11)
* **panel:** step through one editor's findings from its section ([db308de](https://github.com/dsebastien/obsidian-ai-editor/commit/db308de8e085db7ba48270584e7abb4d0197d6d1))
* **panels:** the aggregation request fits a budget, and says what it left out ([ffdb4f8](https://github.com/dsebastien/obsidian-ai-editor/commit/ffdb4f81983d2f959933e3e1a927ac939c582063))
* **panels:** the charter reaches every member's prompt ([6ffdb22](https://github.com/dsebastien/obsidian-ai-editor/commit/6ffdb2246baa08c1bb335c0adaf0a5fd5e48c698))
* **panels:** the scorecard is a typed shape, not a bag of strings ([cdb9e4e](https://github.com/dsebastien/obsidian-ai-editor/commit/cdb9e4e6dca82399f482302e083e99e76922f2ff))
* **panels:** the scorecard is on screen, and its fixes point at the text ([6bb0efb](https://github.com/dsebastien/obsidian-ai-editor/commit/6bb0efb99cbed068a423f2f95fe0f62c105c27e4)), closes [#4](https://github.com/dsebastien/obsidian-ai-editor/issues/4)
* **plugin:** present transform results inline with rail spinner and shared cancel ([0139942](https://github.com/dsebastien/obsidian-ai-editor/commit/0139942fa07fcc1ab4c1e513aac2d829fc579b37))
* **plugin:** rail chip tooltips name each editor with its live status ([c605b90](https://github.com/dsebastien/obsidian-ai-editor/commit/c605b90694dafb54180961c82b5d02d875efa9db))
* **plugin:** show what's new in a tab instead of a modal dialog ([9df354b](https://github.com/dsebastien/obsidian-ai-editor/commit/9df354b5da7ad83fac6b22f8bb64003bae8a2341))
* **rail:** a panel run is one ringed entity that owns its members ([35e1ba1](https://github.com/dsebastien/obsidian-ai-editor/commit/35e1ba1f934f970257a28f025a37a6c1cb405b3c)), closes [#11](https://github.com/dsebastien/obsidian-ai-editor/issues/11) [#11](https://github.com/dsebastien/obsidian-ai-editor/issues/11)
* **rail:** flip daemon mode from above the Review button ([2ceaa49](https://github.com/dsebastien/obsidian-ai-editor/commit/2ceaa498a3ff75e45d138ed636faf6c8aa5876f8))
* **rail:** name every row, ring every status ([5185627](https://github.com/dsebastien/obsidian-ai-editor/commit/518562765aa354f1aeca95a7aaef018c4dbad192))
* **rail:** render named rows, status rings and motion cues ([e6a2807](https://github.com/dsebastien/obsidian-ai-editor/commit/e6a28077d0681add83148b4fd056361bcd23dff2)), closes [#11](https://github.com/dsebastien/obsidian-ai-editor/issues/11)
* **review:** ask an editor for more without throwing away what it said ([f4b1816](https://github.com/dsebastien/obsidian-ai-editor/commit/f4b1816d65b9467dbf001f0e53a7c0387f31a0d3)), closes [3/#4](https://github.com/3/obsidian-ai-editor/issues/4)
* **review:** bulk triage planning and severity filter state ([1a513a4](https://github.com/dsebastien/obsidian-ai-editor/commit/1a513a4fe2d46efd13030c4dfd9be9abf8d726c0))
* **review:** one reviewability gate that says why, and the panel button state it feeds ([e749cf2](https://github.com/dsebastien/obsidian-ai-editor/commit/e749cf20febad9f69833588c1900931547b7febb)), closes [#16](https://github.com/dsebastien/obsidian-ai-editor/issues/16)
* **review:** per-finding push-back thread state ([5eb3fbf](https://github.com/dsebastien/obsidian-ai-editor/commit/5eb3fbfae8443d3df4d7322b45d11d3745736f08)), closes [#3](https://github.com/dsebastien/obsidian-ai-editor/issues/3)
* **review:** run instructions target a set of editors ([4c8584d](https://github.com/dsebastien/obsidian-ai-editor/commit/4c8584d327e8305ff11e0b1e4e0a34a9c78b5fea))
* **review:** the "Generate more" affordance, priced in the label ([37ce095](https://github.com/dsebastien/obsidian-ai-editor/commit/37ce09509c065fc4619d3f958492294adfcacbb8))
* **review:** thread turn orchestration and dispatch ([112b0ef](https://github.com/dsebastien/obsidian-ai-editor/commit/112b0ef06c04128d5a003e142c3a67d1db76b9b4)), closes [#12](https://github.com/dsebastien/obsidian-ai-editor/issues/12) [#7](https://github.com/dsebastien/obsidian-ai-editor/issues/7)
* **rules:** binding rules filter the dispatch path (closes SEAM M6) ([d0710ed](https://github.com/dsebastien/obsidian-ai-editor/commit/d0710edfabc855a12ec6d3db99c0ecced639409f))
* **rules:** pure binding-rule engine and note-type resolver ([5a926f7](https://github.com/dsebastien/obsidian-ai-editor/commit/5a926f7f8b6a2ce531c97e4a272d6fa81d8fca1a))
* **rules:** vault seam for note facts and the optional OSK adapter ([2251df5](https://github.com/dsebastien/obsidian-ai-editor/commit/2251df5c356a73ec594e84642c364ee9da98d1cb))
* **services:** selection scope plumbing for review runs ([c3508d6](https://github.com/dsebastien/obsidian-ai-editor/commit/c3508d60809231f6183b0b6d993ff3a2c08617d4))
* **services:** shared reviewability predicate + settings mutation observer ([64afd8e](https://github.com/dsebastien/obsidian-ai-editor/commit/64afd8ec117dc2cc881d3729e49485a035a51587))
* **services:** transform service dispatches built-in action verbs end-to-end ([433ba2e](https://github.com/dsebastien/obsidian-ai-editor/commit/433ba2e343a087239e627c5425db6184ccd43da0)), closes [#4](https://github.com/dsebastien/obsidian-ai-editor/issues/4)
* **settings:** actions tab enforces review-only panel bindings and surfaces hidden actions ([ac61f7a](https://github.com/dsebastien/obsidian-ai-editor/commit/ac61f7a25500c50134680462282aeeb1c84a482d))
* **settings:** CLI backends are creatable, behind two separate consents ([6b23f79](https://github.com/dsebastien/obsidian-ai-editor/commit/6b23f79e3ed0fe22840928c373940d35347b40ae))
* **settings:** configurable request timeout replacing hardcoded 300s ([28af75e](https://github.com/dsebastien/obsidian-ai-editor/commit/28af75e0776f4dcab06e644961352b312a085185))
* **settings:** daemon mode schema and behavior tab controls ([a37da92](https://github.com/dsebastien/obsidian-ai-editor/commit/a37da9237f7a3dfd0e898f80b5b6bfa621416572))
* **settings:** import and export dialogs in the Behavior tab ([cd34766](https://github.com/dsebastien/obsidian-ai-editor/commit/cd347662ff0a5831a39f20711c25c0f3e2de20a6))
* **settings:** Rules tab states the real evaluation order and what each rule does ([3d419a2](https://github.com/dsebastien/obsidian-ai-editor/commit/3d419a2f028bc45eeb77e1a3d8313071e54a4110))
* **settings:** schema-versioned settings model with salvage load and referential integrity ([40d8a0e](https://github.com/dsebastien/obsidian-ai-editor/commit/40d8a0ee83d48eb192d9e54ea291adea432bbdb4))
* **settings:** settings transfer — export a subset, import it as a plan ([50fd566](https://github.com/dsebastien/obsidian-ai-editor/commit/50fd56601bedbb09a14e7abde38973b27e1baf83))
* **settings:** setup wizard core — step machine, one shared backend rule, real health check ([540b2c0](https://github.com/dsebastien/obsidian-ai-editor/commit/540b2c0988e34afa6c8536baefa90c7a4e08fe0a))
* **settings:** starter pack seeds default action bindings ([5837b77](https://github.com/dsebastien/obsidian-ai-editor/commit/5837b77dba0f6188b0854fc47439b61d2aea5749))
* **settings:** the Actions tab can actually author a custom action ([b83c530](https://github.com/dsebastien/obsidian-ai-editor/commit/b83c53021d3472abf53d29a1fcebd60335cc22f9))
* **settings:** the CLI backend dialog states which tool it runs ([0626906](https://github.com/dsebastien/obsidian-ai-editor/commit/0626906bc48cd351d974a98c7297f12e4de4ff63))
* **settings:** the settings tab asks for support, like every other plugin ([32d3591](https://github.com/dsebastien/obsidian-ai-editor/commit/32d3591616fc76059e9ab6e276b1216ac49d0f5d))
* **settings:** the setup wizard, its copy, the command and the first-run trigger ([592a464](https://github.com/dsebastien/obsidian-ai-editor/commit/592a4647f536b395bc35ebf8ca444df9932f1936))
* **settings:** vault note autocomplete on note-reference fields ([5dfe4bb](https://github.com/dsebastien/obsidian-ai-editor/commit/5dfe4bb476f0f69e9d8862a2b23f6345e949ba06))
* **starter-pack:** humanizer persona from osk-writing-humanizer taxonomy ([93d93a8](https://github.com/dsebastien/obsidian-ai-editor/commit/93d93a8e4d1f16def5758a0d4d65a91747fd633b))
* **starter:** the charter says what "top" means and what to do with dissent ([00ec193](https://github.com/dsebastien/obsidian-ai-editor/commit/00ec193197c4b22f2bc540448dec16fa31246cc6))
* **transport:** chunk-safe SSE decoder with adversarial chunking tests ([6c34f68](https://github.com/dsebastien/obsidian-ai-editor/commit/6c34f6895b89f2937344a13e91e1b2d96a5e5e12))
* **ui:** a modal that shows exactly what will be sent ([64bdfd3](https://github.com/dsebastien/obsidian-ai-editor/commit/64bdfd327a55b2754e883b266d3b4caf029d15ac))
* **ui:** a rule-disabled note shows no rail, no menus, no commands ([adf6bdd](https://github.com/dsebastien/obsidian-ai-editor/commit/adf6bddbdc1b5b0f2c224da9b68402e62a6694aa))
* **ui:** adaptive narrow-pane layout for the rail and cards ([10ad3d0](https://github.com/dsebastien/obsidian-ai-editor/commit/10ad3d0081a8af045df72198298ef87a39d23a63))
* **ui:** bound actions dispatch from the editor context menu ([9ed101d](https://github.com/dsebastien/obsidian-ai-editor/commit/9ed101d63e94153a16946cb4208dfb0d11049a1c))
* **ui:** current-finding decoration state and programmatic card open ([87bf9d9](https://github.com/dsebastien/obsidian-ai-editor/commit/87bf9d9cc92356b1c3c3f2f4826ac8e9951ea5c2))
* **ui:** editor and file context menus for review dispatch ([9a5ed7c](https://github.com/dsebastien/obsidian-ai-editor/commit/9a5ed7cdd1c125b5cedadbf27a06e46fe2b2a32e))
* **ui:** finding card push-back threads ([42dd072](https://github.com/dsebastien/obsidian-ai-editor/commit/42dd07207dea7eb13d75ad08addcf6149ce4110f))
* **ui:** freeform ask-an-editor modal entry point (design §6 decision 1) ([991fbcd](https://github.com/dsebastien/obsidian-ai-editor/commit/991fbcd9d4819ccc1fd5a28646c5dfa8458f1ae0))
* **ui:** inline transform preview widget with word-level diff and accept/reject ([01e485c](https://github.com/dsebastien/obsidian-ai-editor/commit/01e485cf5804236dde4dd55a13fcf5fdf2d8ab0e))
* **ui:** keyboard triage loop — cursor, card-on-jump, accept/dismiss commands ([8da93e4](https://github.com/dsebastien/obsidian-ai-editor/commit/8da93e4771f56c360ece2518e33b441d9c1889d5))
* **ui:** per-file severity filter over decorations, panel and triage ([2cce37d](https://github.com/dsebastien/obsidian-ai-editor/commit/2cce37def225facb2febfc217e593f517eb74270))
* **ui:** rail chip click reveals and cycles the editor's findings ([d186d1b](https://github.com/dsebastien/obsidian-ai-editor/commit/d186d1b2d30ec32ac3f748f22fb8da3ee0e423c1))
* **ui:** retry affordance on failed editors in rail chip and side panel ([3343271](https://github.com/dsebastien/obsidian-ai-editor/commit/334327106997844a89ff235d07d2147b8ccf3b21))

### Bug Fixes

* **a11y:** a colour swatch says which colour is chosen ([fdae37a](https://github.com/dsebastien/obsidian-ai-editor/commit/fdae37a1b2e7bd5fcfcfdbf06398a7158cc00be4))
* **a11y:** six of the seven settings tabs pointed aria-controls at nothing ([a1f58fd](https://github.com/dsebastien/obsidian-ai-editor/commit/a1f58fd6bd7252f4e390ccc001ba214982b3b2f4))
* **a11y:** the settings tab bar keeps the promise its roles make ([fd6f044](https://github.com/dsebastien/obsidian-ai-editor/commit/fd6f044d963ef0603ae3d73163a5215499685dfb))
* **a11y:** the side panel names what it shows ([a62e058](https://github.com/dsebastien/obsidian-ai-editor/commit/a62e058170468fc526f30e045fc74c789289f7f4))
* **backends:** adaptive thinking for current Anthropic models, legacy budget clamps, compatible reasoning progress ([c34472f](https://github.com/dsebastien/obsidian-ai-editor/commit/c34472f9ac39d8fdb12e62ebf4436d411c6dc56c))
* **backends:** launch consent is enforced where a backend becomes a process ([80a4185](https://github.com/dsebastien/obsidian-ai-editor/commit/80a4185ba564618f9b5c29015455a96ffbae18e5))
* **backends:** stream the OpenRouter kind ([dd664b1](https://github.com/dsebastien/obsidian-ai-editor/commit/dd664b1980a4049b709f78aed37f5d6a85a4ce03))
* **cli:** --editors stops being resolved against the rule it should override ([8e03659](https://github.com/dsebastien/obsidian-ai-editor/commit/8e0365933082be22ed3720b1acf3d681c08e2ab7))
* **cli:** distinct bad-args error code and state-derived settled report ([555d6c7](https://github.com/dsebastien/obsidian-ai-editor/commit/555d6c7b24bb634bacc72fa17d860d6cac1954d7))
* **cli:** every run ends with the tree verified gone, and an aborted run never starts one ([b046e89](https://github.com/dsebastien/obsidian-ai-editor/commit/b046e89f8df143c394190aa2770654cb7e86b08c))
* **cli:** report mid-retry editors as retrying skips in one-shot review output ([df633f8](https://github.com/dsebastien/obsidian-ai-editor/commit/df633f8c6ea87a4380187adea1aec3e886f26c9e))
* **cli:** the Windows kill goes through the boundary's own gate ([863494e](https://github.com/dsebastien/obsidian-ai-editor/commit/863494ee6351d5d5fd5683b5d78930b00d742b8d))
* **comments:** margin column follows the right note, and costs nothing on quiet panes ([d9c59b2](https://github.com/dsebastien/obsidian-ai-editor/commit/d9c59b2f974e37b9d3e10027b494ef57a7757436))
* **comments:** the durable store stops losing comments to its own edge cases ([a63b848](https://github.com/dsebastien/obsidian-ai-editor/commit/a63b848675116aa3287680f1e658cf006498fa77)), closes [#13](https://github.com/dsebastien/obsidian-ai-editor/issues/13)
* **comments:** the margin answers, and a refusal never strands a comment ([e6506a6](https://github.com/dsebastien/obsidian-ai-editor/commit/e6506a658d1ebbd03bc52978ed807b9a7ea962f7))
* **comments:** the margin column stops eating focus, cards and names ([a16c534](https://github.com/dsebastien/obsidian-ai-editor/commit/a16c534f1a644b6053380394b11dbdcbcb47bbe7))
* **daemon:** abort dispatch on mid-flight disable/unload, clear schedule on same-pane navigation, reduced-motion guard ([c1b84e1](https://github.com/dsebastien/obsidian-ai-editor/commit/c1b84e1c50b509405b09bed59ee391aa5d1a95d4))
* **orchestration:** occurrence-aware finding dedupe and run eviction ([75dee05](https://github.com/dsebastien/obsidian-ai-editor/commit/75dee0524d258d804a6be03af8f54a40a53957d2))
* **orchestration:** release concurrency permit when an editor goes terminal ([88456a7](https://github.com/dsebastien/obsidian-ai-editor/commit/88456a7288291659caf85a6f4d8ce208cedfd4ea))
* **panel:** Ask for comments finds the note the panel is showing ([4951d0a](https://github.com/dsebastien/obsidian-ai-editor/commit/4951d0aa3884549b1e08ccb4732c2922ef3375a7))
* **panels:** a member's findings dropped by the contract cap are counted as omitted ([ab409e9](https://github.com/dsebastien/obsidian-ai-editor/commit/ab409e9f905aa67002a9608cdb74911216c874c4))
* **panels:** a run being aggregated is still running, and the scorecard is checked against the roster ([6d11cdf](https://github.com/dsebastien/obsidian-ai-editor/commit/6d11cdff09e0629ee6d34d025b551084c8a14e32))
* **panel:** the finding stepper answers a keyboard, and says where it landed ([77fcfdb](https://github.com/dsebastien/obsidian-ai-editor/commit/77fcfdb7f5cdd213f86863e63df00af3b6dd96f1))
* **plugin:** heal registerView double-load race instead of dying on load ([b70b12b](https://github.com/dsebastien/obsidian-ai-editor/commit/b70b12bfd0ecb87071331bbdd8eeceecad3ffa86))
* **preview,docs:** an excluded note keeps its preview command, and the guide stops calling push-back a placeholder ([b42ba2c](https://github.com/dsebastien/obsidian-ai-editor/commit/b42ba2c0800c6818f5ae85e57716cd969ca8310f))
* **preview,review:** the preview accounts for the panel charter, and an unavailable panel refuses before the size guard ([f2c62b6](https://github.com/dsebastien/obsidian-ai-editor/commit/f2c62b6e4c6c2c6510a51e411d67b0faa71a2141))
* **preview,rules:** the preview accounts for action instructions, and a foreign regex cannot freeze the UI ([47dd1f1](https://github.com/dsebastien/obsidian-ai-editor/commit/47dd1f1bb47c1536c12c6b4eb88a2297952b5adc))
* **providers:** ollama think:false and advisory-hint clamping from live-vault verification ([0d359cb](https://github.com/dsebastien/obsidian-ai-editor/commit/0d359cb65b7c10be6aad9506a38f45250dfc820d))
* **rail:** reconcile the rows, and say what is happening ([a995ef2](https://github.com/dsebastien/obsidian-ai-editor/commit/a995ef2b4a66e4e5ce216b2fc55891fef6f9908a))
* **review:** a detached run never opens a thread turn ([10b399f](https://github.com/dsebastien/obsidian-ai-editor/commit/10b399f0412d008a14b9d2e52aa2f9d97974eb68))
* **review:** actionable requires an anchored text like accept does ([ee9c7c7](https://github.com/dsebastien/obsidian-ai-editor/commit/ee9c7c764855a47cc87b2b935b70218c21aeed30))
* **review:** close CLI/selection contract holes from adversarial fix pass ([3e0f05f](https://github.com/dsebastien/obsidian-ai-editor/commit/3e0f05fd7a4327e4e3bd3c111c422a1285ad53d8))
* **review:** rebase the triage cursor onto live anchors ([8ec4ce8](https://github.com/dsebastien/obsidian-ai-editor/commit/8ec4ce83d7cf41a8712cf7cf1d2e921695aca2e5))
* **review:** report disabled and deleted instruction editors as typed skips ([6d44d08](https://github.com/dsebastien/obsidian-ai-editor/commit/6d44d0846c19641d9fe87e383c83309b429d9c73))
* **rules,review:** one note-scoped answer to "who would review this note" ([7de8c4c](https://github.com/dsebastien/obsidian-ai-editor/commit/7de8c4cb26034094f8ed0121e8d20f522c4b9336))
* **rules:** detect the Starter Kit, and pick note types from its list ([e1a2e57](https://github.com/dsebastien/obsidian-ai-editor/commit/e1a2e579c4acec6f2e13f31767f021028a324bc6))
* **rules:** the Starter Kit is only mentioned when it is there ([6c4321a](https://github.com/dsebastien/obsidian-ai-editor/commit/6c4321a160292b23f705c6f930fccbad5839535e))
* **settings:** an export never carries CLI launch consent ([06cdbf9](https://github.com/dsebastien/obsidian-ai-editor/commit/06cdbf966ec58a937af29f5e389a1cec26b5369f))
* **settings:** an import is a destination, and a cap must not orphan a reference ([06be0ff](https://github.com/dsebastien/obsidian-ai-editor/commit/06be0ff615219eedbd6e7e6f780177c05a59ca7a))
* **settings:** repair duplicate entity ids and settings-tab paper cuts ([c3499d2](https://github.com/dsebastien/obsidian-ai-editor/commit/c3499d244e5884e74eeff49a186edeb49a79aea6)), closes [#12](https://github.com/dsebastien/obsidian-ai-editor/issues/12)
* **settings:** the CLI surfaces stop overstating what they know ([fa5da22](https://github.com/dsebastien/obsidian-ai-editor/commit/fa5da22d479b785c97fa10226a761c77f40b9f69))
* **settings:** the seeded panel's name is sentence case like everything else ([ece2e68](https://github.com/dsebastien/obsidian-ai-editor/commit/ece2e6866e2bd091f1832c410ddb8b481391cd39))
* **settings:** the two Behavior toggles that promised things and did nothing ([0b4d198](https://github.com/dsebastien/obsidian-ai-editor/commit/0b4d19815486bb8e7bd5406fc0349664fb085d4a))
* **settings:** the wizard saves what it validated, and refuses the case it says it refuses ([ba85644](https://github.com/dsebastien/obsidian-ai-editor/commit/ba856440de0e520aec4d17936685b98ee54ce1a2))
* **styles:** the stylesheet stops styling the whole app ([c4027bd](https://github.com/dsebastien/obsidian-ai-editor/commit/c4027bd013163391522e7709fdc4e63a6ea3debf))
* **transport:** name CORS in the opaque fetch network failure message ([fa066a4](https://github.com/dsebastien/obsidian-ai-editor/commit/fa066a470375866044d537bc7140ff7c1f441afe))
* **ui:** a renamed folder no longer strands a run under every note in it ([d35d485](https://github.com/dsebastien/obsidian-ai-editor/commit/d35d485cb12f62f75900f60306858000964d3caf))
* **ui:** accessible names for the filter, the thread and the rail button ([a6ad3a9](https://github.com/dsebastien/obsidian-ai-editor/commit/a6ad3a9d76eaa348e157ce634cb0886a45d515a0))
* **ui:** ask-editor submit guards note switch and collapsed-capture scope ([5a0b1c3](https://github.com/dsebastien/obsidian-ai-editor/commit/5a0b1c3ef5887eba603f6a77c287c2c9e94c8892))
* **ui:** card-on-jump survives the reveal scroll ([70e153a](https://github.com/dsebastien/obsidian-ai-editor/commit/70e153acfb655c5f5c3386be8b4e88a1c7bd85f0))
* **ui:** isolate finding accept from adjacent undo history ([045986c](https://github.com/dsebastien/obsidian-ai-editor/commit/045986c5a14906cb65026e60853f13158b8fd5b5))
* **ui:** panel bulk actions act on the file the panel shows ([7144183](https://github.com/dsebastien/obsidian-ai-editor/commit/7144183a1d009063789b7ae38633c10458fac991))
* **ui:** push-back locks the card immediately and never loses the message ([cbec624](https://github.com/dsebastien/obsidian-ai-editor/commit/cbec6245655907f38b7c5e7a2611b08b0b4cbb40))
* **ui:** sentence case stops being an opinion and becomes a rule ([7b76f22](https://github.com/dsebastien/obsidian-ai-editor/commit/7b76f22b693e9c8a1fb61153c9b1ad4f059ba7ba))
* **ui:** status-bar fallback, file lifecycle cleanup, timer and card guards ([f11180d](https://github.com/dsebastien/obsidian-ai-editor/commit/f11180d0814a7dd6f64692b3218bc539e9a82b5b))
* **ui:** the panel is called AI Editor Review everywhere ([2a0a741](https://github.com/dsebastien/obsidian-ai-editor/commit/2a0a74141743d6f50a6720ef36ac9ea4371beb20))
* **ui:** the two asks stop being hidden by a rule they override ([0b62197](https://github.com/dsebastien/obsidian-ai-editor/commit/0b6219722c8ea88a554ddd55ac9c3de5e3d899aa))
* **ui:** the two strings the panel rename missed ([2f7337a](https://github.com/dsebastien/obsidian-ai-editor/commit/2f7337a21b66bdf3637f03706838d3f342c34603))
* **ui:** the verdict reaches the rail's accessible name, cards say which panel, and the fan-out prices itself ([49cd9f3](https://github.com/dsebastien/obsidian-ai-editor/commit/49cd9f38ee6bbc9e2b9d8b274ee7d46efd478d21)), closes [#11](https://github.com/dsebastien/obsidian-ai-editor/issues/11)
* **ui:** transform preview survives note-switch loads and isolates accept undo ([b100e6e](https://github.com/dsebastien/obsidian-ai-editor/commit/b100e6e03dd0385e25d8df72d336bdd3e01c32a6))
* **ui:** user-facing names say AI Editor, and the wizard gets its spacing ([d53511e](https://github.com/dsebastien/obsidian-ai-editor/commit/d53511e52fa7130b895aab0c079902f8a89a6824))
* **ui:** verdict pills say what the verdict means, not the wire token ([298e02e](https://github.com/dsebastien/obsidian-ai-editor/commit/298e02ee42042dfb8e64d361ca32f6d89a1116b4))
* **ui:** wider finding card and live-view fallback for panel binding ([c1b83b5](https://github.com/dsebastien/obsidian-ai-editor/commit/c1b83b5587ae33c7067f718e416f072dbdb2b259))
* **whats-new:** the unload path stops detaching the tab's leaves ([cbe4b8d](https://github.com/dsebastien/obsidian-ai-editor/commit/cbe4b8d59d4cb5e2420379a5c79e2eb6189244c8))

### Performance Improvements

* **anchoring:** one normalization pass per document, not per quote ([17ae9ad](https://github.com/dsebastien/obsidian-ai-editor/commit/17ae9ada340fe83fde910a8d489d203c4c6abe1d))
* **context:** one view of the vault per run, not one per editor ([dce515a](https://github.com/dsebastien/obsidian-ai-editor/commit/dce515a112a569d941519386a885f017c457f752))
* **diff:** a large rewrite gets a real diff, not a before/after ([a15973e](https://github.com/dsebastien/obsidian-ai-editor/commit/a15973e6476cc8b67f734f83ff57df10405a4550))
* **ui:** the highlights are capped, and the panel says by how much ([f560297](https://github.com/dsebastien/obsidian-ai-editor/commit/f5602978d7c9151b56aa2f20221185822ca8e359))










