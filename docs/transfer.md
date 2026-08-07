---
title: Move settings between vaults
nav_order: 13
---

# Move settings between vaults

The editors, panels, actions, rules and voice profile you build are portable. **Settings → AI Editor → Behavior → Import & export.**

## Export

**Export…** lets you tick what to include — backends, editors, panels, actions, rules, voice profile — and writes it either to a JSON file inside your vault or to the clipboard. Sections you did not tick are absent from the file, not present and empty. An existing file is only overwritten after you confirm.

**API keys are never exported.** Every API backend leaves with an empty key field, and the stripping happens inside the export itself so no caller can forget.

Two fields can still hold a credential and are therefore **declared rather than blanked**, because blanking them would break the backend they configure:

- a **base URL** carrying userinfo or a `key=` / `token=` parameter;
- a non-empty **extra request body**.

The dialog names the backends concerned instead of telling you the file is safe to share. Check it before posting the file anywhere.

The destination path must stay inside the vault. A `.` or `..` segment is refused rather than normalized.

## Import

**Import…** takes a pasted document or a file from your vault — including a `data.json` copied straight out of another vault's plugin folder, which carries no format marker of its own.

Nothing is written until you confirm a summary that lists **what will be added, what will be adjusted, and what will be skipped with the reason**.

- **Everything is added**, never merged over what you have. Internal ids are regenerated, so importing the same file twice gives you two independent copies rather than a silent overwrite.
- **References inside the file are rewired** to the imported entities. A reference pointing outside the import survives only if that id already exists here — re-importing panels into the vault their member editors still live in works — and is otherwise cleared and reported.
- **Your voice profile is the one thing that gets replaced** rather than added. The summary says so before you confirm.
- **Anything that cannot come in is listed with its reason**: an entity this version does not accept, a panel with no member editors, an action verb you already bound, or a section already at its maximum. Section caps are applied _before_ references are rewired, so an entity that does not fit never leaves a dangling pointer behind.
- One invalid entity never drops its siblings.

### Imported backends arrive switched off

API keys are never imported either — even when the file carries one, so importing someone else's export cannot quietly bill their account.

But a stripped key protects nothing on its own: Ollama needs none, an OpenAI-compatible host takes whatever key is typed later, and an imported editor arrives enabled and review-capable, which makes it a participant in every review. So:

- imported API backends arrive **disabled**, and an adjustment line says so;
- the confirmation lists **the kind and the URL each one would send notes to**, plus whether it carries a custom request body;
- it states **how many imported editors would take part in every review**.

Enabling one means opening the Backends page, where its URL is in front of you.

**Imported CLI backends never carry consent** and always arrive off. You are asked again, about the executable that is actually on this machine. See [CLI backends](cli-backends.md).

## Syncing a vault instead

If your vault syncs, the plugin's `data.json` syncs with it — settings **and API keys**. That is convenient and it is a real exposure; see [Privacy and security](privacy-and-security.md#where-api-keys-live).

Margin comments live in a separate file that also syncs. A write that finds changes this session has not seen merges the two rather than reverting whatever another device parked.

## Next

- [Privacy and security](privacy-and-security.md)
- [Set up a backend](backends.md)
- [Configuration reference](configuration.md)
