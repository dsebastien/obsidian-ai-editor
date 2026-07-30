---
title: Tips and best practices
nav_order: 90
---

# Tips and best practices

## Start with two editors, not six

Six personas on every review is six requests, six sets of highlights, and a note that looks like a crime scene. Turn most of them off and add them back when you miss them. The Concision Editor plus one domain-appropriate critic gets you most of the value.

## Keep your prompts in the vault

Every prompt field takes vault note references, resolved fresh at run time. Put your Devil's Advocate's brief in a note, revise it while you work, and the next review uses the new version. No settings round trip, no copy-paste drift, and your assistant's configuration is versioned and searchable like everything else you write.

This is also how you keep one voice profile shared across every editor: `[[My Voice Profile]]`, with **Follow links** on, so the notes it links to come along.

## Write restraint rules, not just hunting lists

The difference between a useful persona and a noise generator is the "do not report" half of the prompt. Every seeded persona has one. Without it you get 40 findings on a good paragraph, and you stop reading them.

Add a severity ladder too: what _this_ persona considers a warning versus a suggestion versus information. Then the [severity filter](usage.md#severity-filter) actually means something.

## Match the model to the persona

A concision pass is a cheap, fast job. A Devil's Advocate reading a technical argument is not. Assign backends per editor rather than running everything through one expensive model — the per-editor **Backend** and **Model override** fields exist for exactly this.

## Preview before you spend

**Preview what will be sent** costs nothing and tells you the total character count, section by section, before a single token is spent. Run it once after configuring an editor with prompt notes and linked notes on — the number is usually larger than expected.

## Use selections

**Review selection** on the paragraph you are actually working on is faster, cheaper and more focused than reviewing a 4000-word note. Most of the time it is what you wanted.

## Triage from the keyboard

Assign hotkeys to **Next finding**, **Accept current finding** and **Dismiss current finding** in **Settings → Hotkeys**. The loop was designed for it: each step scrolls, rings the finding and opens its card, and accept/dismiss jump straight to the next one. Mouse triage on 30 findings is a chore; keyboard triage is a minute.

No default hotkeys ship, on purpose — this plugin does not get to squat on your keys.

## Argue with findings you disagree with

The reply box is not decoration. "This repetition is intentional" often makes the editor withdraw the finding, and when it does not, it sharpens the critique into something you can actually use. It costs one request and it is the fastest way to discover that a persona prompt needs a restraint rule.

## Push back once, then fix the prompt

If you are arguing with the same finding on every note, the prompt is wrong, not the model. Add the exception to the persona note. That is one edit against an unbounded number of future arguments.

## Use rules instead of turning the plugin on and off

A **Disable plugin** rule on your journal folder, and a panel assigned to your blog folder, beats remembering which mode you are in. See [Binding rules](rules.md).

Use a **privacy exclusion** instead when the content must never leave the vault at all — a rule only hides the plugin's surfaces.

## Be deliberate about daemon mode

It is genuinely nice on a piece you are actively drafting and genuinely expensive on a long editing session. If you use it, raise the idle delay well above the default, and give the daemon-active editors a cheap model.

## Park questions instead of breaking flow

When you notice a doubt mid-sentence, do not stop to investigate: select the passage, **Ask for comments**, and keep writing. The answer will be waiting in the margin. That is the whole point of the feature, and it only works if you use it _instead of_ stopping.

## Resolve rather than delete comments

**Resolve** keeps the record, so the same question does not get asked again three drafts later. **Delete** is for questions that turned out to be wrong, not for questions that were answered.

## Export your configuration

Once you have personas you like, **Behavior → Import & export → Export…** produces a keyless JSON file. It is safe to keep in the vault, safe to commit, and it is how you carry your setup to another machine or another vault. Check the dialog's warnings first if you use a custom base URL or an extra request body.

## Rotate keys you have synced

If your vault syncs, your API keys sync with it. That is not a reason to avoid the plugin; it is a reason to use minimal-scope keys and rotate them on the same schedule you rotate anything else. See [Privacy and security](privacy-and-security.md#where-api-keys-live).

## Read the seeded prompts before writing your own

They are long on purpose and every one of them is editable. The fastest way to a good persona is to copy the seeded one closest to what you want and change its mandate.
