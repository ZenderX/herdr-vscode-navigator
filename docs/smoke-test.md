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
   Expected: auto-follow is now off; the second root stays on `A`; the status bar tooltip says auto-follow is off, and the item shows a closed eye (`$(eye-closed)`) with dimmed text.

6. Click into the herdr terminal so it has focus and press `Ctrl+K Ctrl+Alt+H`.
   Expected: the second root changes to `B` even though the terminal had focus and auto-follow is off; no characters reach the shell.

7. Run "Herdr: Toggle Auto-Follow" again, then switch herdr tabs.
   Expected: auto-follow is on, the status bar item shows an open eye in the normal colour, and the second root follows each tab switch.

   Click launch: close the herdr tab in the window, wait for the tooltip to read "click to launch herdr", then click the status bar item.
   Expected: a new herdr tab opens in the editor area (one tab, even on a double click) and the tooltip changes to "click to toggle auto-follow".

8. Quit herdr, then run "Herdr: Reconnect" after restarting it.
   Expected: the status bar shows `herdr: disconnected` while herdr is down and returns to a folder name after reconnect.

9. Close the window (no save prompt: the navigator workspace is a saved file), then reopen the repository.
   Expected: the window opens as a single folder; once a terminal runs herdr, the extension detects hosting, reconnects, and the first follow converts the window to multi-root again. A second VS Code window with no herdr in its terminal never converts on its own.

## Window title

Install the packaged VSIX and run it in a normal window; never press F5 for these checks (no debug sessions).

1. Convert a window to a navigator window (steps 1 to 3 above).
   Expected: with the herdr terminal tab active, the title bar shows `herdr - <focused space label> - Visual Studio Code` (the workspace name is the space label, no `(Workspace)`), and the output channel has `window title: wrote ...`.
2. With `herdrNavigator.autoFollow` on, focus a second space in herdr.
   Expected: the title bar changes to `herdr - <second space label> - Visual Studio Code` without a window reload. The Explorer header still reads `NAVIGATOR (WORKSPACE)`; that is a VS Code limit.

## Plugin hint and herdr not installed

Use the installed VSIX in a normal window, not F5. Do not pass `--yes` to any install by hand.

1. Plugin hint. With herdr on PATH and the plugin absent or disabled (`herdr plugin list`), reload the window.
   Expected: a small second status bar item (plug icon) appears immediately to the right of the herdr status bar item (the auto-follow toggle), with no other item between them, with a tooltip naming the optional herdr plugin. No notification or dialog appears on its own.
2. Click the hint.
   Expected: a message of one or two sentences explains the plugin, with the buttons Install, Learn more and a hide-for-good choice. Learn more opens `https://github.com/ZenderX/herdr-vscode-navigator/blob/main/plugin/README.md` and the hint stays.
3. Choose Install.
   Expected: a visible terminal opens and runs `herdr plugin install ZenderX/herdr-vscode-navigator/plugin`, then waits for you to confirm herdr's preview. Nothing installs until you confirm.
   Precondition: the default branch of the public repo `ZenderX/herdr-vscode-navigator` must contain `plugin/` (it ships with the next release publish). Until then herdr fails with `The system cannot find the file specified. (os error 2)`.
4. Confirm the install, then close the terminal.
   Expected: the hint disappears. Repeat with the plugin disabled and the same steps; declining and closing the terminal leaves the hint visible.
5. Hide for good. Make the plugin absent again, click the hint and choose the hide option, then run "Developer: Reload Window".
   Expected: the hint disappears at once and stays hidden after the reload.
6. herdr not installed. Start VS Code with a PATH that omits herdr: on Windows, set `PATH` to exclude herdr's folder in a terminal and run `code` from it; on macOS and Linux, run `env PATH=/usr/bin:/bin code` from a shell. Make sure VS Code was fully quit first.
   Expected: no plugin hint appears, the main item reads `herdr: not installed` with a tooltip saying a click opens the install page.
7. Click the main item.
   Expected: the browser opens `https://herdr.dev/docs/install/`. After installing herdr, focusing the window again or clicking the item picks it up without a reload.

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
5. Restore without a duplicate. With a herdr editor tab open, close and reopen VS Code (ideally with the machine busy, or by running "Developer: Reload Window").
   Expected: exactly one herdr tab, running herdr, and no empty extra tab. If a revived tab arrives late the log shows `auto-launch: late revived herdr terminal never ran herdr; disposed`.

Paste back these output channel lines:

- `auto-launch:` decision line (action and reason).
- `auto-launch: terminal seen <name> interacted=<bool> at +<ms>` lines (answers whether revived terminals exist at activation or arrive later).
- `auto-launch: record herdrWasRunning=` lines and `hosting herdr:` lines.
- `window title:` lines.
- Whether herdr restored its own session or started fresh.

## Open in VS Code

Isolated: a scratch herdr session and a throwaway VS Code profile. Pass `--session <scratch>` on every herdr `workspace|pane|api|plugin` command; inside a herdr pane the inherited `HERDR_SOCKET_PATH` outranks `HERDR_SESSION`. Never run a bare `herdr server stop`.

Automated checks (run 2026-10-22, herdr 0.9.5, Windows 11):

1. Package the VSIX outside the repo: `npx vsce package --no-dependencies --out <tmp>/smoke.vsix`. Result: packaged, 64 files.
2. Install it into a throwaway profile: `code --user-data-dir <tmp>/ud --extensions-dir <tmp>/ext --install-extension <tmp>/smoke.vsix`. Result: `z3nder.herdr-navigator-0.1.3` installed. Pre-approve the URI dialog with `"extensions.confirmedUriHandlerExtensionIds": ["z3nder.herdr-navigator"]` in `<tmp>/ud/User/settings.json`.
3. Start the scratch session (`herdr --session <scratch> server`), then `herdr --session <scratch> workspace create --label second --no-focus`. Result: workspaces `w1` (focused) and `w2`; `herdr session list --json` listed `default` plus the scratch session.
4. Link the plugin (`make link-plugin`) and run `herdr --session <scratch> plugin action invoke open-in-vscode-windows --plugin zenderx.herdr-navigator` (use `open-in-vscode` on Linux and macOS). Result: the action ran and returned the action record. The OS opener sends the URI to the default VS Code install, so this only shows the URI was dispatched.
5. Cleanup: `herdr session stop <scratch>`, `herdr session delete <scratch>`, `herdr plugin unlink zenderx.herdr-navigator`, delete the plugin's state directory and the temp profile. Result: `herdr session list --json` listed only `default`; the plugin was gone from `herdr plugin list --json`.

Not completed: delivering `code --user-data-dir <tmp>/ud --extensions-dir <tmp>/ext --open-url "vscode://z3nder.herdr-navigator/open?space=w2&session=<scratch>"` and reading the `open request:` lines from `<tmp>/ud/logs/`. The isolated VS Code never started: its main process exited with `Code is currently being updated. Please wait for the update to complete before launching.` (the installer mutex was held by a pending update of the normal install). Redo this once VS Code has finished updating or been restarted; expect `open request: create` or `open request: reveal`, then `open request: focused space (attempt N)`, and `herdr --session <scratch> workspace list` showing `w2` focused.

Manual steps (cannot be scripted):

1. First use of the URI: VS Code asks whether to allow the extension to open the link. Choose Allow (or Allow and remember); declining must leave herdr untouched.
2. Invoke the action with VS Code closed: VS Code starts and a herdr terminal opens in the editor area on the requested space. On a machine with no `vscode://` handler, the plugin shows the notification "Could not open VS Code".
3. Not measured by a script:
   - (a) Press the keybinding configured per the Setup section of `docs/open-in-vscode.md` on a space and check the matching VS Code window opens or reveals the herdr terminal and focuses that space.
   - (b) Right-click a space and record whether "Open in VS Code" appears. Expected: absent in herdr 0.9.5. If it appears, update `docs/open-in-vscode.md`.
4. Run the invoke with a client attached in a real console and check the herdr notification text (without a client, `notification show` returns `"shown":false,"reason":"no_foreground_client"`; a second call within about 15 seconds returns `rate_limited`, which is not an error).
5. Repeat the URI delivery with VS Code Insiders (`vscode-insiders://`) if you use it.
6. Send a URI with an invalid space id (for example `space=a b`) and check the error message "Herdr Navigator ignored an invalid open request." appears and no terminal opens.

## Discovery popup

Isolated: a scratch herdr session, a scratch home and a scratch state directory. `make link-plugin` links the plugin globally, so while it is linked your live default session also runs the discovery hooks and can show the popup there; unlink it when done. Pass `--session <scratch>` on every herdr command. Never touch your real VS Code extensions folder or the plugin's real state directory.

1. In a VS Code integrated terminal, create an empty scratch home and an empty scratch state directory, and start the scratch server from that console with `HERDR_NAV_HOME=<scratch-home>` and `HERDR_NAV_STATE_DIR=<scratch-state>` set (`herdr --session <scratch> server`). The hooks and the popup inherit the server's environment, so they read and write only the scratch locations; `<scratch-state>\discovery.state` is the state file below. Link the plugin (`make link-plugin`).
2. Attach a client to the scratch session, then create a space (`herdr --session <scratch> workspace create --label demo`).
   Expected: a short "Herdr Navigator" toast, then the "Herdr Navigator for VS Code" popup, and `discovery.state` shows `shown=1` and today's `last_shown` with no `decision` value yet.
3. Type a few letters (including `q`) and an arrow key while the popup appears, then press `q` again after it has been up for a few seconds. Expected: the popup stays open and `discovery.state` is unchanged; only `i`, `l`, `n`, `x` or a bare Esc answer it. Then press `n`. Expected: `decision=not-now`, `shown=1` (the answer does not count again). Create another space: no popup (under 30 days).
4. Delete the state file and repeat with `l` (Marketplace page opens) and `i` (VS Code offers to install; decline). Each time the state ends as `shown=1`.
5. Delete the state file, create a space and close the popup without answering (stop and restart the scratch server, or `popup.close` over the API). Expected: `shown=1`, `decision` empty.
6. Delete the state file, repeat with `x`. Expected: `decision=never`; later spaces and a restart never show the popup.
7. Delete the state file, create the folder `z3nder.herdr-navigator-0.0.0` under `<scratch-home>\.vscode\extensions`, create a space. Expected: no popup and `decision=installed`.
8. Dry runs only: `HERDR_NAV_CLIENT=0` makes `scripts/discover.sh --dry-run` (or `discover.ps1 -DryRun`) print `skip:no-client`, and `HERDR_NAV_CLIENT=1` makes it print `show` when the other conditions hold. Never set `HERDR_NAV_CLIENT` on the server, since it skips the real client check.
9. Cleanup: `herdr session stop <scratch>`, `herdr session delete <scratch>`, `herdr plugin unlink zenderx.herdr-navigator`, delete the scratch home and state directory.

## Return panes to their live folders

Isolated and Windows only: `npm run compile`, then `node scripts/cwd-restore-probe/run.mjs`. It uses the throwaway session `navigator-restore-probe` with a scratch herdr config (`HERDR_CONFIG_PATH`) and a scratch `HOME` whose prompt emits no OSC 7 and sets no title, so it proves the feature with no shell configuration; your herdr config and shell startup files are neither read nor edited. Its scratch folders `demo app@v1` and `demo app@v1\sub dir` live under the temp directory. It links the plugin globally for about a minute and a half, so while it runs your live default session would also run the plugin's hooks if you create a space (`discover.*`) or its server restarts (`cwd-return`). It refuses to start if the session exists, the plugin is already linked or installed, or the state directory already holds files for that session. See `scripts/cwd-restore-probe/README.md`.

What it asserts (row names as in the script): every `cwd-record` hook run succeeded and `cwd-return`'s first start wrote the server-run stamp `cwd-navigator-restore-probe.instance`; then:

- `burst`: six `workspace create`s and six `pane split`s back to back (14 Git Bash panes), then one focus: no hook fails or logs `stayed locked`, and the steady-state hook time at 14 panes stays within 2 s and within 1.5 times the time at 2 panes;
- `seed`: each line of `cwd-navigator-restore-probe.txt` is `<pane>\t<live>\t<spawn>\t<pid>\t<msys>`;
- `legacy`: a two-column line gets its spawn folder and pids at the next hook;
- `no-timer`: after a `cd` into `sub dir`, the record still does not list it 4 s later, because no hook event happened (nothing polls);
- `record-on-hook`: after one `herdr workspace focus`, the record holds `sub dir`, read from the MSYS shell, while `herdr pane list` `cwd` is still the spawn folder;
- `title-push`: a `cd` under Git's stock prompt pushes one `pane_updated` with the spawn-form `cwd`, on which the extension's batch probe reads `sub dir`; the plugin's line keeps the spawn folder (it has no hook for that push);
- `gap` (known limit): a `cd` under the title-less prompt with no later event leaves the record at the earlier folder; after the restart that pane is `same` and stays in its spawn folder;
- `unknown-spawn`, `mismatch`: a line without a spawn folder, and one with another spawn folder, written right before the stop, are skipped and stay in herdr's folder;
- `return`: after `herdr session stop` and a headless restart, exactly one new `cwd-return` entry reads `cwd-return: 1 panes returned, 5 skipped (same=3, unknown-spawn=1, mismatch=1)`, it ran within the 20 s ready timeout (no prompt wait), and `pwd -W` in the restored `moved` pane prints `sub dir`;
- `launcher-cwd`: the Git Bash pane's `process-info` cwd before the stop equals its restored spawn-form reading;
- `record-after`: the record holds each restored pane's spawn folder and new pids;
- `powershell`: a Windows PowerShell 5.1 pane, after `Set-Location`, a focus hook and a restart, is restored in its live folder by herdr itself, and `cwd-return` logs `cwd-return: 0 panes returned, 2 skipped (same=2)`.

At no point does a `cwd-track` process or a `.pid` or `.err` file exist. It exits 0 only when every check passes and prints a JSON summary with paths shown as `<home>`, `<scratch>` and `<user>`; on a failure with the server still up it adds `diagnostics` (the pane list and every `cwd-return` log entry).

Result (2026-10-24, herdr 0.9.5, Windows 11, no shell configuration): passed, 78–84 s per run. Against the previous `cwd-record.ps1` the `burst` row failed: 5 or 6 of its 12 hooks ended `failed` with `stayed locked for 10 s`. An earlier polling recorder (2026-10-23) once missed a cold-start return (cause unknown, possibly a Git Bash start past the 20 s ready wait); it was not reproduced, so treat an intermittent miss on a cold start as open.

`node scripts/cwd-restore-probe/listen.mjs` (scratch session `navigator-listen-probe`, the same scratch config and `HOME`) measures what herdr pushes after a `cd` with no shell configuration. 2026-10-24: under Git's stock prompt one `pane_updated` 360 ms after `pane run` started, with the spawn-form `cwd` and the title `MINGW64:<path>`; under a title-less prompt and in PowerShell, nothing.

Linux: `bash scripts/cwd-restore-probe/linux/run.sh` (needs Docker Desktop running) runs the sh scripts against herdr 0.9.5 in a throwaway Debian container, about 15 s per run. 2026-10-24: every row passed (`record-on-hook`, `return`, `unknown-spawn`, `mismatch`, `same` and the rest), log `cwd-return: 1 panes returned, 3 skipped (same=1, unknown-spawn=1, mismatch=1)`. On Linux herdr restores the live folder itself, so with an up-to-date record every pane is `same`. See `scripts/cwd-restore-probe/linux/README.md`.

macOS: untested. It needs a Mac or a macOS CI runner with herdr 0.9.5; the same container rows would run there under `/bin/sh` with two small changes to the probe.

Manual checks run the scripts directly. PowerShell refuses a plain `-File` on a machine with the default execution policy, so pass `-ExecutionPolicy Bypass` as the plugin manifest does:

```
powershell -NoProfile -ExecutionPolicy Bypass -File plugin/scripts/cwd-return.ps1 -DryRun
```

With `HERDR_SESSION=<scratch>` and `HERDR_NAV_STATE_DIR` (the plugin state directory, or a scratch one holding a `cwd-<scratch>.txt`) set, it prints one `return:<pane>:<folder>` or `skip:<pane>:<reason>` per recorded pane (reasons in order `no-pane`, `same`, `unknown-spawn`, `mismatch`, `missing-folder`, `agent`, `not-ready`, `busy`), then the summary line, and neither types nor records anything. On Linux and macOS use `sh plugin/scripts/cwd-return.sh --dry-run`.

A linked dev run also leaves `discovery.state` in the plugin state directory, written by the existing `discover.*` startup hook; the harness deletes it only if the run created it.

Manual cleanup if a run was interrupted:

1. `herdr session stop navigator-restore-probe`, then `herdr session delete navigator-restore-probe`.
2. `herdr plugin unlink zenderx.herdr-navigator`.
3. Under `%LOCALAPPDATA%\herdr\plugins\zenderx.herdr-navigator`, delete `cwd-navigator-restore-probe.*` and `focused-navigator-restore-probe.txt` (and `discovery.state` if it was not there before).
4. `herdr plugin config-dir zenderx.herdr-navigator` prints (and creates) the config folder; delete it if it holds nothing of yours.
5. Delete the scratch folders under the temp directory.

## Return panes to their live folders (extension only)

Not isolated, and no script automates it: end-to-end isolation is impossible for the extension, because it talks only to the default herdr socket (or `herdrNavigator.socketPath`) and auto-launch runs a bare `herdr`. Unit tests cover the decision logic only, so you run this by hand against your own session. It stops and restarts your herdr server, so save work in every pane first. herdr #5199 is the reason this feature exists.

Precondition: the herdr plugin is not installed or is disabled (`herdr plugin list`). No shell configuration is needed.

1. Press F5 (Run Extension). In the Extension Development Host, make it the navigator window and connect it to a running herdr server (steps 1 to 3 of the first section, or the status bar click). Recording needs only the navigator lease and the connection; the window does not have to run herdr in its own terminal.
2. In two panes, `cd` into folders other than the ones they were spawned in. In a third pane, stay in the spawn folder. Then switch to another pane, tab or space once: every focus change records all panes, with Git Bash folders read from the MSYS shell. Under Git's stock prompt the `cd` alone is already recorded through its title push; under a prompt that sets no title it is not, until that switch.
3. From a separate terminal outside herdr, run `herdr server stop`, then start herdr again (`herdr` in the navigator window's terminal, or let auto-launch do it).
   Expected: within a few seconds of the restore (Git Bash panes need no prompt; the wait is capped at 20 seconds), the two moved panes show their recorded folders again and the third is untouched. The "Herdr Navigator" output channel has exactly one new line `cwd-return: 2 panes returned, 1 skipped (same=1)` (counts vary with your panes; skip reasons are `no-pane`, `same`, `unknown-spawn`, `mismatch`, `missing-folder`, `agent`, `not-ready`, `busy`, `error`). No notification or status bar item appears.
   Spawn check: a reconnect several seconds after the restart still checks each pane, because the restored pane's spawn folder comes from the same `pane.process_info` the busy check reads. A pane whose stored spawn folder is missing (for example a record written by 0.1.3 that the new build has not yet seen at a normal connect) is skipped as `unknown-spawn` and stays where herdr put it; nothing is typed into it.
4. Agent pane: before the stop, run an agent in a pane you moved, then repeat step 3.
   Expected: that pane is skipped as `agent` and nothing is typed into it.
5. Deferral: enable the plugin (`herdr plugin list` shows it enabled), reload the Extension Development Host, `cd` in a pane, and repeat step 3.
   Expected: the output channel has `cwd-return: deferred to herdr plugin`, the extension types nothing, and the plugin's own `cwd-return` line appears in `herdr plugin log list`.

Known limits: only the window holding the navigator lease acts, and only when its record for that server is non-empty. It records while that window is connected to herdr, without polling: from `pane_updated`, `pane_created` and `pane_moved` pushes, dropping panes on `pane_closed`, `pane_exited` and `pane_moved`, and from a full snapshot on connect, on each space, tab or pane focus change, on a tab or space close and after a return; Windows Git Bash folders are read from the MSYS shell on those events, never on a timer. A `cd` under a prompt that sets no title (starship, a custom `PS1`) pushes nothing, so a `cd` there followed by a stop with no other event is missed and the pane returns to its earlier recorded folder or stays in its spawn folder (herdr #5199 is the source fix). PowerShell panes are restored in their live folder by herdr itself and are normally `same`. A restart while VS Code is closed is handled on the next activation when a recorded pane's shell pid differs from the `shell_pid` herdr reports now; the first activation after upgrading misses it, because the old record has no pids. A failed Git Bash probe logs `cwd-return: Git Bash folder probe failed: ...` at `warn`; during a return those panes then end `not-ready` after the 20 s cap. The busy check can add a `warn` line when `ps` or PowerShell fails or times out, and then treats the pane as idle. After a return the extension keeps the recorded folder for each pane it sent a `cd`, so the restored spawn folder is not recorded over it. When the return was left to the plugin, a `pane_updated` from a restored shell before the plugin's `cd` can briefly record the spawn folder; the next update corrects it.

Paste back the `cwd-return:` lines and any `cwd-return: record ...` or `busy check` warnings.

### Upgrade and verify

Why panes such as `<pane a>`, `<pane b>` and `<pane c>` came back in the wrong folders after an earlier restart: that restart happened before the return feature existed. The installed VSIX was still 0.1.3, the 3 s polling build, and the plugin was not installed, so no return code ran, and herdr restored the Git Bash panes into their spawn folders (issue #5199). So the fix is to install the new build, not to change code. Nothing needs to be added to `~/.bashrc`, `$PROFILE`, any other shell startup file or herdr's config; if you added an earlier snippet to `~/.bashrc` or `$PROFILE`, you may remove it, nothing uses it.

1. Install the new extension build from this checkout: `make reinstall`. It runs `npm run package` (`vscode:prepublish` compiles first) and then `code --install-extension herdr-navigator-<version>.vsix --force`. Reload every VS Code window.
2. Before herdr's next restart, let the navigator window connect to the running herdr server once (the status bar shows a folder, not `herdr: disconnected`). This normal connect is when the old v1 record gets its spawn folders and shell pids from `pane.process_info`. If herdr restarts before that, every pane in the old record is skipped as `unknown-spawn` and stays in herdr's folder, and a restart while VS Code was closed is not detected at all, because the old record has no pids. That is safe, but those panes are not returned.
3. Plugin (recommended; with it, the extension defers): `make link-plugin` (or `herdr plugin install ZenderX/herdr-vscode-navigator/plugin` once it is published), then check that `herdr plugin list` shows `zenderx.herdr-navigator` enabled. Then switch space, tab or pane once, so a `cwd-record` hook records every pane with its spawn folder and shell pid.

Verify:

1. Extension: the "Herdr Navigator" output channel. Expected: after a herdr restart, one line `cwd-return: <n> panes returned, <m> skipped (...)`, or `cwd-return: deferred to herdr plugin` when the plugin is enabled. Before that restart, the record `cwd-return-<key>.json` in the extension's global storage (`%APPDATA%\Code\User\globalStorage\z3nder.herdr-navigator\`) reads `"version": 2` and has a `spawn` and a `shellPid` for each pane.
2. Plugin: `%LOCALAPPDATA%\herdr\plugins\zenderx.herdr-navigator\cwd-default.txt`. Expected: one line per pane, `<pane>`, live folder, spawn folder, shell pid and, for a Git Bash pane, herdr's shell pid, tab-separated. After a `cd` and a space switch, the pane's live folder is the new one, while `herdr pane list` still shows the Git Bash pane's spawn folder. After the next herdr restart, `herdr plugin log list` shows one `cwd-return:` line, and the moved panes are back in their folders.

## Saved navigator workspace and the jump list

Manual checks only; no script automates these scenarios. Needs herdr on PATH and the installed VSIX in a normal window, not F5. The navigator workspace is `navigator.code-workspace` in the extension's global storage, in the `anchor` folder.

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

A pane in native PowerShell reports `via cwd` correctly, because herdr injects its own shell integration there (OSC 9;9); the hint is then harmless.
