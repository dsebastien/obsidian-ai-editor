---
title: CLI backends
nav_order: 11
---

# CLI backends (Claude Code, Codex)

Read this page before enabling one.

A CLI backend does not call a remote API. It **runs a program on your computer**, with the content of your note on its standard input. That is the highest-risk thing this plugin does, so everything else about the feature follows from containing it.

If you are looking for driving the plugin _from_ a terminal instead, that is [The command line](command-line.md).

## What the plugin enforces

You do not have to take these on trust; they are how the code is written, in `src/app/services/backends/cli/`.

- **No shell.** The tool is started with an argument array, never a command line. There is no quoting rule to get wrong and no metacharacter to escape.
- **You name the exact binary.** An absolute path to an existing executable file. A bare name (`claude`) or a relative path is refused, because it would be resolved through `PATH` or the working directory — a writable directory ahead of the real one would silently change what runs.
- **Your note never appears in the arguments.** Standard input only. Arguments are visible to every process on the machine; notes are not.
- **A throwaway working directory**, created for the run with an unpredictable name and owner-only permissions, and deleted when the run ends. Never your vault, and deliberately not the plugin's own folder either — that lives inside the vault and syncs.
- **A minimal environment**, built from nothing: a home directory so the tool can find its own login, a `PATH` for its sub-tools, a locale, and a temporary directory redirected into the throwaway folder. Nothing else in Obsidian's environment reaches it, and **there is no setting that can widen the list**.
- **No session written to disk.** Claude Code runs with `--no-session-persistence`, Codex with `--ephemeral`, so the conversation is not saved and cannot be resumed. That covers the transcript; it is not a claim that the tool writes nothing at all.
- **No inherited MCP servers — for Claude Code.** `--strict-mcp-config` is passed without an MCP config, so none are loaded.
- **Every run ends with the process tree killed**, cancelled or not. A tool that exits 0 can leave a background helper running, so the tree is probed on every path. If something survives, the run is reported as **failed** rather than passed off as a success.
- **Output is capped** at 8 MB, and the plugin never shows you the tool's own error text — see [Limits worth knowing](#limits-worth-knowing).

## What the plugin does not bound

Said plainly, because the consent you are asked for is only meaningful if it is accurate.

- **The tool's own configuration is loaded.** Claude Code reads your `CLAUDE.md`, skills, plugins, hooks and `settings.json` — including any pre-approved permission rules in it, which `--permission-mode manual` does **not** override. Codex reads `~/.codex/config.toml`. Suppressing those would break subscription authentication or silently change which model answers, so the plugin does not try; what it can do is tell you.
- **Codex loads its own MCP servers.** Its `~/.codex/config.toml` is deliberately read — that is where your provider, endpoint and model live, and ignoring it would redirect the run away from the setup you tested — so any `[mcp_servers.*]` declared there is loaded too.
- **Claude Code has no read-only sandbox to run under.** Codex gets `--sandbox read-only`; there is no equivalent flag for Claude Code, so its containment here is the throwaway directory, the minimal environment, and the permission mode.

## The two consents

Both are asked for explicitly, both are recorded per backend, and both can be withdrawn.

1. **Allowed to run.** Enabling a CLI backend opens a dialog that states what will happen, names the exact file that will run, and says you are responsible for what that program does. Until you agree, the backend is **skipped by every review and every action**, however its enable toggle reads. An enabled backend that has not been allowed is not a running backend, and the Backends tab says so on its row.
2. **Tool and research mode.** A separate, stronger permission: the agent may read and write files and reach the network while it works. **Off by default.** Turning it on is its own dialog with its own wording. Turning it off later leaves the backend working, just without tools.

The second consent is offered only where the plugin can actually enforce the off position. Claude Code can be run with all tools disabled, so it gets the toggle. Codex cannot — running commands is how it answers at all — so instead of a toggle that would do nothing, its settings row says so and describes what is enforced anyway.

**Consent names an executable, not a backend.** If the path changes — you edit it, you import settings, or `data.json` syncs from another machine — the earlier agreement no longer applies and you are asked again about the program that is actually there. Imported settings never carry consent, and imported backends always arrive switched off.

## Setting one up

1. **Settings → AI Editor → Backends → Add backend** → **Claude Code (runs locally)** or **Codex (runs locally)**.
2. **Executable**: paste the full path, or select **Detect**. Detection walks a curated list of install locations — `~/.local/bin`, `~/.claude/local`, `~/.bun/bin`, `~/.volta/bin`, `~/.cargo/bin`, `/opt/homebrew/bin`, `/usr/local/bin`, `/usr/bin` — and only asks the filesystem whether something is there. **It never runs anything and never searches `PATH`.** On Windows it deliberately returns nothing, because every candidate there is a `.cmd` shim the boundary would refuse. If it finds nothing, run `which claude` or `which codex` in a terminal and paste what it prints.
3. Optionally set a **Default model**. Leave it empty to let the tool use its own current default.
4. **Timeout**: how long one run may take before the tool and everything it started are stopped. Default **300 seconds**, range 10–3600. Agents are much slower than a chat completion, which is why this is separate from the request timeout in the Behavior tab — and why raising _that_ one does nothing for a CLI backend.
5. **Test connection** runs one trivial review through the whole path — same executable, same temporary folder, same environment and timeout. It asks for the first consent before running, because running it _is_ launching the program.
6. Save, then switch the backend on. Assign it to an editor or a panel like any other backend.

## Limits worth knowing

- **Keep the tool current.** The invocation contract was verified against Claude Code **2.1.220**; older builds miss flags this plugin passes — 2.1.153, for example, rejects `--permission-mode manual` and exits with status 1 before doing anything. If a run fails immediately, check `claude --version` and run `claude update` first.
- **Windows**: both tools install as `.cmd` shims, which this plugin refuses to run — running one means running `cmd.exe`, which reintroduces exactly the quoting problems the no-shell rule avoids. Point the setting at a real `.exe` if you have one, or use an API backend.
- **No streaming.** A CLI run is read after the process ends, so findings appear all at once rather than trickling in.
- **Error messages are status-only — details are behind a click.** The message itself never carries the tool's own error text: an agent CLI echoes its configuration when it fails, and configuration contains credentials. When a run fails, **Show details** (on the failed editor's section, and on a failed Test connection) opens the captured output — exit status, error stream, output tail — with a caveat to check it before sharing, because that text is yours to read, not the plugin's to broadcast.

## Common refusals

| Message                                       | Fix                                                                 |
| --------------------------------------------- | ------------------------------------------------------------------- |
| _The executable path must be absolute_        | Use the full path. `~` is a shell expansion and no shell runs here. |
| _No file exists at …_                         | Check the path. `which claude` prints the real one.                 |
| _… is not executable by this user_            | `chmod +x`, or point at the real binary rather than a wrapper.      |
| _This file is a script, not a program_        | Windows `.cmd`/`.bat`/`.ps1` shim. Point at the `.exe`.             |
| _its CLI backend has not been allowed to run_ | Grant the first consent in the backend's settings row.              |

## Next

- [Set up a backend](backends.md)
- [Privacy and security](privacy-and-security.md)
- [Troubleshooting](troubleshooting.md)
