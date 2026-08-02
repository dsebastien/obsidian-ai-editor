---
title: Daemon mode
nav_order: 10
---

# Daemon mode

By default nothing runs on its own: reviews start when you ask for one. **Daemon mode** changes that for the notes you edit — your editors watch your edits and refresh their recommendations after you pause.

**Settings → AI Editor → Behavior → Daemon → Daemon mode.** Off by default.

Because it is a mode you flip by situation — on while drafting something you want watched, off the rest of the day — there are two faster ways in:

- **The toggle above the Review button** in the [persona rail](usage.md#the-persona-rail). It shows the current mode (hollow = off, filled and accented = on) and pulses while a refresh is armed for the note you are on.
- **The command AI Editor: Toggle daemon mode**, for a hotkey.

Both report the new state, and on the way on they repeat what that state costs.

## Cost first

**Every refresh calls your configured AI backends.** A long editing session on one note can trigger many refreshes. If you pay per token, keep the idle delay generous and prefer a cheap model for the editors you leave running.

This is the one deliberate exception to "nothing runs automatically", and turning the toggle on _is_ the explicit permission for it.

## When a refresh happens

All of these must hold:

- daemon mode is on;
- the note was **quiet** for the **idle delay** (default 3 seconds, range 1–600). Quiet means no interaction at all — typing, moving the cursor, selecting text, triaging findings, using the review panel or a card all restart the clock, so a refresh never fires into the middle of your work;
- the note is reviewable — not [excluded](privacy-and-security.md), not switched off by a [rule](rules.md), and at least one editor can review it;
- **its text actually changed** since the last review — moving the cursor around is not an edit;
- no review is already running for it. Edits made during a run coalesce into a single refresh once the run finishes.

Notes above the **size warning threshold** are silently skipped: daemon mode never interrupts you with a dialog.

## Hiding findings pauses it for that note

The rail's findings-visibility toggle ([Review a note](usage.md#the-persona-rail)) hides every finding annotation in a note — and while they are hidden, the daemon does not refresh that note: paying for results you asked not to see would be the worst version of the cost story. The global toggle stays on and other notes keep refreshing. Showing the findings again resumes the note, and a refresh arms if the text changed while they were hidden.

## A refresh never wipes your triage

The findings you are working through stay on screen — dimmed — while a refresh runs, and your decisions carry across it: dismissed findings stay dismissed, unchanged findings keep their identity and thread, and a refresh that fails leaves everything exactly as it was. See [Review a note](usage.md#start-a-review).

## Which editors run

A refresh reuses the editors of the note's **previous review** — or every enabled editor when the note has never been reviewed. It never overrides you: summon, cancel and retry always win, and an explicit review replaces whatever the daemon was going to do.

## Seeing it

While a refresh is armed for the note you are on, the daemon toggle above the Review button pulses. It is the same control that turns the mode on and off, so the state and the switch are never in two places — and with reduced motion enabled it is dimmed rather than animated.

## It turns itself off when refreshes keep failing

After three automatic refreshes in a row fail completely (a dead API key, an exhausted quota, an unreachable server), daemon mode switches itself off and tells you why in a notice that stays until you dismiss it. Unattended refreshes against a broken backend would silently bill every attempt — so the loop stops, while summoning a review manually keeps working (that is also how you check the problem is fixed). Turning the toggle back on is the "try again".

## Turning it off

Flip it in the rail, in settings, or run **AI Editor: Toggle daemon mode**. Anything already in flight finishes; nothing new is armed. The idle-delay field only appears while the mode is on, so the cost-sensitive toggle stays the single decision point.

## Next

- [Review a note](usage.md)
- [Binding rules](rules.md) — switch the plugin off for parts of the vault instead
- [Configuration reference](configuration.md)
