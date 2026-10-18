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

9. Close the window (choose Don't Save if prompted for the untitled workspace), then reopen the repository.
   Expected: the window opens as a single folder; once a terminal runs herdr, the extension detects hosting, reconnects, and the first follow converts the window to multi-root again. A second VS Code window with no herdr in its terminal never converts on its own.

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
