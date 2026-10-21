# Smoke test

Manual procedure. Needs herdr 0.9.5 and two directories, `A` and `B`, that you can `cd` into.

1. Open this repository as a single folder in VS Code (File > Open Folder). Open an integrated terminal (Git Bash) and start `herdr`.
   Expected: the editor shows one root folder; herdr is running in the terminal.

2. Press F5 (Run Extension) to start an Extension Development Host, then repeat step 1 in that new window: open this repository as the folder, open a Git Bash terminal, start `herdr`.
   Expected: the status bar shows `herdr: ...` (or `herdr: disconnected` until connected; "Herdr Navigator" output channel shows a connection log).

3. In herdr, create two tabs whose panes sit in directories `A` and `B` (`cd` first, then open/switch so herdr reports the cwd). Switch to the tab in `A`.
   Expected: an information message says extensions restart once; extensions restart; the terminal keeps running; the Explorer then shows the original folder plus `A` as a second root.

4. Switch herdr to the tab in `B`.
   Expected: the second root changes from `A` to `B` in place within about a second; no restart, no reload, terminal still alive; the first root is unchanged.

5. Switch back to `A`, then focus the editor and run "Herdr: Toggle Auto-Follow" from the Command Palette. Switch herdr to `B`.
   Expected: auto-follow is now off; the second root stays on `A`; the status bar tooltip says auto-follow is off.

6. Click into the herdr terminal so it has focus and press `Ctrl+K Ctrl+Alt+H`.
   Expected: the second root changes to `B` even though the terminal had focus and auto-follow is off; no characters reach the shell.

7. Run "Herdr: Toggle Auto-Follow" again, then switch herdr tabs.
   Expected: auto-follow is on and the second root follows each tab switch.

8. Quit herdr, then run "Herdr: Reconnect" after restarting it.
   Expected: the status bar shows `herdr: disconnected` while herdr is down and returns to a folder name after reconnect.

9. Close the window (no save prompt: the navigator workspace is a saved file), then reopen the repository.
   Expected: the window opens as a single folder; once a terminal runs herdr, the extension detects hosting, reconnects, and the first follow converts the window to multi-root again. A second VS Code window with no herdr in its terminal never converts on its own.

## Window title

Install the packaged VSIX and run it in a normal window; never press F5 for these checks (no debug sessions).

1. Convert a window to a navigator window (steps 1 to 3 above).
   Expected: the title bar shows `herdr-navigation (Workspace)`, and the output channel has `window title: wrote ...`.

## Session restore

Needs herdr on PATH and `herdrNavigator.autoLaunch` on (default). Use the installed VSIX in a normal window, not F5.

1. In a navigator window, run herdr in an integrated terminal, select a space other than the first, and wait a few seconds so the extension sees it.
2. Quit VS Code fully (all windows), then relaunch it so it restores the window.
   Expected: a herdr tab in the editor area, no duplicate herdr tab, and the previously selected space focused (or, if herdr did not restore its session, a shell started in the focused herdr pane's last directory).
   Note: herdr's server keeps running in the background after VS Code quits, so relaunching usually re-attaches to the same spaces.
3. Negative: leave herdr with its detach key (`prefix+q`, see `herdr --default-config`), wait at least 15 seconds, quit VS Code, relaunch.
   Why: the detach is only seen by the client-exit poll (up to 2 s), then two hosting scans (each up to a few seconds on Windows) separated by a 5 s confirm. The output channel shows `hosting herdr: no` when the first rescan sees the detach; count the wait from then. Do not quit until the log shows `auto-launch: record herdrWasRunning=false (hostingLost herdr-exited)`; quitting sooner still counts as herdr running and the relaunch fires.
   Expected: no herdr launch; the log has `auto-launch: none ...` with reason `not-restored`.
4. Negative: set `herdrNavigator.autoLaunch` to `false`, repeat step 1 and 2.
   Expected: no herdr launch; the log has reason `disabled`.

Paste back these output channel lines:

- `auto-launch:` decision line (action and reason).
- `auto-launch: terminal seen <name> interacted=<bool> at +<ms>` lines (answers whether revived terminals exist at activation or arrive later).
- `auto-launch: record herdrWasRunning=` lines and `hosting herdr:` lines.
- `window title:` lines.
- Whether herdr restored its own session or started fresh.

## Session folder repair (isolated)

Steps 1 to 3 run against a scratch herdr session, never your live one. `scripts/session-restore-probe/repair-e2e.mjs` automates it.

Warnings:

- Pass `--session <scratch-name>` on every herdr command, including the stop command: `herdr session stop <scratch-name>`. A bare `herdr server stop` stops the live server.
- The `HERDR_SESSION` environment variable does not isolate herdr's `workspace`, `pane` and `api` CLI commands; they hit the live session unless `--session` is passed.
- The extension skips named sessions, so this procedure checks herdr's restore behaviour and the file edit, not the extension's own trigger.

1. Start the scratch session: `herdr --session scratch` in a terminal. Create a workspace, `cd C:\Users\me\proj` (or `/home/me/proj`) in its pane.
2. Stop it: `herdr session stop scratch`. When done, clean up with `herdr session delete scratch`.
3. Start it again with `herdr --session scratch`.
   Expected (the bug): the pane is back in the folder it was spawned in, not `proj`.
4. This step runs on the default session and stops your real herdr server; only do it when nothing in it needs to survive. For the extension itself, use a normal window with a disposable workspace: let the navigator host herdr, `cd` in a pane, stop herdr, then run "Herdr Navigator: Repair herdr session folders" and relaunch.
   Expected: the pane restores in the folder you `cd`'d to; the output channel lists the changes; a backup exists in the extension's global storage (newest five kept). Setting `herdrNavigator.repairSessionOnLaunch` to `false` and repeating restores herdr's own behaviour.

## Saved navigator workspace and the jump list

`scripts/jump-list-repro/run.ps1` runs scenarios A to D in an isolated VS Code (see its README); these are the manual equivalents. Needs herdr on PATH and the installed VSIX in a normal window, not F5. The navigator workspace is `navigator.code-workspace` in the extension's global storage, in the `anchor` folder.

1. Manual start (E). Open a folder `A` as a plain window with no earlier navigator session. Start `herdr` in its terminal with the focused pane in another directory `C`.
   Expected: log `auto-launch: convert-hosting folder=C`, one window reload, then the title shows the navigator and the log has `auto-launch: create herdr` (or `reuse`) with focus on `C`; the window's workspace file is `navigator.code-workspace` with folders `[anchor, C]`. Check `pending: reconciled after restart` appears (the pending takeover survived the reload).
2. Jump list (A). Quit VS Code fully while the navigator ran. Start it again by choosing folder `B` from the taskbar jump list (or `code B`).
   Expected: exactly one VS Code window, a navigator whose folders are `[anchor, B]`; log `auto-launch: convert-explicit` followed by `auto-launch: create herdr` with focus on `B`. No untitled workspace is created (the `Workspaces` folder of the user data directory stays empty).
3. No arguments (B). Quit, then start VS Code with no folder.
   Expected: the saved navigator window is restored and herdr is relaunched in it.
4. Second window (C). With the navigator running, open folder `A` in a new window.
   Expected: log `auto-launch: none navigator-alive`; the new window stays a plain folder window and does not reload.
5. Legacy migration (D). With the previous release's behaviour (or by converting a window with `updateWorkspaceFolders` in a probe), create an untitled `[anchor, folder]` workspace, quit, relaunch.
   Expected: log `auto-launch: legacy-untitled`, a message that the workspace is moving into a file; after Continue, VS Code asks once to save the old untitled workspace (choose Don't Save); the window reloads as the saved navigator and herdr starts in it.

## Diagnosing a follow with the log

1. Install the packaged VSIX (`npm run package`, then `code --install-extension herdr-navigator-0.1.0.vsix`) and reload the window.
2. Run "Herdr Navigator: Show Diagnostics" (`herdrNavigator.showDiagnostics`) from the Command Palette. It opens the "Herdr Navigator" output channel and prints the current workspace shape and the last line of each topic.
3. In a Git Bash pane inside herdr, `cd` to a directory different from where the pane started. Switch herdr to another tab and back so the pane is focused.
4. Read the output channel. Each follow cycle should produce these lines in order:
   1. `activated herdr-navigator <version> at <time>; workspace ...` (once per extension host start; a second one after a conversion marks the restart), then `settings: ...`.
   2. `herdr event ...` and `pane: id=... tab=... workspace=... cwd=... foreground_cwd=... terminal_title=...`.
   3. `target: <path> via <source> (...) probe=<n>ms failed=[...]`, where source is `probe`, `foreground_cwd` or `cwd`. The path must be the directory you `cd`'d to, not the spawn directory.
   4. `plan: ...` (the folder operations; a no-op plan means the folder is already followed).
   5. `mutation: folders before ...`, then `mutation: updateWorkspaceFolders(start=..., deleteCount=..., add=[...])`, then `mutation: updateWorkspaceFolders returned true|false`.
   6. `mutation: <change event>; folders after ...`. On the first conversion of a single-folder window the log instead ends after a warning that the extension host may restart, and the next `activated ...` line follows. `updateWorkspaceFolders rejected: ...` with a reason means VS Code returned false.
5. Expected result: the Explorer shows the target folder at index 1 or later and the anchor stays first.

If the source is `cwd` and the directory is stale, a `hint:` line appears. Then, in order:

- Make sure `herdrNavigator.liveCwdProbe` is `true` (default).
- On Windows, if Git Bash is installed somewhere unusual, set `herdrNavigator.gitBashPath` to its `usr\bin\bash.exe`. Empty means auto-detect. Check `failed=[...]` in the `target:` line for `Git Bash not found` or `not an MSYS process`.
- As a last resort add the optional snippet from `docs/shell-integration.md`.

A pane in native PowerShell reports `via cwd` correctly, because herdr injects its own shell integration there; the hint is then harmless.
