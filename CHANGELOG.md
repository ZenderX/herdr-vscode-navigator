# Changelog

## Unreleased

- Initial release: follows the focused herdr pane's working directory, so the editor's file tree tracks herdr's focus.
- Follow modes (`herdrNavigator.followMode`): `workspace` (default) keeps an extension-owned empty anchor folder plus a replaceable second root with no reloads after the first conversion; `folder` opens the followed directory as the window's single folder, which reloads the window on every switch.
- Git-root following (`herdrNavigator.followGitRoot`, default on): the followed directory snaps to the root of its Git repository; outside a repository the exact directory is followed.
- `cd` following: the extension polls the focused pane's directory every `herdrNavigator.cwdPollMs` milliseconds (default `1000`, minimum 250, `0` disables) while this window hosts herdr and auto-follow is on.
- Live cwd probe (`herdrNavigator.liveCwdProbe`, default on): resolves the focused pane's live directory from its shell process on Linux, macOS and Windows (Git Bash via `herdrNavigator.gitBashPath`).
- Commands: follow now, toggle auto-follow, reconnect, show diagnostics; two-step chord keybinding; status bar item.
- Settings: `autoFollow`, `socketPath`, `cwdSource`, `followMode`, `followGitRoot`, `debounceMs`, `cwdPollMs`, `liveCwdProbe`, `gitBashPath`.
- Cross-platform: Windows named pipe, and a Unix socket on Linux and macOS.
- Window title: a navigator window shows `herdr-navigation (Workspace)` instead of `Untitled (Workspace)`, written to the workspace-scope `window.title` only.
- Auto-launch (`herdrNavigator.autoLaunch`, default on): when VS Code restores a navigator window in which herdr was running, herdr is relaunched in an editor-area terminal (reusing the revived `herdr` tab) and the previously selected space is focused again via `workspace.focus`.
- `docs/shell-integration.md` recommends an optional OSC 7 snippet for Git Bash on Windows.
