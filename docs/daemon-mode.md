---
title: Daemon mode
nav_order: 10
---

# Daemon mode

By default nothing runs on its own: reviews start when you ask for one. **Daemon mode** changes that for the notes you edit — your editors watch your edits and refresh their recommendations after you pause.

**Settings → AI Editor → Behavior → Daemon → Daemon mode.** Off by default.

## Cost first

**Every refresh calls your configured AI backends.** A long editing session on one note can trigger many refreshes. If you pay per token, keep the idle delay generous and prefer a cheap model for the editors you leave running.

This is the one deliberate exception to "nothing runs automatically", and turning the toggle on _is_ the explicit permission for it.

## When a refresh happens

All of these must hold:

- daemon mode is on;
- you stopped editing the note for the **idle delay** (default 30 seconds, range 5–600; every edit restarts the clock);
- the note is reviewable — not [excluded](privacy-and-security.md), not switched off by a [rule](rules.md), and at least one editor can review it;
- **its text actually changed** since the last review — moving the cursor around is not an edit;
- no review is already running for it. Edits made during a run coalesce into a single refresh once the run finishes.

Notes above the **size warning threshold** are silently skipped: daemon mode never interrupts you with a dialog.

## Which editors run

A refresh reuses the editors of the note's **previous review** — or every enabled editor when the note has never been reviewed. It never overrides you: summon, cancel and retry always win, and an explicit review replaces whatever the daemon was going to do.

## Seeing it

While a refresh is armed for the note you are on, a small pulsing dot appears at the bottom of the [persona rail](usage.md#the-persona-rail). It is a reinforcement, not the only signal — with reduced motion enabled it is dimmed rather than animated.

## Turning it off

Flip the toggle. Anything already in flight finishes; nothing new is armed. The idle-delay field only appears while the mode is on, so the cost-sensitive toggle stays the single decision point.

## Next

- [Review a note](usage.md)
- [Binding rules](rules.md) — switch the plugin off for parts of the vault instead
- [Configuration reference](configuration.md)
