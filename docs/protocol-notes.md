# herdr protocol notes (observed 2026-10-17)

Captured with `node scripts/herdr-probe.mjs --listen 2` against the live herdr 0.9.5. Read-only: only `ping`, `session.snapshot`, `events.subscribe` were sent.

## Hard invariant: herdr's state is read-only to this project

herdr's own session restore is the source of truth. Nothing in `src/` or `plugin/`:

- writes or renames herdr's `session.json` or anything else under herdr's config dir;
- stops or starts the herdr server;
- creates, closes or renames workspaces, tabs or panes;
- types into panes, with one scoped exception, the same for `plugin/` and `src/`, below.

The one exception: the plugin's `cwd-return` startup hook may run `herdr pane run <pane> "cd '<folder>'"`, and nothing else, into a pane herdr restored moments ago, only when all of these hold: the pane is in the plugin's record and its recorded folder exists; its current `cwd` differs from the recorded folder; it has no `agent` or `agent_session` key; its shell has drawn its first prompt (`cwd` no longer in spawn form with a trailing separator); and its shell runs no other program (Windows: Git's MSYS `ps.exe -l` shows no child of the pane's bash; Unix, inferred and not measured: `pane process-info` shows no `foreground_process_group_id` other than `shell_pid` and at most one foreground process). This works around herdr issue #5199 (https://github.com/herdrdev/herdr/issues/5199), herdr 0.9.5 restoring spawn folders instead of live ones, and is to be removed once herdr persists the live cwd.

The extension (`src/`) has the same exception, with the same scope and guard, for when the plugin is not there: it may send the socket request `pane.send_input` with `cd '<folder>'` plus Enter, and nothing else, into a pane herdr restored moments ago. It acts only from the navigator window that holds the navigator lease, only when `herdr plugin list --json` did not report the plugin installed and enabled (a `present` result defers to the plugin; `absent` or `unknown` acts), only after it saw a restart (the socket was lost and came back, or the first snapshot after activation has at least one recorded pane still in spawn form; unrecorded panes never count), and only when the record it keeps while that window is connected to herdr is not empty. Each pane must pass the plugin's guard above (recorded folder exists, current `cwd` differs, no `agent`/`agent_session`, first prompt drawn, no child under the shell, with the same MSYS `ps` check on Windows); an `ok` response only means herdr queued the input, not that it ran (https://herdr.dev/docs/socket-api), so the extension relies on its next snapshot to see the new `cwd`. It works around herdr #5199 too, and the feature and the `pane.send_input` allowlist entry are to be removed once herdr restores pane cwds itself.

Allowed herdr interactions, and nothing else:

- Read-only socket requests: `ping`, `session.snapshot`, `pane.get`, `pane.list`, `pane.process_info`, `events.subscribe`.
- Read-only CLI calls: `herdr workspace list`, `herdr pane list`, `herdr plugin list`.
- `workspace.focus`, a state-changing socket request that changes focus only (see below).
- `pane.send_input` with `{pane_id, text: "cd '<folder>'", keys: ["enter"]}`, the extension's guarded return into idle restored shells (the exception above); no other input method (`pane.send_text`, `pane.send_keys`) is allowed.
- The auto-launch the user turned on (`herdrNavigator.autoLaunch`) or a status bar click starting a `herdr` client in a VS Code terminal.
- The Install click of the plugin hint, typing `herdr plugin install ZenderX/herdr-vscode-navigator/plugin` into a visible VS Code terminal, where herdr asks the user to confirm.
- The `vscode://` open link starting a `herdr [--session <s>]` client terminal and running `herdr [--session <s>] workspace focus <id>`.
- The plugin's `herdr workspace focus` on the remembered space at startup, its `herdr notification show`, its transient discovery popup (`herdr plugin pane open --placement popup`, a plugin pane, not a user pane), its guarded `herdr pane run <pane> "cd '<folder>'"` at startup (the exception above), its `herdr pane list` polling every few seconds by the detached `cwd-track` recorder and `herdr pane process-info` reads for the guard, and its own state files under the directory herdr provides as `HERDR_PLUGIN_STATE_DIR` (including `cwd-<session>.txt`, `cwd-track-<session>.pid` and, after a recorder error, `cwd-track-<session>.err`).

The extension's own files in VS Code's global storage (`navigator-lease.json`, the `anchor/` folder, the navigator workspace file, and the live-folder record `cwd-return-<key>.json`, one per herdr pipe) are not herdr state.

## Pipe

Name used (marker path appended verbatim to the prefix; reachable from a non-elevated Node process):

```
\\.\pipe\C:\Users\<you>\AppData\Roaming\herdr\herdr.sock
```

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

None observed: the 2 second listen window produced only the ack, and the probe must not change herdr focus. Wrapper shape of pushed event lines is still unknown.

## pane.process_info

Read-only; whitelisted. Request params: `{ "pane_id": "<id>" }`. Live capture 2026-10-17, herdr 0.9.5 on Windows (keys as recorded in `src/herdr/types.ts`):

```
result: { type: "pane_process_info", process_info: { pane_id, shell_pid, foreground_process_group_id, foreground_processes: [{ pid, name, argv0, argv, cmdline, cwd }] } }
```

- `shell_pid`: for a Git Bash pane this is the native launcher `Git\bin\bash.exe`, which has no MSYS `/proc` entry; the real MSYS bash is its Windows child.
- `foreground_process_group_id`: optional; present on herdr 0.9.5 on Windows and equal to `shell_pid` whether the pane is idle or busy (measured 2026-10-23), so it carries no busy signal there.
- `foreground_processes[].cwd`: optional; on Windows it does not reliably track a later `cd`.

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
- Ids such as `w4` are not stable across a herdr restore, so the extension stores the workspace `label` and maps it to an id from `session.snapshot` before focusing.

## pane.send_input

Captured 2026-10-24 against herdr 0.9.5 (protocol 22) on a throwaway session. The method behind `herdr pane run`; the extension sends it only for the guarded return (see the hard invariant).

- Request: `{"id":"<id>","method":"pane.send_input","params":{"pane_id":"w1:p1","text":"cd '<folder>'","keys":["enter"]}}` (`PaneSendInputParams`: `pane_id` required, `text` and `keys` optional). Pane ids are the public `wN:pN` form.
- Response: `{"id":"<id>","result":{"type":"ok"}}`. herdr's docs say an `ok` acknowledges queue admission, not execution.
- Unknown pane: `{"error":{"code":"pane_not_found","message":"pane <id> not found"}}`; a bad key name: `invalid_key`. The extension counts a failed send as a skip with reason `error`.

## session.json (schema version 3)

herdr persists its layout in `session.json` and, in 0.9.5, restores each pane in its spawn `cwd`, not its live one. The extension does not read or write this file (see the hard invariant above); the notes below are for reading it by hand.

Location (default session): `%APPDATA%\herdr\session.json` on Windows, `$XDG_CONFIG_HOME/herdr/session.json` or `~/.config/herdr/session.json` elsewhere. herdr keeps its own copies under `session-snapshots/` and `session-backups/` (see https://herdr.dev/docs/session-state/).

Schema facts observed in version 3:

- `version`: `3`.
- `workspaces[].id`, `workspaces[].identity_cwd`, `workspaces[].tabs[].panes`: a map keyed by internal pane id, each pane with `cwd` (the spawn folder) and optionally `agent_session.value`.
- `workspaces[].public_pane_numbers`: internal pane id to the public number used in live ids. A live pane `w<N>:p<K>` from `session.snapshot` is the persisted pane in workspace `w<N>` whose `public_pane_numbers` entry equals `K`; live ids are not the internal ids, so the number is the only link.
- `workspaces[].worktree_space`: an object herdr 0.9.5 does not re-derive on restore.

## Update events

Capture 2026-10-17, herdr 0.9.5 (protocol 22), read-only: `node scripts/herdr-probe.mjs --listen <s> --types pane.updated,pane.created,workspace.created,workspace.updated,tab.created`. Two runs (20 s and 40 s) produced only the ack `{"id":"probe_sub","result":{"type":"subscription_started"}}`; no `pane_updated`, `pane_created`, `workspace_created`, `workspace_updated` or `tab_created` line was observed.

Tried to provoke one without mutating herdr: `cd` plus the OSC 7 empty-host sequence from the worker's Bash tool shell. That shell has no TTY (`[ -t 1 ]` false), so the sequence went to the tool output and never reached herdr; the natural agent title/status updates in the window also produced none.

Conclusion: inconclusive; payload shape and whether `pane_updated` carries the cwd are unknown. The snapshot pane object does carry `cwd` and a `revision` counter, so a no-cwd fallback (fetch a snapshot, compare the focused pane's `cwd`) is viable.

## Implications for the client

- Pipe name is `\\.\pipe\` + the marker path verbatim; connecting works unelevated.
- Responses echo the request `id`; ack and snapshot are wrapped as `{id,result:{type,...}}`.
- Pushed event wrapper is unconfirmed: accept both bare `{event,data}` and `{id,result:{event,data}}` defensively.
- Observed `cwd` form is Windows (`C:\Users\<you>\`) with a trailing backslash, so the normalizer must strip trailing separators; MSYS form (`/c/...`) not observed for this pane but still accept it.
- `foreground_cwd` may be absent (not just `null`): treat `undefined` and `null` alike and fall back to `cwd`.
- Panes carry extra fields (`agent`, `scroll`, `revision`, ...): keep an index signature, do not validate strictly.
