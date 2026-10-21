# Changelog

## Unreleased

- Session folder repair: herdr 0.9.5 restores panes in the folder they were spawned in, not the one they were in when it stopped. While this window hosts herdr, the extension records each pane's live folder; when auto-launch finds the herdr server stopped, it fixes pane `cwd` and workspace `identity_cwd` in herdr's `session.json` before starting herdr. It saves a backup first (newest five kept, under the extension's global storage) and leaves the file alone if the schema version is not 3 or anything does not match. Named sessions (`HERDR_SESSION`) and `HERDR_CONFIG_PATH` are skipped. A pane that moved into another repository keeps its old worktree grouping.
- New command `herdrNavigator.repairSessionFolders` (Herdr Navigator: Repair herdr session folders), for after a manual stop of herdr and before relaunching it.
- New setting `herdrNavigator.repairSessionOnLaunch` (default `true`): run the repair before auto-launch starts herdr.
- `scripts/session-restore-probe/` holds the isolated probes, including `repair-e2e.mjs`.

## v0.1.2 — 2026-10-20

- Rewrote the README.

## v0.1.1 — 2026-10-20

- Windows that do not host herdr scan their terminals' processes far less: herdr focus events trigger at most one scan per 30 s (was 5 s); a command starting in a terminal (shell integration) triggers one after about a second.
- The `cd` poll now asks herdr for the focused pane only (`pane.get`) instead of the full session snapshot each tick; it falls back to a snapshot when the focused pane is unknown, gone, or no longer focused.
- The navigator workspace is now a saved file, `navigator.code-workspace`, in the anchor folder under the extension's global storage, instead of an untitled workspace. VS Code always restores untitled workspaces at startup, so starting it with a folder (taskbar jump list, `code <folder>`) left a second restored navigator window; a saved workspace is restored only when VS Code starts without a folder.
- Opening a folder after a session in which the navigator ran, with no navigator window of the current VS Code launch alive, makes the window you opened the navigator: it converts to `[anchor, <folder>]` (one reload) and hosts herdr focused on that folder.
- Converting a single-folder window (first follow, or herdr started by hand) now reloads the window once; herdr's panes keep running and herdr is relaunched in the converted window.
- One-time migration: an existing untitled navigator workspace is moved to the saved file after a message from the extension; VS Code asks once to save the old untitled workspace (choose Don't Save).
- The navigator's session record is kept in `globalState` so a plain-folder window can read it; the takeover is skipped when `herdrNavigator.followMode` is `folder`.
- `scripts/jump-list-repro/` reproduces the jump-list launch in an isolated VS Code and herdr.

## v0.1.0 — 2026-10-19

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
