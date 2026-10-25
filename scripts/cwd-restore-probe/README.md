# cwd-restore-probe

End-to-end check, on Windows, of the herdr plugin's restore-cwd feature (`plugin/scripts/cwd-record.ps1` and `cwd-return.ps1`, the workaround for herdr issue #5199) with no shell configuration. It exits 0 only when every assertion passes.

```
npm run compile
node scripts/cwd-restore-probe/run.mjs
```

The script links `plugin/` as `zenderx.herdr-navigator` and starts a headless server in the named session `navigator-restore-probe`, and for the `burst` row a second one in `navigator-restore-probe-base`. Each server reads a scratch `config.toml` (`HERDR_CONFIG_PATH`; `default_shell` Git for Windows' `bin\bash.exe`, `shell_mode = "non_login"`) and gets a scratch `HOME` whose `.bashrc` is only `PS1='$ '` and `unset PROMPT_COMMAND`: no OSC 7, no title, as with starship or a custom prompt. `HERDR_*`, `PS1`, `PROMPT_COMMAND`, `BASH_ENV` and `ENV` are stripped from its environment. Nothing of yours is read or edited: not your herdr config, not your shell startup files. The `title-push` row loads the extension's own probe from `out/`, so run `npm run compile` first; the script refuses to run when `out/` is older than `src/cwd/`.

After the `burst` row it creates six workspaces in a scratch folder `demo app@v1` under the OS temp dir, one at a time, each waiting for its hooks: `moved`, `control`, `unknown`, `mismatch`, `gap` (title-less) and `stock` (created with an empty `HOME`, so Git's own prompt sets the title `MINGW64:<path>`). Rows:

- `stamp`: the first `cwd-return` startup entry in `herdr plugin log list` reaches `succeeded` and writes the server-run stamp `cwd-navigator-restore-probe.instance`.
- `burst`: a `burst base` space with two Git Bash panes, then six `workspace create`s and six `pane split`s back to back with no wait for hooks (14 panes). Every `cwd-record` hook of the burst, and of one `workspace focus` on another space after a `cd` into `demo app@v1/burst cd <n>` in six burst panes, must reach `succeeded` with no `stayed locked` and no `cwd-record:` line in its stderr; the record then holds one line per pane and each `cd` folder. Steady-state hook wall times are then taken in turn: a `herdr pane focus` inside a 2-pane space of the session `navigator-restore-probe-base`, then one inside `burst base` (14 panes), each firing three hooks, seven times each after one seeding pair, so machine drift hits both sides. The 14-pane median of the 21 hooks must stay ≤ 2 s and ≤ 1.5× the 2-pane median (2026-10-24: 1050 vs 1081 ms and 940 vs 1032 ms). The spaces are closed and the base session stopped afterwards. Against the pre-change `cwd-record.ps1` (2026-10-24) this row failed: 5 or 6 of the 12 burst hooks ended `failed` with `stayed locked for 10 s` after 13–15 s.
- `seed`: after one focus hook every line is `<pane>\t<live>\t<spawn>\t<pid>\t<msys>`, with live and spawn = the spawn folder, `<pid>` = the `bash.exe` under herdr's launcher and `<msys>` = herdr's `shell_pid`. Every `cwd-record` hook run (from `pane.created`, `workspace.focused`, `tab.focused`, `pane.focused` and the other hooked events) finished with `succeeded`.
- `legacy`: `control`'s line, rewritten in the old two-column layout, gets its spawn folder and pids at the next focus hook.
- `no-timer`: after `cd` into `demo app@v1/sub dir` in `moved`, `unknown` and `mismatch` (checked through the MSYS shells' `/proc` cwd), the record still does not list it 4 s later, since no hook event happened in between.
- `record-on-hook`: after `herdr workspace focus` on another space, the record lists the sub dir as the live folder of the `cd` panes while `herdr pane list` `cwd` is still the spawn form (`demo app@v1\`). No column holds a trailing separator.
- `title-push`: a `cd` in `stock` pushes one `pane_updated` whose `cwd` is still the spawn form and whose title ends in the sub dir; on that event the extension's batch probe (`createMsysBatchProbe`) reads the sub dir. The plugin has no hook for `pane_updated`, so its line keeps the spawn folder.
- `gap` (known limit): a `cd` in the title-less `gap` pane fires no event, so its line keeps the folder of the last hook; after the restart it is counted `same` and stays in the spawn folder. The script also checks that no title-less pane has a title and that none pushed `pane_updated`.
- `unknown-spawn`, `mismatch`: right before the stop, `unknown`'s line loses its spawn folder and `mismatch`'s gets another spawn folder; both are skipped and stay where herdr put them.
- `return`: after autosave, `herdr session stop` and a headless restart, the only `cwd-return` entry since the restart succeeded with `cwd-return: 1 panes returned, 5 skipped (same=3, unknown-spawn=1, mismatch=1)` and ran under the 20 s ready timeout (no prompt wait). `pwd -W`, typed into each restored pane, puts `moved` in the sub dir and every other pane in `demo app@v1`, while `pane list` `cwd` of `moved` stays the spawn form.
- `launcher-cwd`: `moved`'s `process-info` cwd (the launcher's) before the stop and its restored `pane list` reading are both the spawn folder.
- `record-after`: after the return the record holds each pane's live folder (the sub dir for `moved` only), the restored spawn folder and the restored shells' new pids.
- `powershell`: the Git Bash spaces are closed, the scratch config switches to Windows PowerShell 5.1 (`server reload-config`) and two PowerShell spaces are created. After `Set-Location` into `demo app@v1/ps 5%` and a focus hook, the record holds that folder; after autosave and a restart herdr restores the pane there itself, and `cwd-return` logs `cwd-return: 0 panes returned, 2 skipped (same=2)`.
- At six checkpoints no `cwd-track` process runs and the state dir holds no new `.pid` or `.err` file; cleanup left nothing behind, and the run took under 3 minutes (2026-10-24: 97–100 s with the `burst` row).

It prints one JSON summary with the date, the timings (`recordAfterFocus`, `cdToRecord`, `autosaveWait`, `returnAfterRestart`, `cwdReturnRan`, `psAutosaveWait`, `total`), the rows (`burst` with its hook wall times in ms), the record at the stop and after the restart, the `cwd-return` log line and the cleanup result, with paths replaced by `<home>`, `<scratch>` and `<user>`. It refuses to start if either session already exists, if `zenderx.herdr-navigator` is already linked or installed, or if the state dir already holds files for the session.

Every herdr call names `--session navigator-restore-probe` (or `navigator-restore-probe-base` in the `burst` row); the only calls without it are the read-only `herdr session list --json` and `herdr plugin list --json`, and `plugin link`, `plugin unlink` and `plugin config-dir`, which are global by design. Never run a bare `herdr server stop`: it stops the live server.

The link is global while the run lasts (about 100 s). If you create, focus, move or close a space, tab or pane in your live session meanwhile, its hooks run there too: `discover.*` on `workspace.created`, `record.*` on `workspace.focused`, and `cwd-record.*`, which writes `cwd-default.txt` (and `cwd-default.txt.lock`) into the plugin state dir. If your default server restarts meanwhile, `cwd-return` runs there too. The plugin's other hooks also write their own state files (`focused-<session>.txt`, `discovery.state`) into the plugin state dir during the run.

Cleanup, also on failure: `herdr session stop` and `herdr session delete` of `navigator-restore-probe` and `navigator-restore-probe-base` (and each session's own dir), `herdr plugin unlink zenderx.herdr-navigator`, then delete only the files the run created in `%LOCALAPPDATA%\herdr\plugins\zenderx.herdr-navigator` (the file list is taken before the run; a file that existed before, such as an earlier `cwd-default.txt`, is never deleted) and the plugin config dir only if the run created it empty. Each step runs even if an earlier one fails, and the JSON summary is always printed. A file the run created that stays held open, such as a `cwd-default.txt.lock` a live-session hook has open at that moment, is retried for about 3 s and then reported in `cleanup.stateFilesLeft` (with the error in `cleanup.failures`), not fatal to the cleanup; the run then fails, and the file stays until you delete it once that hook has finished (a leftover `navigator-restore-probe*` file makes the next run refuse to start). `liveSessionWrites` names the other sessions' state files that their hooks created or rewrote while the plugin was linked. If the run is interrupted, do the same by hand: `herdr session stop` and `herdr session delete` for `navigator-restore-probe` and `navigator-restore-probe-base`, `herdr plugin unlink zenderx.herdr-navigator`, and delete `cwd-navigator-restore-probe*` and `focused-navigator-restore-probe*` from that folder.

## listen.mjs

```
node scripts/cwd-restore-probe/listen.mjs
```

Measures, on Windows, what herdr pushes as `pane_updated` after a cwd change with no shell configuration, in the scratch session `navigator-listen-probe` with a scratch `config.toml` (`HERDR_CONFIG_PATH`) and the same scratch `HOME` as `run.mjs`. Nothing of yours is read or edited. Git Bash panes: `T` (title-less prompt) and `S` (Git's stock prompt, empty `HOME`).

- Row 5: the `pane_created` push of `T` and its `pane list` `cwd` 3 s later (both the spawn form).
- Row 1: `cd` in `S` pushes `pane_updated` with the spawn-form `cwd` and the title `MINGW64:<MSYS path>`; the probe fails without that push.
- Row 1t: `cd` in `T` pushes nothing within 5 s; the probe fails on any push.
- Row 2: no push during 20 s idle or after a command without `cd`, in `S` and `T`.
- Row 3: a stock-prompt `cd`, then `session stop` about 1 s later: whether the title push arrives first.
- Row 4: the restored panes' `pane list` readings for 8 s after the restart (spawn form throughout).
- Row 6: `cd` in a Windows PowerShell 5.1 pane (herdr's own wrapper reports the folder; no push). Row 6w: `$Host.UI.RawUI.WindowTitle`.
- Row 9 (fact): pwsh 7 `process-info` cwd after `Set-Location`. It follows the live folder, with a trailing `\`.

Result 2026-10-24: every row passed; the stock-prompt title push came 360 ms after `pane run` started, and the title push of row 3 arrived 211 ms after the `cd`, before the stop.

## linux/

```
bash scripts/cwd-restore-probe/linux/run.sh
```

Runs the plugin's sh scripts live against herdr 0.9.5 in a throwaway Debian container. It needs a running Docker engine (Docker Desktop). A run takes about 15 s once the image is built. 2026-10-24: every row passed. Rows, measured Linux facts and the macOS status (untested) are in [linux/README.md](linux/README.md).
