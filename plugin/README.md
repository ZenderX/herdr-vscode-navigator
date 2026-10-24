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
- Spaces are matched by label, because space ids change across restarts. If the label no longer exists, or nothing was recorded yet, the hook does nothing.
- On Linux and macOS, labels containing a double quote or backslash are not recorded.

## Return panes to their live folders

herdr 0.9.5 restores each pane in the folder it was spawned in, not the folder its shell `cd`'d to ([herdr issue #5199](https://github.com/herdrdev/herdr/issues/5199)). This plugin works around that. Once herdr persists the live folder itself, this feature can be removed.

- A recorder (`scripts/cwd-track.sh`, `cwd-track.ps1` on Windows) runs in the background while the herdr server runs. Every 3 seconds it reads `herdr pane list` and saves each pane's live folder, one file per herdr session (`cwd-<session>.txt` in the plugin's state directory, `HERDR_PLUGIN_STATE_DIR`). New panes and spaces join the record by themselves and closed panes drop out. It exits on its own a few seconds after the server stops. A lock file (`cwd-track-<session>.pid`) keeps it to one recorder per session; if it dies on an error it writes `cwd-track-<session>.err`.
- At herdr startup, after the session is restored, the `startup` hook (`scripts/cwd-return.sh`, `cwd-return.ps1`) waits for each restored shell's first prompt, then types `cd '<folder>'` into a pane only when all of these hold:
  - the pane is in the record and its recorded folder still exists;
  - its current folder differs from the recorded one;
  - it runs no agent (no `agent` or `agent_session` in `herdr pane list`);
  - its shell has drawn its first prompt;
  - its shell runs no other program (on Windows, Git's `ps.exe` shows no child of the pane's bash; on Linux and macOS, the pane's foreground process group is the shell).

  It then starts the recorder. Nothing else is ever typed into a pane.
- Each startup writes one line to the plugin log, for example `cwd-return: 1 panes returned, 1 skipped (same=1)`. Read it with `herdr plugin log list`. Skip reasons are `no-pane`, `same`, `missing-folder`, `agent`, `not-ready`, `busy` and `run-failed`.
- It needs the shell to report its folder to herdr (OSC 7). herdr does this for its own PowerShell integration; for Git Bash add the [shell snippet](https://github.com/ZenderX/herdr-vscode-navigator/blob/main/docs/shell-integration.md). A shell that never reports its folder is never recorded, so the feature does nothing for it.

To get a herdr notification when panes were returned (off by default), put this line in `.env` in the plugin's config folder, which `herdr plugin config-dir zenderx.herdr-navigator` prints:

```
NOTIFY_RESTORE=1
```

Known limits:

- A shell whose first prompt takes longer than 20 seconds after startup is skipped as `not-ready`. Set `HERDR_NAV_READY_TIMEOUT` (whole seconds) in the environment that starts the herdr server to wait longer.
- A pane restored at a drive root such as `C:\` counts as ready at once, so its `cd` may be typed before the first prompt.
- Measured on Windows 11 with Git Bash only. The Linux and macOS scripts, including their busy check, were tested with replayed herdr output but never on a real Linux or macOS machine.

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

The Herdr Navigator extension does not need this plugin, but when it launches herdr it checks once (`herdr plugin list --json`) and, if this plugin is installed and enabled, leaves the re-focus to it; otherwise it re-focuses the remembered space itself. Deferring is safe because the plugin's startup hook runs once per herdr server start, after the session is restored, and not when a client attaches: either the server starts and the hook re-focuses, or it was already running and its focus is current. If your herdr version does not report whether a plugin is enabled, the extension defers whenever the plugin is installed. Install the plugin if you want the same behaviour for herdr on its own.
