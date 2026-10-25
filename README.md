# Herdr Navigator

Keeps VS Code's Explorer and Source Control on the folder of the pane you have focused in [herdr](https://herdr.dev).

## Features

- Follows the working directory of the focused herdr pane when you change space, tab or pane.
- Follows a `cd` in the focused pane.
- Snaps to the Git repository root by default, so moving between subfolders of one repository changes nothing.
- Relaunches herdr when VS Code restores a navigator window.
- Returns herdr's panes to the folders their shells were in after a herdr server restart.
- Needs no configuration on Windows, macOS or Linux.
- With the optional herdr plugin, an "Open in VS Code" action jumps from herdr to this extension. See [Open in VS Code](https://github.com/ZenderX/herdr-vscode-navigator/blob/main/docs/open-in-vscode.md).

## Requirements

- VS Code 1.142 or newer.
- herdr 0.9.5 or newer, running in the integrated terminal. The extension was developed against herdr 0.9.5 and does not enforce a minimum version.
- A local window. Remote windows (SSH, WSL, containers) and untrusted workspaces are not supported.

## Installation

Search for "Herdr Navigator" in the Extensions view, or run:

```sh
code --install-extension z3nder.herdr-navigator
```

## How it works

Start herdr in the integrated terminal. The window then follows the folder of whichever pane herdr focuses.

`herdrNavigator.followMode` sets how the window switches folders.

| Mode | Behavior |
|---|---|
| `workspace` (default) | The first switch reloads the window once and converts it into a saved navigator workspace. It holds an empty folder owned by the extension and the followed folder. Later switches replace the followed folder in place, with no reload. |
| `folder` | The followed folder becomes the window's only folder. Every switch reloads the window and closes the integrated terminal, including the herdr client. The herdr session keeps running. |

Only the window that hosts herdr follows automatically. "Herdr: Follow Focused Pane Now" works in any window.

The status bar item shows the followed folder, with an open eye when auto-follow is on and a dimmed closed eye when it is off. Click it to launch herdr in an editor tab when herdr is not running in this window, or to toggle auto-follow when it is. When herdr is not installed, the item reads "not installed" and a click opens the [herdr install page](https://herdr.dev/docs/install/).

herdr restores its own panes after a restart; the extension never edits herdr's session state.

herdr 0.9.5 restores each pane in the folder it was spawned in, not the one its shell was in ([herdr issue #5199](https://github.com/herdrdev/herdr/issues/5199)). While the navigator window is connected to herdr, the extension records each pane's live folder whenever herdr sends an event (a pane, tab or space change, a focus change, a connect), even when herdr runs in another window or terminal; it does not poll. For Git Bash on Windows it reads the folder from the shell process itself, so no shell configuration is needed. After a herdr server restart it types `cd '<folder>'` into idle restored shells (no agent, no running program) whose folder differs from the record and whose spawn folder, read from herdr before and after the restart, is the same, then logs one `cwd-return:` line in the output channel. This workaround will be removed once herdr restores pane folders itself.

## Optional herdr plugin

A separate, optional [herdr plugin](https://github.com/ZenderX/herdr-vscode-navigator/blob/main/plugin/README.md) restores the last focused space when herdr comes back after a crash, forced kill or reboot. The extension does not depend on it, but when the plugin is installed and enabled the extension leaves re-focusing after a launch to it. Install it with `herdr plugin install ZenderX/herdr-vscode-navigator/plugin`, or click the small plug hint directly to the right of the herdr status bar item (the auto-follow toggle) that appears while the plugin is missing or disabled; the hint can be hidden for good.

The plugin also puts each restored pane back in the folder it was last in, working around [herdr issue #5199](https://github.com/herdrdev/herdr/issues/5199), for herdr used on its own as well; see the [plugin README](https://github.com/ZenderX/herdr-vscode-navigator/blob/main/plugin/README.md#return-panes-to-their-live-folders). Without the plugin the extension returns the panes by itself (see above); when the plugin is installed and enabled, the extension leaves this to the plugin and only logs `cwd-return: deferred to herdr plugin`.

## Commands

| Command | Title | Key |
|---|---|---|
| `herdrNavigator.followNow` | Herdr: Follow Focused Pane Now | `Ctrl+K Ctrl+Alt+H` (`Cmd+K Cmd+Alt+H` on macOS) |
| `herdrNavigator.toggleAutoFollow` | Herdr: Toggle Auto-Follow | none |
| `herdrNavigator.launchHerdr` | Herdr: Launch Herdr | none |
| `herdrNavigator.reconnect` | Herdr: Reconnect | none |
| `herdrNavigator.showDiagnostics` | Herdr Navigator: Show Diagnostics | none |

The key binding is a chord because VS Code handles chords even while the herdr terminal has focus. A single key would go to the shell.

## Settings

| Setting | Default | Description |
|---|---|---|
| `herdrNavigator.autoFollow` | `true` | Follow herdr focus changes automatically. |
| `herdrNavigator.followMode` | `workspace` | `workspace` or `folder`, as described above. |
| `herdrNavigator.followGitRoot` | `true` | Follow the Git repository root instead of the exact directory. |
| `herdrNavigator.autoLaunch` | `true` | Relaunch herdr when VS Code restores a navigator window in which herdr was running. |
| `herdrNavigator.cwdSource` | `auto` | Which pane directory to follow: `auto`, `pane` or `foreground`. |
| `herdrNavigator.liveCwdProbe` | `true` | Read the live directory of the pane's shell process. |
| `herdrNavigator.cwdPollMs` | `1000` | Milliseconds between checks for a `cd`. Values from 1 to 249 are raised to 250. `0` disables the check. |
| `herdrNavigator.debounceMs` | `150` | Milliseconds to coalesce bursts of focus events. |
| `herdrNavigator.socketPath` | `""` | herdr socket path. Empty uses `HERDR_SOCKET_PATH`, then the default location. |
| `herdrNavigator.gitBashPath` | `""` | Windows only. Path to Git for Windows' `usr\bin\bash.exe`. Empty auto-detects. |

## Known limitations

- Focus changes are followed at once. A `cd` inside the focused pane is followed when herdr reports it, which Git Bash's stock prompt does through the terminal title. A prompt that sets no title (starship, a custom `PS1`) fires no event on `cd`, so that `cd` is followed at the next focus, pane or tab change.
- herdr runs one server per user, so every window that hosts herdr follows the same focus.
- In `workspace` mode the empty folder owned by the extension appears as an extra root.
- Returning panes runs only from the navigator window, and only for a server whose panes that window recorded while connected to it. A restored Git Bash pane is returned as soon as its shell process exists, with no wait for a prompt; herdr itself restores PowerShell panes in their live folder. A pane not ready within 20 seconds (Git Bash: its shell process cannot be found yet; other shells: no first prompt yet) is skipped as `not-ready`. A restart while VS Code is closed is caught on the next start, because the restored panes have new shell process ids; the first start after upgrading cannot tell yet, since the old record holds no process ids.
- herdr fires no event on a `cd` or on a server stop, so a pane's folder is recorded at the next event. A `cd` under a prompt that sets no title (starship, a custom `PS1`), followed by a server stop with no other event in between, is missed: the pane returns to its earlier recorded folder or stays in its spawn folder, never in another pane's folder. With the herdr plugin installed this applies to Git Bash's stock prompt too, because the plugin has no hook for title changes. The source fix is [herdr issue #5199](https://github.com/herdrdev/herdr/issues/5199).
- A pane is skipped as `unknown-spawn` when its spawn folder is unknown before or after the restart, and as `mismatch` when herdr gave its id to a pane spawned in a different folder; both stay in the folder herdr chose. Skip reasons, in order: `no-pane`, `same`, `unknown-spawn`, `mismatch`, `missing-folder`, `agent`, `not-ready`, `busy`, `error`. After upgrading from 0.1.3, let VS Code connect once to the running herdr server before its next restart, or every pane is skipped as `unknown-spawn` that time. Re-ordering spaces, tabs or panes is safe: herdr keeps pane ids.

## Troubleshooting

- Open the "Herdr Navigator" output channel (View > Output) for connection and switch logs. It contains local paths, so review it before sharing.
- Run "Herdr Navigator: Show Diagnostics" to see why a directory was chosen. The [smoke test notes](https://github.com/ZenderX/herdr-vscode-navigator/blob/main/docs/smoke-test.md) explain the log lines.
- Run "Herdr: Reconnect" after restarting herdr.
- If herdr uses a non-default socket, set `HERDR_SOCKET_PATH` before starting VS Code, or set `herdrNavigator.socketPath`.

## Privacy

The extension talks only to the local herdr socket. It sends read-only requests, plus `workspace.focus` when auto-launch restores the previously selected space, and `pane.send_input` only to type the guarded `cd '<folder>'` into idle shells herdr just restored (herdr issue #5199). It keeps its record of pane folders in VS Code's global storage. It collects no telemetry.

## Release notes

See the [changelog](https://github.com/ZenderX/herdr-vscode-navigator/blob/main/CHANGELOG.md). Report problems on the [issue tracker](https://github.com/ZenderX/herdr-vscode-navigator/issues). To check that a release matches its source, see [Verifying a release](https://github.com/ZenderX/herdr-vscode-navigator/blob/main/docs/verifying-releases.md).

## License

MIT. See [LICENSE](https://github.com/ZenderX/herdr-vscode-navigator/blob/main/LICENSE).
