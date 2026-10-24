# cwd-restore-probe

End-to-end check, on Windows, of the herdr plugin's restore-cwd feature (`plugin/scripts/cwd-return.ps1` and `cwd-track.ps1`, the workaround for herdr issue #5199). It exits 0 only when every assertion passes.

```
node scripts/cwd-restore-probe/run.mjs
```

The script links `plugin/` as `zenderx.herdr-navigator` and starts a headless server in the named session `navigator-restore-probe`, with every `HERDR_*` variable stripped from its environment. It creates two workspaces in a scratch folder `demo app@v1` under the OS temp dir and runs `cd` into `demo app@v1/sub dir` in one of them. It then asserts:

- the first `cwd-return` startup entry in `herdr plugin log list` reaches `succeeded` and the tracker's lock `cwd-track-navigator-restore-probe.pid` names a live process;
- within 15 s of the `cd`, the record `cwd-navigator-restore-probe.txt` lists the sub dir for the moved pane and the spawn folder for the control pane, with no trailing separator;
- after autosave and `herdr session stop`, the tracker exits and removes its lock within 15 s;
- after a headless restart, within 30 s `pane list` shows the sub dir for the moved pane and the spawn folder for the control pane;
- the new `cwd-return` log entry succeeded with stdout `cwd-return: 1 panes returned, 1 skipped (same=1)`, and it is the only one since the restart;
- exactly one `cwd-track.ps1` process runs for the session, the one in the lock, and the first tracker is gone;
- the second tracker also exits within 15 s of the final stop, no `cwd-track-*.err` file was written, cleanup left nothing behind, and the run took under 3 minutes.

It prints one JSON summary with the date, the timings (`recordWait`, `trackerExitAfterStop`, `returnAfterRestart`, `trackerExitAfterFinalStop`, `total`), the record, the `cwd-return` log line and the cleanup result, with paths replaced by `<home>`, `<scratch>` and `<user>`. It refuses to start if the session already exists, if `zenderx.herdr-navigator` is already linked or installed, or if the state dir already holds files for the session.

Every herdr call names `--session navigator-restore-probe`; the only calls without it are the read-only `herdr session list --json` and `herdr plugin list --json`, and `plugin link`, `plugin unlink` and `plugin config-dir`, which are global by design. Never run a bare `herdr server stop`: it stops the live server.

The link is global while the run lasts (about 30 s). If you create a workspace in your live session meanwhile, its `workspace.created` hook (`discover.*`) runs, and if your default server restarts meanwhile, `cwd-return` runs there too. The plugin's other hooks also write their own state files (`focused-<session>.txt`, `discovery.state`) into the plugin state dir during the run.

Cleanup, also on failure: `herdr session stop` and `herdr session delete navigator-restore-probe`, `herdr plugin unlink zenderx.herdr-navigator`, then delete only the files the run created in `%LOCALAPPDATA%\herdr\plugins\zenderx.herdr-navigator` (the file list is taken before the run) and the plugin config dir only if the run created it empty. If the run is interrupted, do the same by hand: `herdr session stop navigator-restore-probe`, `herdr session delete navigator-restore-probe`, `herdr plugin unlink zenderx.herdr-navigator`, and delete `cwd-navigator-restore-probe.*`, `cwd-track-navigator-restore-probe.*` and `focused-navigator-restore-probe.txt` from that folder.
