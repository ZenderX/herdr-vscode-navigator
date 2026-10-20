# herdr protocol notes (observed 2026-10-17)

Captured with `node scripts/herdr-probe.mjs --listen 2` against the live herdr 0.9.5. Read-only: only `ping`, `session.snapshot`, `events.subscribe` were sent.

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
- `foreground_process_group_id`: optional; never present on Windows.
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

Verified against herdr 0.9.5 (protocol 22) from `herdr api schema --json`; no live request was sent. This is the only request the extension sends that changes herdr state (used by auto-launch to re-select a space).

- Request: `{ "id": "<id>", "method": "workspace.focus", "params": { "workspace_id": "<id>" } }` (`params` is `WorkspaceTarget`, `workspace_id` required string).
- Response: success result type not isolated in the schema (likely `workspace_info`); the client ignores the payload and rejects on an error envelope.
- Ids such as `w4` are not stable across a herdr restore, so the extension stores the workspace `label` and maps it to an id from `session.snapshot` before focusing.

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
