# Herdr Navigator

Pairs with Herdr Navigator for VS Code.

A small herdr plugin that focuses the space you last used when herdr starts again, puts each restored pane back in the folder it was last in, and adds an "Open in VS Code" action for the focused space.

herdr restores your spaces after a restart, but it only knows the focused space as of its last save. After a crash, a forced quit, or a reboot that can be an older space. This plugin records the focused space every time you switch and, once herdr has restored the session, focuses the recorded one.

It needs no configuration and has one optional setting. The only keystrokes it sends are `cd '<folder>'` into idle shells it just restored (see [Return panes to their live folders](#return-panes-to-their-live-folders)).

## Install

```
herdr plugin install ZenderX/herdr-vscode-navigator/plugin
```

For a local checkout:

```
herdr plugin link /path/to/herdr-vscode-navigator/plugin
herdr plugin unlink zenderx.herdr-navigator
```

## Requirements

- herdr 0.9.5 or newer.
- `sh` on Linux and macOS, Windows PowerShell on Windows. Nothing else.

## How it works

- On every `workspace.focused` event the plugin writes the focused space label to its state directory, one file per herdr session.
- In its `startup` hook it reads that file, looks the label up in `herdr workspace list`, and runs `herdr workspace focus` on the match.
- Spaces are matched by label, because after a restart a space id can belong to a different space. If the label no longer exists, or nothing was recorded yet, the hook does nothing.
- On Linux and macOS, labels containing a double quote or backslash are not recorded.

## Return panes to their live folders

herdr 0.9.5 restores each pane in the folder it was spawned in, not the folder its shell `cd`'d to ([herdr issue #5199](https://github.com/herdrdev/herdr/issues/5199)). This plugin works around that. Once herdr persists the live folder itself, this feature can be removed.

- A short event hook (`scripts/cwd-record.sh`, `cwd-record.ps1` on Windows) records the folders. It runs when a pane, tab or space is focused, and when a pane is created, moved, closed or exits, and when a tab or space closes. Each run reads `herdr pane list` once and saves each pane's live folder, the folder it was spawned in and its shell pid, one file per herdr session (`cwd-<session>.txt` in the plugin's state directory, `HERDR_PLUGIN_STATE_DIR`, tab-separated lines `<pane>`, live folder, spawn folder, shell pid, plus on Windows herdr's own shell pid for a Git Bash pane), then exits. herdr's folder for a Windows Git Bash pane stays at the spawn folder, so for those panes the hook reads the live folder from the MSYS shell process (`/proc/<pid>/cwd`, through Git's own `ps.exe` and `bash.exe`), all panes in one Git Bash run; no shell configuration is needed. The spawn folder and pids come from one `herdr pane process-info` read for a pane that is new, whose shell changed, or whose line lacks them. After a herdr restart, existing lines are left as they were until `cwd-return` has decided (a server-run stamp in `cwd-<session>.instance`), so a restored pane never overwrites what the check compares against. New panes join the record and closed panes drop out. Nothing runs in the background and nothing polls. Overlapping runs take turns through a lock file (`cwd-<session>.txt.lock`, empty, left in place); a run that finds it taken leaves a request for the run holding it, which merges once more, so a burst of hooks collapses into a few merges instead of queueing (on Linux and macOS the request is a `cwd-<session>.txt.rerun` file). A failed run exits with an error that `herdr plugin log list` shows, and leaves the record as it was.
- At herdr startup, after the session is restored, the `startup` hook (`scripts/cwd-return.sh`, `cwd-return.ps1`) records the restored panes, waits until each restored shell is ready, then types `cd '<folder>'` into a pane only when all of these hold:
  - the pane is in the record and its recorded folder still exists;
  - its current folder differs from the recorded one;
  - the spawn folder recorded before the restart and the restored pane's spawn folder (its first reading, or else `herdr pane process-info`) are both known and the same; unknown on either side is `unknown-spawn`, different is `mismatch` (its id now belongs to another pane);
  - it runs no agent (no `agent` or `agent_session` in `herdr pane list`);
  - its shell is ready: a Windows Git Bash pane as soon as its MSYS shell process exists (typed input waits until the shell reads it, so no prompt is needed), any other shell once it has drawn its first prompt;
  - its shell runs no other program (on Windows, Git's `ps.exe` shows no child of the pane's bash; on Linux and macOS, the pane's foreground process group is the shell).

  For a Windows Git Bash pane, "current folder" is the MSYS shell's `/proc` folder, not herdr's. Once the returned panes are in their folders (up to 10 seconds), it records once more, storing each restored pane's spawn folder and new shell pid. Nothing else is ever typed into a pane.
- Each startup writes one line to the plugin log, for example `cwd-return: 1 panes returned, 2 skipped (same=1, unknown-spawn=1)`. Read it with `herdr plugin log list`. Skip reasons, in order, are `no-pane`, `same`, `unknown-spawn`, `mismatch`, `missing-folder`, `agent`, `not-ready`, `busy` and `run-failed`.
- Re-ordering spaces, tabs or panes before a restart is safe: herdr keeps pane ids across re-ordering and restores them as they were. The spawn-folder check above catches an id herdr hands to a different pane after a restart.
- No shell configuration is needed. Git Bash on Windows is read from its MSYS shell process. herdr's own PowerShell integration reports the folder, and herdr restores PowerShell panes in their live folder itself, as it does on Linux, so those panes are normally `same` and nothing is typed.

To get a herdr notification when panes were returned (off by default), put this line in `.env` in the plugin's config folder, which `herdr plugin config-dir zenderx.herdr-navigator` prints:

```
NOTIFY_RESTORE=1
```

Known limits:

- herdr has no hook for a folder change, a title change or a stop. A `cd` followed by a server stop, with no focus, create, move or close event in between, is recorded as of the last hook, whatever the prompt: that pane comes back in the folder recorded before, or stays where herdr put it (`mismatch` or its spawn folder), never in another pane's folder. The source fix is [herdr issue #5199](https://github.com/herdrdev/herdr/issues/5199).
- On Windows one hook run takes about 1 second, most of it PowerShell start-up, with 2 or with 14 Git Bash panes alike (measured 2026-10-24).
- A pane whose spawn folder the record does not hold yet (for example a line written before this version) is skipped as `unknown-spawn` until a hook has read it once.
- Paths compare case-insensitively on Windows; `cwd-return.sh` compares paths without `\` case-sensitively, so on macOS a case-only difference is a `mismatch` skip (the extension ignores case there).
- A pane that is not ready within 20 seconds after startup (Git Bash: no MSYS shell found yet; other shells: no first prompt yet) is skipped as `not-ready`. Set `HERDR_NAV_READY_TIMEOUT` (whole seconds) in the environment that starts the herdr server to wait longer.
- A non-Git-Bash pane restored at a drive root such as `C:\` counts as ready at once, so its `cd` may be typed before the first prompt.
- Measured on Windows 11 with Git Bash and Windows PowerShell 5.1, with no shell configuration (`scripts/cwd-restore-probe/run.mjs`, 2026-10-24). The Linux scripts passed every row live against herdr 0.9.5 in a Debian container (`scripts/cwd-restore-probe/linux/`, `dash` and `mawk`); there herdr restores the live folder itself, so restored panes are normally `same` and nothing is typed. macOS is untested: it needs a Mac or macOS CI runner with herdr installed, and its plugin state directory, process cwd behavior and hook parentage are unmeasured.

## Open in VS Code

The plugin adds an "Open in VS Code" action for the focused space. It opens a `vscode://z3nder.herdr-navigator/open` link, which the Herdr Navigator extension handles, and shows a herdr notification that you can detach the terminal with `prefix+q`. It never detaches or closes anything itself.

herdr manifests cannot ship keybindings, so bind it in your herdr config (use `zenderx.herdr-navigator.open-in-vscode-windows` on Windows), then run `herdr server reload-config`. It needs the Herdr Navigator extension installed in VS Code. Details are in the [Open in VS Code guide](https://github.com/ZenderX/herdr-vscode-navigator/blob/main/docs/open-in-vscode.md).

```toml
[[keys.command]]
key = "prefix+o"
type = "plugin_action"
command = "zenderx.herdr-navigator.open-in-vscode"
```

## Discovery popup

If you use VS Code but not the extension, the plugin may show a small popup offering to install it (Install, Learn more, Not now, Never). It shows at most three times (counted when it opens), at least 30 days apart, only while a herdr client is attached (the check shows a brief toast; if the popup then cannot open, at most one more toast that day), never once you answer Never or the extension is installed, and it installs nothing by itself. Details are in the [discovery guide](https://github.com/ZenderX/herdr-vscode-navigator/blob/main/docs/plugin-discovery.md).

## With the VS Code extension

The Herdr Navigator extension does not need this plugin, but when it launches herdr it checks once (`herdr plugin list --json`) and, if this plugin is installed and enabled, leaves the re-focus to it; otherwise it re-focuses the remembered space itself. Deferring is safe because the plugin's startup hook runs once per herdr server start, after the session is restored, and not when a client attaches: either the server starts and the hook re-focuses, or it was already running and its focus is current. If your herdr version does not report whether a plugin is enabled, the extension defers whenever the plugin is installed. Install the plugin if you want the same behaviour for herdr on its own. The same check decides who returns panes to their live folders: with this plugin installed and enabled the extension leaves it to the plugin; otherwise the extension does it from its navigator window.
