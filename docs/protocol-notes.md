# herdr protocol notes (observed 2026-10-17)

Captured with `node scripts/herdr-probe.mjs --listen 2` against the live herdr 0.9.5. Read-only: only `ping`, `session.snapshot`, `events.subscribe` were sent.

## Hard invariant: herdr's state is read-only to this project

herdr's own session restore is the source of truth. Nothing in `src/` or `plugin/`:

- writes or renames herdr's `session.json` or anything else under herdr's config dir;
- stops or starts the herdr server;
- creates, closes or renames workspaces, tabs or panes;
- types into panes, with one scoped exception, the same for `plugin/` and `src/`, below.

The one exception: the plugin's `cwd-return` startup hook may run `herdr pane run <pane> "cd '<folder>'"`, and nothing else, into a pane herdr restored moments ago, only when all of these hold: the pane is in the plugin's record and its recorded folder exists; its current folder (for a Windows Git Bash pane the MSYS shell's `/proc` folder, see "Live folder of a Windows Git Bash pane"; else herdr's `cwd`) differs from the recorded folder; the spawn folder stored before the restart and the restored pane's spawn folder are both known and name the same folder (restored side: the pane's spawn-form reading this run, else the idle shell's `pane process-info` `foreground_processes[0].cwd`; either side unknown skips the pane as `unknown-spawn`, a different folder as `mismatch`, see "Pane ids across re-ordering and restarts"); it has no `agent` or `agent_session` key; its shell is ready (plugin rule: a Git bash pane is ready once its MSYS shell resolves; typed input waits in the terminal until the shell reads it, so no prompt is needed; a PowerShell (non-Git-bash) pane is ready once its herdr `cwd` leaves spawn form; `not-ready` means the shell is not resolvable yet, or PowerShell is still in spawn form, after the bounded wait, `HERDR_NAV_READY_TIMEOUT`, 20 s); and its shell runs no other program (Windows: Git's MSYS `ps.exe -l` shows no child of the pane's bash; Unix, inferred and not measured: `pane process-info` shows no `foreground_process_group_id` other than `shell_pid` and at most one foreground process). Skip order, the same in both: `no-pane`, `same`, `unknown-spawn`, `mismatch`, `missing-folder`, `agent`, `not-ready`, `busy`, then `error` (extension) or `run-failed` (plugin). This works around herdr issue #5199 (https://github.com/herdrdev/herdr/issues/5199), herdr 0.9.5 restoring spawn folders instead of live ones, and is to be removed once herdr persists the live cwd.

The extension (`src/`) has the same exception, with the same scope and guard, for when the plugin is not there: it may send the socket request `pane.send_input` with `cd '<folder>'` plus Enter, and nothing else, into a pane herdr restored moments ago. It acts only from the navigator window that holds the navigator lease, only when `herdr plugin list --json` did not report the plugin installed and enabled (a `present` result defers to the plugin; `absent` or `unknown` acts), only after it saw a restart (a lost-and-back socket is always a restart; a first connect is a restart iff some pane id in the current snapshot has a recorded entry with a `folder` and a `shellPid`, and its current herdr `shell_pid` differs from the recorded `shellPid`; entries without a folder or without a recorded pid never count), and only when the record it keeps while that window is connected to herdr is not empty. Each pane must pass the plugin's guard above (recorded folder exists, current folder differs (`same` compares the MSYS probe reading for Git Bash, herdr's `cwd` otherwise), stored and restored spawn folders both known and equal, the restored one from this run's spawn-form reading or else the `pane.process_info` response the busy check already fetched, no `agent`/`agent_session`, ready, no child under the shell, with the same MSYS `ps` check on Windows). Extension readiness rule: a restored pane is `not-ready` iff herdr's `cwd` is in spawn form AND the MSYS probe has no folder for it (no `shell_pid` yet, or the launcher's inner MSYS shell is not resolvable yet); a Windows Git Bash pane is therefore ready as soon as the probe resolves its inner shell, with no prompt wait (typed-ahead measured safe), and PowerShell and other shells only once herdr's `cwd` leaves spawn form, within the same bounded wait (1 s re-read, 20 s cap); an `ok` response only means herdr queued the input, not that it ran (https://herdr.dev/docs/socket-api), so the extension relies on its next snapshot to see the new `cwd`. It works around herdr #5199 too, and the feature and the `pane.send_input` allowlist entry are to be removed once herdr restores pane cwds itself.

Allowed herdr interactions, and nothing else:

- Read-only socket requests: `ping`, `session.snapshot`, `pane.get`, `pane.list`, `pane.process_info` (busy check; the spawn-folder source: one request per pane whose recorded folder changed or whose entry has no spawn folder yet, only outside a return run; and the `shell_pid` for each pane id not seen since the last restart, which the Git Bash probe and the restart check need), `events.subscribe`.
- Read-only CLI calls: `herdr workspace list`, `herdr pane list`, `herdr plugin list`.
- `workspace.focus`, a state-changing socket request that changes focus only (see below).
- `pane.send_input` with `{pane_id, text: "cd '<folder>'", keys: ["enter"]}`, the extension's guarded return into idle restored shells (the exception above); no other input method (`pane.send_text`, `pane.send_keys`) is allowed.
- The auto-launch the user turned on (`herdrNavigator.autoLaunch`) or a status bar click starting a `herdr` client in a VS Code terminal.
- The Install click of the plugin hint, typing `herdr plugin install ZenderX/herdr-vscode-navigator/plugin` into a visible VS Code terminal, where herdr asks the user to confirm.
- The `vscode://` open link starting a `herdr [--session <s>]` client terminal and running `herdr [--session <s>] workspace focus <id>`.
- The plugin's `herdr workspace focus` on the remembered space at startup, its `herdr notification show`, its transient discovery popup (`herdr plugin pane open --placement popup`, a plugin pane, not a user pane), its guarded `herdr pane run <pane> "cd '<folder>'"` at startup (the exception above), one `herdr pane list` read per run of its `cwd-record` event hook (on pane, tab and space focus, create, move, close and exit events, and after the return) and `herdr pane process-info` reads for the guard and for each pane's spawn folder and shell pids (one per pane that is new, whose shell changed, or whose line lacks them), and its own state files under the directory herdr provides as `HERDR_PLUGIN_STATE_DIR` (`cwd-<session>.txt` with lines `<pane>\t<live folder>\t<spawn folder>\t<shell pid>` plus, from `cwd-record.ps1`, a fifth column `<msys>` holding herdr's `shell_pid` when the shell is an MSYS bash; its lock file `cwd-<session>.txt.lock`; the sh twin's rerun request `cwd-<session>.txt.rerun`, which the ps1 twin keeps in the named event `Local\herdr-navigator-rerun-<record path>` instead; and the server-run stamp `cwd-<session>.instance`).

Reading a Git Bash pane's live folder runs only local, read-only programs, not herdr: Git's own `ps.exe -l`, `usr\bin\bash.exe -c` with a fork-free loop over `/proc`, `cygpath.exe -w`, and `Get-CimInstance Win32_Process` (plugin) or the same CIM query from PowerShell (extension) for the launcher's child. See "Live folder of a Windows Git Bash pane".

The extension's own files in VS Code's global storage (`navigator-lease.json`, the `anchor/` folder, the navigator workspace file, and the live-folder record `cwd-return-<key>.json`, one per herdr pipe) are not herdr state.

## Pipe

Name used (marker path appended verbatim to the prefix; reachable from a non-elevated Node process):

```
\\.\pipe\C:\Users\<you>\AppData\Roaming\herdr\herdr.sock
```

Measured 2026-10-24 (herdr 0.9.5, Windows): the pipe answers one request per connection. `src/herdr/client.ts` therefore opens a new connection for every request, and the event subscription holds its own connection.

## Ping

Request id echoed back (`probe_ping`). Result:

```json
{"id":"probe_ping","result":{"type":"pong","version":"0.9.5","protocol":22,"capabilities":{"live_handoff":false,"detached_server_daemon":true,"endpoint_protocol_generation":1,"surface_interest":true,"health_check":true,"ssh_agent_registration":false}}}
```

## Subscription ack

Ack carries the request id and is wrapped in `result`:

```json
{"id":"probe_sub","result":{"type":"subscription_started"}}
```

## Snapshot excerpt

Single workspace / tab / pane at capture time. Focused ids: `focused_workspace_id` `w4`, `focused_tab_id` `w4:t1`, `focused_pane_id` `w4:p1`. The id is echoed (`probe_session.snapshot`) and the payload is `result.snapshot` with `result.type == "session_snapshot"`.

```json
{"focused_workspace_id":"w4","focused_tab_id":"w4:t1","focused_pane_id":"w4:p1",
 "panes":[{"pane_id":"w4:p1","tab_id":"w4:t1","workspace_id":"w4","terminal_id":"term_65e0b61021db910","focused":true,
           "cwd":"C:\\Users\\<you>\\"}]}
```

Pane `cwd` verbatim: `C:\Users\<you>\` (JSON-escaped above). `foreground_cwd`: key absent from the pane object (not even `null`). Workspace `label` was `~`; workspaces and tabs carry no cwd.

## Pushed events

None observed on 2026-10-17: the 2 second listen window produced only the ack, and the probe must not change herdr focus. Nothing happened in that window that herdr pushes for. The wrapper shape was measured on 2026-10-24 (see "Update events"): a pushed line is a bare `{"event":"pane_updated","data":{"type":"pane_updated","pane":PaneInfo}}`, with no `id` and no `result`.

## pane.process_info

Read-only; whitelisted. Request params: `{ "pane_id": "<id>" }`. Live capture 2026-10-17, herdr 0.9.5 on Windows (keys as recorded in `src/herdr/types.ts`):

```
result: { type: "pane_process_info", process_info: { pane_id, shell_pid, foreground_process_group_id, foreground_processes: [{ pid, name, argv0, argv, cmdline, cwd }] } }
```

- `shell_pid`: for a Git Bash pane this is the native launcher `Git\bin\bash.exe`, which has no MSYS `/proc` entry; the real MSYS bash is its Windows child.
- `foreground_process_group_id`: optional; present on herdr 0.9.5 on Windows and equal to `shell_pid` whether the pane is idle or busy (measured 2026-10-23), so it carries no busy signal there.
- `foreground_processes[].cwd`: optional. Measured 2026-10-24: in Git Bash on Windows it stays the spawn folder after any `cd` (with a trailing `\`, also before the first prompt), which is the folder herdr persists and restores the pane into; in pwsh 7 it follows `Set-Location` (herdr's PowerShell wrapper syncs the process cwd at every prompt) and also carries a trailing `\`; on Linux it is `/proc/<pid>/cwd` and follows `cd`. Both recorders therefore use it as the pane's spawn folder when no spawn-form reading exists, taken only when the single foreground process is the shell itself (`pid == shell_pid`), and refresh it whenever the recorded live folder changes.

## Live folder of a Windows Git Bash pane

Why herdr's `cwd` can be stale: herdr's pane `cwd` starts as the folder the pane was spawned in (trailing `\`, on-disk case) and changes only when the shell reports a folder. herdr injects shell integration for PowerShell only (its `prompt` wrapper reports the folder with OSC 9;9 and sets no title); it has no bash equivalent (herdr 0.9.5 source). A Git Bash pane on Windows emits no OSC 7 by default, so herdr's `cwd`, `pane.process_info` `foreground_processes[].cwd` and the `cwd` it saves in `session.json` all stay at the spawn folder after any `cd`, and a restart restores the pane there (herdr issue #5199). A facts-only reproduction for that issue is in [herdr-5199-reproduction.md](herdr-5199-reproduction.md).

Zero-config source, measured 2026-10-24 on Windows 11 with Git for Windows 2.46.2:

- herdr's `shell_pid` is the native launcher `Git\bin\bash.exe`, whose process cwd never moves after `cd`, and which has no MSYS `/proc` entry (`ps -W` lists it as its Windows pid + 65536 with PPID 0). The shell is the launcher's single direct `bash.exe` child, `Git\usr\bin\bash.exe`, created 8–13 ms after the launcher (170–180 ms under load); its `/proc/<msys pid>/winpid` is its own Windows pid, the `ProcessId` that `Get-CimInstance Win32_Process -Filter "ParentProcessId=<shell_pid>"` returns.
- `/proc/<msys pid>/cwd` of that inner shell follows `cd` with no delay (10 of 10 steps), is readable while the shell runs a program (`sleep`) and before the first prompt.
- Cost: one `usr\bin\bash.exe -c` run of a fork-free loop over `/proc/[0-9]*` (`read` of `winpid` and `exename`, `cd -P` into `cwd`, then one `exec cygpath -w` with every folder) reads all shells at once: 38/50/353 ms (min/median/max) for 17 shells, against 2.2–5.5 s for a loop with a `$(readlink)` per entry. A multi-argument `cygpath.exe -w` aborts at the first vanished pid and a multi-argument `readlink.exe` skips it (lines misalign), so pid and folder stay paired inside the loop. One CIM child lookup costs about 280–300 ms, so both recorders keep the launcher-to-shell mapping per `shell_pid` and query CIM only for a `shell_pid` they have not mapped.
- Mapping rule, the same in both recorders: a `shell_pid` that is itself an MSYS bash (`winpid == shell_pid`, herdr's `default_shell` set to `usr\bin\bash.exe`, no launcher) resolves directly; otherwise the pane's shell is the launcher's single `bash.exe` child. Zero or several children, or a pid with no `/proc` (or `ps -l`) row, give no live folder for that pane, never a guess, so no pane can take another pane's folder.
- Typed input sent before the first prompt runs correctly: `pane.send_input` `cd '<folder>'` plus Enter, 20–188 ms after the pane was created, ran 7 of 7 times, and 2 of 2 in restored panes; `herdr pane run` 3 of 3. So a restored Git Bash pane is ready once its inner shell resolves; no herdr field changes at the first prompt of a title-less Git Bash pane.

When it is read, never on a timer: the plugin on each `cwd-record` hook and in `cwd-return`; the extension's recorder on connect, reconnect, the three focus events, `pane_updated`/`pane_created`/`pane_moved`, tab and space closes and after a return (one batch run for all Windows panes whose `cwd` is in spawn form); the extension's follow for the focused pane on a `pane_updated` push and on focus changes. The 1 s follow poll (`herdrNavigator.cwdPollMs`) compares herdr's own `cwd` only and never reads `/proc`.

PowerShell needs none of this: herdr's wrapper keeps `cwd` and the process cwd on the live folder, and herdr restores a PowerShell 5.1 pane in its live folder after a restart (measured 2026-10-24, scratch session), so its return is `same`. On Linux herdr restores the live folder itself (measured in a container); macOS is untested.

## pane.get

Read-only; whitelisted. Used by the cwd poll so a tick fetches one pane instead of `session.snapshot`. Captured 2026-10-19, herdr 0.9.5 (protocol 22) on Windows. Commands (all read-only): `herdr --version`; `herdr api schema --json` (request `pane.get` takes `PaneTarget` = `{ pane_id: string }`, success result `{ type: "pane_info", pane: PaneInfo }`); then one `session.snapshot` to read `focused_pane_id`, one `pane.get` for that id and one for a nonexistent id, over the named pipe with a throwaway script (same framing as `scripts/herdr-probe.mjs`).

Request: `{"id":"x","method":"pane.get","params":{"pane_id":"w1:p1"}}`. Response (paths redacted, trimmed):

```json
{"id":"x","result":{"type":"pane_info","pane":{"pane_id":"w1:p1","terminal_id":"term_<id>","workspace_id":"w1","tab_id":"w1:t1","focused":true,"cwd":"C:\\Users\\<you>\\proj","agent":"claude","terminal_title":"<title>","agent_status":"idle","scroll":{"offset_from_bottom":0,"max_offset_from_bottom":0,"viewport_rows":57},"revision":2}}}
```

- The pane object is the same shape as a snapshot pane: `cwd` and `focused` are present; `foreground_cwd` was absent here (as in the snapshot when there is none), so treat it like the snapshot.
- Unknown id: `{"id":"x","error":{"code":"pane_not_found","message":"pane <id> not found"}}`; the client rejects on it and the poller falls back to a snapshot.

## workspace.focus

Verified against herdr 0.9.5 (protocol 22) from `herdr api schema --json`; no live request was sent. Besides the guarded `pane.send_input` below, this is the only socket request the extension sends that changes herdr state, and it changes focus only (used by auto-launch to re-select a space).

- Request: `{ "id": "<id>", "method": "workspace.focus", "params": { "workspace_id": "<id>" } }` (`params` is `WorkspaceTarget`, `workspace_id` required string).
- Response: success result type not isolated in the schema (likely `workspace_info`); the client ignores the payload and rejects on an error envelope.
- Public ids such as `w4` are persisted and restored as-is, but after a restart an id can name a different space (see "Pane ids across re-ordering and restarts"), so the extension stores the workspace `label` and maps it to an id from `session.snapshot` before focusing.

## Pane ids across re-ordering and restarts

From the herdr 0.9.5 source (commit 2ecf19a, read 2026-10-24) and the 2026-10-24 measurement above. This decides whether the live-folder records, which both the extension and the plugin key by public pane id (`wK:pN`), can send a pane to another pane's folder.

- Public ids do not depend on display order. `workspaces[].id` and `public_pane_numbers` are saved in `session.json`, and a restore keeps them (`restore_workspace` keeps `snap.id`; pane numbers are re-attached from `public_pane_numbers`). herdr renumbers only its internal pane ids and regenerates `terminal_id` and `revision`.
- Re-ordering keeps every id: `workspace.move`, `workspace.move_block`, `tab.move` (within one space only in 0.9.5) and pane swaps. Re-ordering spaces, tabs or panes before a stop therefore never changes which id a pane gets after the restore. herdr may show them in a different order afterwards; the return does not depend on order.
- Ids that change: `pane.move` into another space gives the pane a new id and emits `pane_moved` with `previous_pane_id`.
- Ids that can be reused: after a restart, the id of the highest-numbered space closed before it can be handed out again; and spaces or panes created after the last debounced save (5 s in the source) before a crash or reboot are not in `session.json`, so their ids can go to different panes after the restart.

How the recorders handle this:

- Prune set: an entry is dropped on `pane_closed`, `pane_exited` and `pane_moved` (its `previous_pane_id`), and on `tab_closed` and `workspace_closed`, which carry no pane list. The extension takes those as pushed events and runs a full `session.snapshot` reconcile on the tab and space closes. The plugin runs a full `herdr pane list` merge on every hooked event, which drops every id that is no longer listed. Both take a full reading at startup (or reconnect) and after each return, because a restore emits no creation events.
- Spawn-folder guard: each entry also stores the pane's spawn folder, from a spawn-form reading (Windows: herdr's `cwd` while it still has the trailing `\` and on-disk case, which for Git Bash is the pane's whole life) or else from the idle shell's `pane.process_info` `foreground_processes[0].cwd`. It is seeded once for every entry that lacks one (legacy records included) and refreshed whenever the pane's recorded live folder changes, never from a restored pane before the return has decided it (extension: lookups started before a return run are discarded; plugin: the server-run stamp `cwd-<session>.instance` freezes existing lines until `cwd-return` of the new run has decided). Git Bash's process cwd stays at the spawn folder (#5199) and PowerShell's follows `Set-Location`, and in both cases it is what herdr persists and restores the pane into, so the stored value equals the restored pane's spawn folder by construction. At a return the restored side is the spawn-form reading of this run, else the `process_info` the busy check already fetched. Either side unknown: `unknown-spawn`; both known and different: `mismatch` (the id was reused); skip order `no-pane, same, unknown-spawn, mismatch, missing-folder, agent, not-ready, busy`. Folders compare with one trailing `\` or `/` dropped and `\` and `/` alike; the extension ignores case everywhere except Linux, the plugin ignores case in `cwd-return.ps1` always and in `cwd-return.sh` only when a path contains `\`, so on macOS a case-only difference is a `mismatch` skip in the plugin. A spawn-form reading for a known id that names a different folder, or (plugin) a different `shell_pid` for the same id within one server run, resets the entry. The spawn folder was chosen because every pane has one; `label` is null for most panes and user-editable, and `terminal_id` and `revision` change on every restore.
- Remaining risk: a reused id whose new pane has the same spawn folder as the old one passes the guard. A pane whose spawn folder is unknown on either side is no longer returned unchecked: it stays in herdr's folder (`unknown-spawn`). A v1 extension record gets its spawn folders at the first normal (non-restart) connect of the new build, so a restart before that skips every legacy pane. On Linux, measured in a container (`scripts/cwd-restore-probe/linux/`), herdr restores the live folder itself and #5199 does not occur: restored panes are `same`, or `mismatch` when a `cd` went unrecorded, both of which leave the pane in the right folder. macOS is untested.

## pane.send_input

Captured 2026-10-24 against herdr 0.9.5 (protocol 22) on a throwaway session. The method behind `herdr pane run`; the extension sends it only for the guarded return (see the hard invariant).

- Request: `{"id":"<id>","method":"pane.send_input","params":{"pane_id":"w1:p1","text":"cd '<folder>'","keys":["enter"]}}` (`PaneSendInputParams`: `pane_id` required, `text` and `keys` optional). Pane ids are the public `wN:pN` form.
- Response: `{"id":"<id>","result":{"type":"ok"}}`. herdr's docs say an `ok` acknowledges queue admission, not execution.
- Unknown pane: `{"error":{"code":"pane_not_found","message":"pane <id> not found"}}`; a bad key name: `invalid_key`. The extension counts a failed send as a skip with reason `error`.

## session.json (schema version 3)

herdr persists its layout in `session.json` and, in 0.9.5, restores each pane in its spawn `cwd`, not its live one. Neither the extension nor the plugin reads or writes this file (see the hard invariant above); the restored pane's spawn folder they need comes from `pane.process_info` instead. The notes below are for reading it by hand.

Location (default session): `%APPDATA%\herdr\session.json` on Windows, `$XDG_CONFIG_HOME/herdr/session.json` or `~/.config/herdr/session.json` elsewhere. herdr keeps its own copies under `session-snapshots/` and `session-backups/` (see https://herdr.dev/docs/session-state/).

Schema facts observed in version 3:

- `version`: `3`.
- `workspaces[].id`, `workspaces[].identity_cwd`, `workspaces[].tabs[].panes`: a map keyed by internal pane id, each pane with `cwd` (the spawn folder) and optionally `agent_session.value`.
- `workspaces[].public_pane_numbers`: internal pane id to the public number used in live ids. A live pane `w<N>:p<K>` from `session.snapshot` is the persisted pane in workspace `w<N>` whose `public_pane_numbers` entry equals `K`; live ids are not the internal ids, so the number is the only link.
- `workspaces[].worktree_space`: an object herdr 0.9.5 does not re-derive on restore.

## Update events

Capture 2026-10-17, herdr 0.9.5 (protocol 22), read-only: `node scripts/herdr-probe.mjs --listen <s> --types pane.updated,pane.created,workspace.created,workspace.updated,tab.created`. Two runs (20 s and 40 s) produced only the ack `{"id":"probe_sub","result":{"type":"subscription_started"}}`; no `pane_updated`, `pane_created`, `workspace_created`, `workspace_updated` or `tab_created` line was observed.

Tried to provoke one without mutating herdr: `cd` plus the OSC 7 empty-host sequence from the worker's Bash tool shell. That shell has no TTY (`[ -t 1 ]` false), so the sequence went to the tool output and never reached herdr; the natural agent title/status updates in the window also produced none.

Conclusion at the time: inconclusive. Explained on 2026-10-24: herdr 0.9.5 pushes `pane_updated` only when a pane's stripped terminal title changes (source: `src/app/terminal_titles.rs` `sync_terminal_titles`), and in those listens no title changed. The probe shell had no TTY, so it could not change one.

Measurement 2026-10-24, herdr 0.9.5, Windows 11, headless scratch session with no client attached, with no shell configuration: a scratch `config.toml` (`HERDR_CONFIG_PATH`) and a scratch `HOME` whose startup file only sets `PS1='$ '` (`node scripts/cwd-restore-probe/listen.mjs`):

- `cd` in Git Bash with the stock prompt (title `MINGW64:$PWD`): one `pane_updated` 210–913 ms after the `cd` (360 ms after `herdr pane run` started in the last run), whose `pane.cwd` is still the spawn form and whose `terminal_title` is `MINGW64:<MSYS path>`. It is a trigger, not a folder: the extension reads the folder from the MSYS shell on it.
- `cd` in Git Bash whose prompt sets no title (`PS1='$ '`, or a starship prompt): no push within 5 s (`terminal_title` null), and `pane list` `cwd` stays the spawn form.
- `Set-Location` in a herdr-spawned PowerShell pane: no push within 5 s (title null), although `pane list` follows it. herdr's own PowerShell integration wraps `prompt` after the user's profile has loaded, reports the folder with OSC 9;9 (not OSC 7) and sets no title; neither Windows PowerShell 5.1 nor pwsh 7 sets one at startup. Setting `$Host.UI.RawUI.WindowTitle` in 5.1 reaches herdr's `terminal_title`.
- No push during 20 s idle, and none after a command that does not `cd`, under either prompt.
- Stock-prompt `cd` then `session stop` about 1 s later: the push arrived 211 ms after the `cd`, before the socket closed. A stop closer to the `cd` than that was not measured.
- `pane_created` arrives about 100 ms after `workspace create`, with the spawn-form `cwd` (trailing `\`, on-disk case). A restore pushes no `pane_created`.

So `pane_updated` is the only push after a `cd`, and only for shells whose prompt puts the folder in the title; for Git Bash on Windows it carries the spawn-form `cwd`. No event or plugin hook fires on OSC 7 itself, and `pane.updated` is not a plugin hook kind; herdr 0.9.5 has no hookable event on a `cd` or a stop. Known limit, with no zero-config, poll-free way around it: the plugin records a `cd` only at its next hook, under any prompt, and the extension records a `cd` under a title-less prompt only at its next event, so a `cd` followed by a stop with no event in between is recorded as of the last event. The source fix is herdr #5199 (see [herdr-5199-reproduction.md](herdr-5199-reproduction.md)). The snapshot pane object also carries `cwd` and a `revision` counter, so the no-cwd fallback (fetch a snapshot, compare the focused pane's `cwd`) remains the follow path's safety net.

## Implications for the client

- Pipe name is `\\.\pipe\` + the marker path verbatim; connecting works unelevated.
- Responses echo the request `id`; ack and snapshot are wrapped as `{id,result:{type,...}}`.
- Pushed event wrapper measured 2026-10-24 as bare `{event,data}`; the client still accepts `{id,result:{event,data}}` defensively.
- Observed `cwd` form is Windows (`C:\Users\<you>\`) with a trailing backslash, so the normalizer must strip trailing separators; MSYS form (`/c/...`) not observed for this pane but still accept it.
- `foreground_cwd` may be absent (not just `null`): treat `undefined` and `null` alike and fall back to `cwd`.
- Panes carry extra fields (`agent`, `scroll`, `revision`, ...): keep an index signature, do not validate strictly.
