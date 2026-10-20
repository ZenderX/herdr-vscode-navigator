# Herdr Navigator

## What it does

Switches the VS Code workspace folder to the working directory of the pane focused in herdr. Change tabs, panes, or workspaces in herdr (running in the integrated terminal) and the editor's file tree follows. Two modes (`herdrNavigator.followMode`) trade reloads against Source Control clarity; see "How folders are switched".

## When it follows

- Focus changes in herdr: space, tab, or pane.
- A new space.
- A `cd` in the focused pane, when herdr knows the pane's directory: PowerShell via herdr's own integration, Git Bash via OSC 7 (see `docs/shell-integration.md`). herdr pushes no event for this, so the extension polls the focused pane every `herdrNavigator.cwdPollMs` milliseconds while this window hosts herdr and auto-follow is on.

A `cd` inside the same Git repository ends as a no-op when `herdrNavigator.followGitRoot` is on.

## Requirements

- VS Code 1.142 or newer.
- herdr 0.9.5 (protocol 22) running on Windows, Linux, or macOS, normally inside the integrated terminal.
- Socket: on Windows a named pipe under `%APPDATA%\herdr`; on Linux and macOS a Unix socket, default `~/.config/herdr/herdr.sock`. For named sessions set `HERDR_SOCKET_PATH` or `herdrNavigator.socketPath`.
- Local windows only (see Limitations).

## Install

From a VSIX (built with `npm run package`):

```
code --install-extension herdr-navigator-0.1.0.vsix
```

Or run `make install` to install the built VSIX, or `make reinstall` to rebuild and install.

Uninstall (reversible; reinstall any time):

```
code --uninstall-extension z3nder.herdr-navigator
```

To try it without installing, open this repository in VS Code and press F5 to start an Extension Development Host.

## How folders are switched

`herdrNavigator.followMode` picks how the window follows herdr.

| Mode | What happens | Cost |
|---|---|---|
| `workspace` (default) | The window becomes a multi-root workspace saved as a file (`navigator.code-workspace`): an extension-owned empty anchor folder plus the followed folder, replaced in place. One reload at the first conversion, none after it. | The anchor is a second root, so Source Control lists the repository of every root (each workspace folder contributes its own). |
| `folder` | The followed directory is opened as the window's single folder with VS Code's open-folder command in the same window. | Every switch reloads the window (median about 850 ms measured, runs 860/850/818 ms). VS Code closes the integrated terminal on each switch, including the herdr client running in it; run `herdr` again in a new terminal afterwards (the herdr session keeps running on its server). |

With `herdrNavigator.followGitRoot` (default on), the followed directory is first snapped to the root of its Git repository: the nearest ancestor (the directory itself included) that contains a `.git` entry, a directory in a normal clone or a file in a worktree or submodule. A pane in `repo/src/game` therefore follows `repo`, and moving between subfolders of the same repository changes nothing. Outside a repository the exact directory is followed. Turn the setting off to follow the exact directory.

In `folder` mode the first switch shows a modal confirmation (`FOLDER_SWITCH_NOTICE`): "Herdr Navigator follows herdr by opening each folder as this window's single folder, which reloads the window. VS Code closes the integrated terminal, including the herdr client running in it, on every switch; run herdr again afterwards (the herdr session keeps running). Set herdrNavigator.followMode to workspace to avoid reloads." Its only button is "Switch folder" (`FOLDER_SWITCH_CONFIRM`); Cancel or Escape abandons that switch and the confirmation reappears on the next one, until you accept it once, after which it is never shown again. The last followed path is kept in `globalState` under `herdrNavigator.lastFollowed` so the reload your own switch causes does not trigger another switch. If the target folder is already open in another VS Code window, VS Code focuses that window instead of reloading this one.

#### Source Control

- `folder` mode: only the opened folder's root repository appears, plus whatever VS Code's git settings add: `git.autoRepositoryDetection` (default `true`: subfolders of the opened folder and parent folders of open files), `git.repositoryScanMaxDepth` (default `1`: immediate child folders), `git.detectSubmodules` (default `true`, limit 10 via `git.detectSubmodulesLimit`) and `git.openRepositoryInParentFolders` (default `prompt`, for a folder without its own `.git` inside a repository). The window reload restarts the git extension, which rescans from scratch.
- `workspace` mode: each root contributes its own repository; the empty anchor has none, but the followed folder is a root next to it.
- The extension never writes any of these settings; change them yourself if you want different detection.

#### `workspace` mode details

- The anchor is always an extension-owned empty directory under the extension's global storage, never one of your folders. The `herdrNavigator.anchorFolder` setting was removed.
- The first switch in a single-folder window converts it to the saved navigator workspace (see below) by reopening the same window on it. That reloads the window once, which closes its integrated terminals. A herdr client running in one of them is closed with it, but herdr's panes and agents keep running on its server, and the extension relaunches herdr in the converted window. The extension saves its intent beforehand and resumes after the reload.
- Only the window that hosts herdr follows automatically. A window hosts herdr when a running `herdr.exe` is a descendant of one of its integrated-terminal shells, following Windows parent links plus Git Bash's own process graph from `ps -W` when Git for Windows is installed (Git Bash otherwise hides the link; the window is then treated as undetermined) (checked at startup, when terminals open or close, on Reconnect, before any conversion, about a second after a command starts in a terminal of a window that is not hosting herdr, and on herdr focus events while the window is not known to host herdr, so starting herdr in an already-open terminal is picked up without Reconnect; focus-event scans are limited to one per 30 s once the window is known to host or not, and one per 5 s while undetermined, and a hosting window re-verifies at most every 30 s, so quitting herdr stops auto-follow). Other windows stay connected but ignore auto-follow; `Follow Focused Pane Now` still works in any window. If detection fails, the first automatic follow of any kind (convert, add, replace, or remove) asks for confirmation; the answer is remembered for the window, including across the conversion. Escape declines until Reconnect; "Herdr: Reconnect" also clears a remembered decline so you are asked again.
- After reopening a single-folder window, the first follow converts it again.
- Later switches replace the second root in place with no restart.
- Closing the window never asks to save a workspace: it is already a file.

### Navigator workspace file and the jump list

The navigator workspace is `navigator.code-workspace`, stored in the anchor folder under the extension's global storage (`<globalStorage>/anchor/navigator.code-workspace`), never in one of your folders. Because it is a saved workspace, VS Code restores it like any other: relaunching VS Code with no arguments brings the navigator window back, and herdr is relaunched in it.

Earlier versions used an untitled workspace. VS Code always restores untitled workspaces at startup, even when you start it with a folder, so choosing a folder from the taskbar jump list (or running `code <folder>`) left a second, restored navigator window next to the one you asked for. Now, when you open a folder that way after a session in which the navigator ran, and no navigator window of this VS Code launch is running, the window you opened becomes the navigator: it is converted to `[anchor, <folder>]` (one reload) and hosts herdr focused on that folder. Opening a folder in a new window while the navigator is already running leaves that window a plain folder window.

If you have an existing untitled navigator workspace, the extension shows one message on the next start explaining that it is moving the workspace into a file. VS Code then asks once whether to save the old untitled workspace; choose Don't Save. This prompt comes from VS Code and cannot be avoided by the extension.

### Window title

In a navigator window the title bar reads `herdr-navigation (Workspace)` instead of `navigator (Workspace)`. The extension writes your effective `window.title` template (with `${rootName}` replaced) to the workspace settings of the navigator workspace only, which are stored in `navigator.code-workspace`; your user settings are never touched. A workspace-level `window.title` you set yourself is left alone.

### Auto-launch

`herdrNavigator.autoLaunch` (default on) relaunches herdr when VS Code restores a navigator window. It fires only when all of these hold:

- the window is a navigator window restored from a previous session;
- herdr was running in it when VS Code closed;
- nothing in this window hosts herdr now;
- `herdr` is on PATH.

It does not fire on the first conversion, after you leave herdr (detach, `prefix+q`) before closing, or when `herdr` is not on PATH (one `auto-launch:` log line, no popup). Leaving herdr takes roughly 10 seconds to register; quitting VS Code sooner still counts as herdr running. If the revived `herdr` terminal tab is present it is reused; otherwise a terminal is opened in the editor area using the default terminal profile, and `herdr` is typed into it. The last selected herdr space is then focused again by its label, and the terminal starts in the focused herdr pane's last directory, used only as a fallback when herdr does not restore its own session.

### Side effects

- The one-time conversion restarts the extension host, and the Claude Code VS Code extension restarts with it and picks a new IDE port (its lock file `~/.claude/ide/<port>.lock` changes, for example 41232 to 41117). Claude Code sessions already running in herdr panes may lose their IDE link until you run `/ide` in them; new terminals get the new port.
- Every in-place folder swap makes other extensions that watch workspace folders react. C# Dev Kit logs an unhandled `SolutionOpenError` ("Cannot find an instance of ... SolutionData service") on each swap. This is harmless noise from that extension. Workarounds: disable C# Dev Kit for the workspace, or try `"dotnet.defaultSolution": "disable"` (unverified that it suppresses this error).
- Confirmed: in-place swaps after the conversion do not restart the extension host.

## Commands

| Command | Default key | Purpose |
|---|---|---|
| Herdr: Follow Focused Pane Now (`herdrNavigator.followNow`) | `Ctrl+K Ctrl+Alt+H` (`Cmd+K Cmd+Alt+H` on macOS) | Follow the focused pane once, even if auto-follow is off |
| Herdr: Toggle Auto-Follow (`herdrNavigator.toggleAutoFollow`) | none | Flip `herdrNavigator.autoFollow` |
| Herdr: Reconnect (`herdrNavigator.reconnect`) | none | Reconnect to the herdr pipe |

The default binding is a two-step chord because chords are handled by VS Code even while the herdr terminal has focus; a single key would go to the shell. Rebind it in Keyboard Shortcuts. If you rebind to a non-chord key, also add `herdrNavigator.followNow` to `terminal.integrated.commandsToSkipShell` so the terminal does not swallow it.

A status bar item on the left shows `herdr: <folder>` or `herdr: disconnected`; `(not following)` means auto-follow is suppressed in this window (it does not host herdr, or detection failed and following is unconfirmed or declined); click it to toggle auto-follow.

## Settings

| Setting | Default | Description |
|---|---|---|
| `herdrNavigator.autoFollow` | `true` | Follow herdr focus changes and `cd` in the focused pane automatically |
| `herdrNavigator.socketPath` | `""` | herdr socket marker path. Empty uses `HERDR_SOCKET_PATH`, else `%APPDATA%\herdr\herdr.sock`. Honored only in user (local or remote) settings; workspace and folder values are ignored |
| `herdrNavigator.cwdSource` | `auto` | `auto` (foreground process cwd if known, else pane cwd), `pane`, or `foreground` |
| `herdrNavigator.followMode` | `workspace` | `workspace` (saved multi-root workspace, one reload at conversion) or `folder` (single folder, reloads the window and closes the terminal on every switch) |
| `herdrNavigator.followGitRoot` | `true` | Follow the Git repository root containing the focused pane's directory instead of the exact directory |
| `herdrNavigator.autoLaunch` | `true` | Relaunch herdr in an editor-area terminal when VS Code restores a navigator window in which herdr was running |
| `herdrNavigator.debounceMs` | `150` | Milliseconds to coalesce bursts of focus events |
| `herdrNavigator.cwdPollMs` | `1000` | Milliseconds between checks for a `cd` in the focused pane (minimum 250; `0` disables) |
| `herdrNavigator.liveCwdProbe` | `true` | Resolve the focused pane's live directory from its shell process |
| `herdrNavigator.gitBashPath` | `""` | Windows only: path to Git's `usr\bin\bash.exe` for the probe; empty auto-detects. Machine scope: set in user settings, not per workspace |

## How the live directory is found

No setup is needed. For the focused pane the extension asks herdr for the shell process and reads that process's current directory (`herdrNavigator.liveCwdProbe`, default on), falling back to herdr's `foreground_cwd`, then `cwd`.

| Platform and shell | How |
|---|---|
| Linux | `/proc/<pid>/cwd` |
| macOS | `lsof` on the shell pid |
| Windows, Git Bash | Git for Windows' MSYS `/proc`, with Git auto-detected (override with `herdrNavigator.gitBashPath`) |
| Windows, PowerShell | herdr's own shell integration keeps its `cwd` live |
| Windows, other native shells | herdr's reported cwd, which may be stale |

If the directory is stale, open "Herdr Navigator: Show Diagnostics" and read the `target:` line; see `docs/smoke-test.md` for what each log line means and `docs/shell-integration.md` for an optional shell snippet.

## Limitations

- A `cd` is followed only when herdr's reported `cwd`/`foreground_cwd` for the pane changes, so a Git Bash pane needs the OSC 7 snippet from `docs/shell-integration.md`.
- herdr is one server per user on a shared pipe, so every window that hosts herdr with auto-follow on follows the same herdr focus.
- On Windows, herdr's reported `cwd` may lag unless shell integration is active.
- Remote windows (SSH, WSL, containers) are unsupported.

## Troubleshooting

- Open the "Herdr Navigator" output channel (View > Output) for connection and switch logs. It contains local folder paths, so review it before pasting it publicly.
- Run `node scripts/herdr-probe.mjs --listen 5` to check the pipe and see raw herdr replies.
- If herdr uses a non-default socket, set `HERDR_SOCKET_PATH` before launching VS Code, or set `herdrNavigator.socketPath`.
- Run "Herdr: Reconnect" after restarting herdr.

## Privacy and safety

The extension talks only to the local herdr pipe and uses a whitelist of requests: `ping`, `session.snapshot`, `pane.get`, `pane.list`, `events.subscribe`, plus `workspace.focus`, sent only by auto-launch to re-select the space that was selected before VS Code closed. It never writes under `%APPDATA%\herdr`.
