# Herdr Navigator

Keeps VS Code's Explorer and Source Control on the folder of the pane you have focused in [herdr](https://herdr.dev).

## Features

- Follows the working directory of the focused herdr pane when you change space, tab or pane.
- Follows a `cd` in the focused pane.
- Snaps to the Git repository root by default, so moving between subfolders of one repository changes nothing.
- Relaunches herdr when VS Code restores a navigator window.
- Needs no configuration on Windows, macOS or Linux.

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

The status bar item shows the followed folder. Click it to toggle auto-follow.

## Commands

| Command | Title | Key |
|---|---|---|
| `herdrNavigator.followNow` | Herdr: Follow Focused Pane Now | `Ctrl+K Ctrl+Alt+H` (`Cmd+K Cmd+Alt+H` on macOS) |
| `herdrNavigator.toggleAutoFollow` | Herdr: Toggle Auto-Follow | none |
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

- Focus changes work out of the box. Following a `cd` in Git Bash promptly depends on herdr reporting the new directory, which an [optional shell snippet](https://github.com/ZenderX/herdr-vscode-navigator/blob/main/docs/shell-integration.md) provides.
- herdr runs one server per user, so every window that hosts herdr follows the same focus.
- In `workspace` mode the empty folder owned by the extension appears as an extra root.

## Troubleshooting

- Open the "Herdr Navigator" output channel (View > Output) for connection and switch logs. It contains local paths, so review it before sharing.
- Run "Herdr Navigator: Show Diagnostics" to see why a directory was chosen. The [smoke test notes](https://github.com/ZenderX/herdr-vscode-navigator/blob/main/docs/smoke-test.md) explain the log lines.
- Run "Herdr: Reconnect" after restarting herdr.
- If herdr uses a non-default socket, set `HERDR_SOCKET_PATH` before starting VS Code, or set `herdrNavigator.socketPath`.

## Privacy

The extension talks only to the local herdr socket. It sends read-only requests, plus `workspace.focus` when auto-launch restores the previously selected space. It collects no telemetry.

## Release notes

See the [changelog](https://github.com/ZenderX/herdr-vscode-navigator/blob/main/CHANGELOG.md). Report problems on the [issue tracker](https://github.com/ZenderX/herdr-vscode-navigator/issues).

## License

MIT. See [LICENSE](https://github.com/ZenderX/herdr-vscode-navigator/blob/main/LICENSE).
