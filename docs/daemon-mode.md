---
title: Daemon mode
nav_order: 10
---

# Daemon mode

By default nothing runs on its own: reviews start when you ask for one. **Daemon mode** changes that for a note you are editing — your editors watch your edits and refresh their recommendations after you pause.

**Daemon mode is per note.** Every note starts with it **off** when you open it — even if it is on for another open note — and turning it on covers that note only, for as long as it stays open. Closing the note turns it off again; nothing is remembered. Two ways to flip it for the note you are on:

- **The toggle above the Review button** in the [persona rail](usage.md#the-persona-rail). It shows the note's current mode (hollow = off, filled and accented = on) and pulses while a refresh is armed for it.
- **The command AI Editor: Toggle daemon mode for the current note**, for a hotkey.

Both report the new state, and on the way on they repeat what that state costs.

## Always on

If you want daemon mode on everywhere without flipping it per note, enable **Settings → AI Editor → Behavior → Daemon → Enable automatically for every note** (off by default). Every note then starts with daemon mode already on the moment you open it; the per-note toggle still works the other way and turns individual notes off for as long as they stay open. If you had the old global daemon-mode setting on, this is what your setting became on upgrade — your automatic refreshes keep working.

## Cost first

**Every refresh calls your configured AI backends.** A long editing session on one note can trigger many refreshes. If you pay per token, keep the idle delay generous and prefer a cheap model for the editors you leave running.

This is the one deliberate exception to "nothing runs automatically", and turning it on — per note, or for every note in settings — _is_ the explicit permission for it.

## When a refresh happens

All of these must hold:

- daemon mode is on **for that note**;
- the note was **quiet** for the **idle delay** (default 3 seconds, range 1–600). Quiet means no editing — typing, moving the cursor or selecting text restarts the clock. Triaging findings does **not**: accepting, dismissing, scrolling the review panel or using a card leaves the clock running, so a re-review lands shortly after you stop typing even while you work through the findings;
- the note is reviewable — not [excluded](privacy-and-security.md), not switched off by a [rule](rules.md), and at least one editor can review it;
- **its text actually changed** since the last review — moving the cursor around is not an edit;
- no review is already running for it. Edits made during a run coalesce into a single refresh once the run finishes.

Notes above the **size warning threshold** are silently skipped: daemon mode never interrupts you with a dialog.

## Hiding findings pauses it for that note

The rail's findings-visibility toggle ([Review a note](usage.md#the-persona-rail)) hides every finding annotation in a note — and while they are hidden, the daemon does not refresh that note: paying for results you asked not to see would be the worst version of the cost story. The note's daemon mode stays on and other daemon-enabled notes keep refreshing. Showing the findings again resumes the note, and a refresh arms if the text changed while they were hidden.

## A refresh never wipes your triage

The findings you are working through stay on screen — dimmed — while a refresh runs, and your decisions carry across it: dismissed findings stay dismissed, unchanged findings keep their identity and thread, and a refresh that fails leaves everything exactly as it was. See [Review a note](usage.md#start-a-review).

## Which editors run

A refresh reuses the editors of the note's **previous review** — or every enabled editor when the note has never been reviewed. The set is checked against your settings **when the refresh fires**, not when it was scheduled: an editor you [disabled](editors.md#disabling-an-editor) since that review is left out, even if it took part last time. It never overrides you: summon, cancel and retry always win, and an explicit review replaces whatever the daemon was going to do.

## Seeing it

While a refresh is armed for the note you are on, the daemon toggle above the Review button pulses. It is the same control that turns the mode on and off, so the state and the switch are never in two places — and with reduced motion enabled it is dimmed rather than animated.

## It turns itself off when refreshes keep failing

After three automatic refreshes in a row fail completely (a dead API key, an exhausted quota, an unreachable server), daemon mode switches itself off — for every note, and the **Enable automatically for every note** setting is turned off too if it was on — and tells you why in a notice that stays until you dismiss it. Unattended refreshes against a broken backend would silently bill every attempt — so the loop stops, while summoning a review manually keeps working (that is also how you check the problem is fixed). Turning it back on (per note, or in settings) is the "try again".

## Turning it off

Flip the rail toggle, run **AI Editor: Toggle daemon mode for the current note**, or just close the note — the per-note mode never survives the note. Turning **Enable automatically for every note** off in settings turns the daemon off everywhere at once, including notes you had switched on by hand. Anything already in flight finishes; nothing new is armed.

## Next

- [Review a note](usage.md)
- [Binding rules](rules.md) — switch the plugin off for parts of the vault instead
- [Configuration reference](configuration.md)
