# Changelog

## Unreleased

- New: panes return to their last live folder after herdr restarts, as a workaround for herdr issue #5199 (https://github.com/herdrdev/herdr/issues/5199), where herdr 0.9.5 restores each pane in its spawn folder. A detached recorder (`cwd-track.sh`, `cwd-track.ps1`) polls `herdr pane list` every 3 seconds and keeps `cwd-<session>.txt` in the plugin state directory, with one recorder per session (`cwd-track-<session>.pid`); it exits a few seconds after the server stops. A new `startup` hook (`cwd-return.sh`, `cwd-return.ps1`) waits for each restored shell's first prompt and runs `herdr pane run <pane> "cd '<folder>'"` only into idle shells (no agent, no running program, recorded folder exists and differs), then starts the recorder. It logs one line per startup, `cwd-return: N panes returned, M skipped (<reason>=<count>, ...)`. `NOTIFY_RESTORE=1` in `.env` under `herdr plugin config-dir zenderx.herdr-navigator` adds a notification (off by default). It needs a shell that reports its folder through OSC 7. Remove it once herdr persists the live folder.
- The plugin now sends keystrokes to panes: only the `cd` above, only into idle shells it just restored.
- New discovery popup that offers the Herdr Navigator VS Code extension when herdr was started from a VS Code terminal, or a new space's folder looks like a VS Code project, and the extension is not installed. It runs on `startup` and `workspace.created`; `tab.created` was measured but left out because it also fires for each new space's first tab. At most three appearances, 30 days apart; "Never" and an installed extension stop it. An appearance counts once the popup opens, answered or not. Before opening, a hook checks that a client is attached with `herdr notification show`, which shows a short "Herdr Navigator" toast, and opens nothing otherwise; if the open then fails, further triggers that day skip the check, so a failing open costs at most one toast a day. Arrow and function keys are ignored; a bare Esc is Not now. Nothing installs without a click in VS Code.
- The manifest description and the first line of this README now mention the pairing with Herdr Navigator for VS Code.
- New "Open in VS Code" action (`open-in-vscode`, and `open-in-vscode-windows` on Windows). It opens a link the Herdr Navigator extension handles and shows a notification about detaching with `prefix+q`.
- Renamed the plugin id from `zenderx.refocus-last-space` to `zenderx.herdr-navigator` and its display name to "Herdr Navigator". Unlink the old id and link or install the plugin again.

## 0.1.0

- First release: records the focused space and focuses it again after herdr restarts.
