# Linux container probe

Runs the plugin's sh scripts (`plugin/scripts/cwd-record.sh`, `cwd-return.sh`) live on Linux: a throwaway Docker container (Debian `trixie-20261020-slim`, `dash` as `sh`, `mawk` as `awk`) runs a headless herdr 0.9.5 server (`herdr --session navigator-linux-probe server`) with the plugin linked from a read-only mount of this repository. Nothing on the host changes: herdr's config, socket and plugin state live on the container's own file system and go away with it.

```sh
bash scripts/cwd-restore-probe/linux/run.sh
```

Needs a running Docker engine (Docker Desktop on Windows). The first run builds the image `herdr-navigator-probe:0.9.5` (about 20 s: the base image plus the 30 MB `herdr-linux-x86_64` release binary, checked with `sha256sum -c`); later runs reuse the cached layers. A probe run takes about 15 s. The container is removed on exit, also on failure or Ctrl+C. The exit status is 0 only when every row passes; a failing row is printed as `FAIL` with its error, followed by the record and the plugin log.

## Rows

| Row | What it checks |
|---|---|
| `default-shell` | The shell herdr starts with no `config.toml` and no `SHELL` (fact, not a check). |
| `server-instance` | Hooks and startup commands are direct children of the server: the plugin's run stamp equals the server's pid and `/proc` start time. |
| `record-on-hook` | `pane.created`/focus hooks write `cwd-<session>.txt` with `<id> <live> <spawn> <pid>` for four panes; the pid is herdr's `shell_pid` and the shell's own `$$`. |
| `refresh-on-cd` | With no shell configuration herdr's pane `cwd` and `process-info` cwd follow a `cd`; the next hook stores the new folder as live and spawn. |
| `no-hook-at-stop` | `herdr session stop` runs no hook (no `pane.exited` rewrite of the record). |
| `return` | A record line whose live folder differs from where herdr restored the pane, with equal spawn folders, is `cd`'d to the recorded folder. |
| `unknown-spawn` | A line without a spawn folder, written right before the stop, is skipped and the pane stays where herdr put it. |
| `mismatch` | A line whose stored spawn differs from the restored pane's is skipped. |
| `same` | A pane that never ran `cd` is restored by herdr into its recorded folder and counted `same`. |
| `record-after` | cwd-return's final merge stores each restored shell's new pid and process cwd. |

The cwd-return log line of a passing run is `cwd-return: 1 panes returned, 3 skipped (same=1, unknown-spawn=1, mismatch=1)`.

## Measured Linux facts (herdr 0.9.5, 2026-10-24)

- Plugin state dir (`HERDR_PLUGIN_STATE_DIR` of hooks): `${XDG_STATE_HOME:-~/.local/state}/herdr/plugins/zenderx.herdr-navigator`; `XDG_STATE_HOME` is honored.
- Default shell with no `config.toml`: `$SHELL`; with `SHELL` unset, `/bin/sh` (not the login shell from `/etc/passwd`).
- `herdr pane process-info` `foreground_processes[].cwd` follows `cd` (it is `/proc/<pid>/cwd`), and so does `herdr pane list` `cwd`, with no shell configuration. herdr persists and restores the live folder, so issue #5199 does not occur on Linux: with an up-to-date record every restored pane is `same` and cwd-return changes nothing. The `return`, `unknown-spawn` and `mismatch` rows therefore use record lines rewritten right before the stop.
- herdr's `shell_pid` is the pane shell's `$$`.
- Hooks run with the herdr server as their parent, so the plugin's run stamp (`/proc/$PPID/stat` start time) resolves.
- Named sessions keep their socket under `~/.config/herdr/sessions/<name>/`; pane shells get `HERDR_SESSION=<name>`.

## macOS: untested

Nothing here runs on macOS: it needs a Mac (or a macOS CI runner such as GitHub's `macos-latest`) with herdr 0.9.5 installed (`brew install herdr`, or the release binary). The steps of `probe.sh` apply unchanged under macOS `/bin/sh`, with `jq` installed, except two Linux-only reads in the probe itself (`/proc/<pid>/stat` for the server start time, and GNU `date +%s%3N`); the plugin scripts fall back to `ps -o lstart=` there. All rows above would run. Unmeasured on macOS: the plugin state dir, whether `process-info` cwd follows `cd`, the shell herdr picks, and whether hooks are direct children of the server. The plugin's `same_path` compares paths without `\` case-sensitively, so on a case-insensitive macOS volume a case-only difference is a `mismatch` skip.
