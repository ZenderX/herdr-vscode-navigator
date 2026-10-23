# Plugin discovery popup

Findings and design notes for advertising the extension from the companion herdr plugin.

## What the popup does

The plugin can show a small popup (60x8) offering the extension to people who use VS Code but have not installed it. `scripts/discover.sh` (`discover.ps1` on Windows) decides, `scripts/discovery-popup.sh` (`.ps1`) draws it. Nothing is installed without a click in VS Code: "Install" only opens `vscode:extension/z3nder.herdr-navigator`, and VS Code asks before installing.

### When it runs

The decision runs on herdr `startup` and on `workspace.created`. `tab.created` was measured but is not used: it also fires for the first tab of every new space, so it would run the decision twice per space. In order, it stays silent when:

1. The state says `never` or `installed`.
2. An extension folder named `z3nder.herdr-navigator-*` exists in `VSCODE_EXTENSIONS`, `~/.vscode`, `~/.vscode-insiders`, `~/.vscode-oss` or `~/.vscodium-insiders` extensions (ignoring folders VS Code marked for removal). That also records `installed`.
3. It was already shown three times, or the last appearance was under 30 days ago.
4. Neither signal below is present.
5. No client is attached (see the client check under Keys).

Signals (either is enough):

- `TERM_PROGRAM=vscode` in the herdr server's environment, which means the server was started from a VS Code terminal. A hook sees the server's environment, not a later client's, so a server started elsewhere never shows this signal.
- The new (or, at startup, focused) space's folder contains `.vscode/` or a `*.code-workspace` file, and VS Code looks installed (`code` on `PATH`, or a `.vscode`/`.vscode-insiders` folder in the home directory, or a standard install location).

Popup open failures (for example `no active workspace` on an empty server at startup, or another popup already open) are silent and do not count as an appearance.

### Keys

| Key | Effect |
|---|---|
| `i` | Opens the extension page in VS Code (Insiders only when it is the only flavour found) |
| `l` | Opens the Marketplace page in the browser |
| `n` or Esc | Not now |
| `x` | Never |

Keys are accepted in either case. Anything typed during the first second after the popup appears is discarded, so keystrokes meant for the terminal underneath do not answer it, and any other key is ignored. That includes arrow and function keys, which send an Esc-prefixed sequence: only a bare Esc answers Not now. `i` and `l` also record Not now.

An appearance is counted (`shown` +1, `last_shown` = today) as soon as `plugin pane open` succeeds, whether or not the popup is answered; a popup closed without an answer still counts. The answer only sets `decision`. When the popup cannot open (another popup or herdr dialog is open, `ui_busy`), nothing is counted, and the toast date in `discovery.toast` makes the plugin skip the check for the rest of that day.

Before opening, the hook checks that a client is attached with `herdr notification show "Herdr Navigator" --sound none`. The reply `no_foreground_client` means skip (`skip:no-client`) and nothing is opened or counted; any other reply goes ahead. A side effect is a short "Herdr Navigator" toast on the attached client right before the popup. Each popup that opens has one toast, so three at most. If the open then fails (for example `ui_busy`), nothing is counted, but `discovery.toast` is set to today's UTC date and every trigger that day skips the check and the open (`skip:toast-today`), so a failing open costs at most one extra toast per day.

### State and reset

The state is `discovery.state` in the plugin's herdr state directory, three `key=value` lines:

```
decision=not-now
shown=1
last_shown=2026-10-23
```

`decision` is `not-now`, `never` or `installed` (empty until the popup is answered); `last_shown` is a UTC date. The popup's answer re-reads the file and changes only `decision`, and the hook's count after opening keeps any `decision` already on disk; all writes go through a temporary file and a rename. A second file, `discovery.toast`, holds one UTC date (the toast rule under Keys). To see the popup again, delete both files. On Windows it is `%LOCALAPPDATA%\herdr\plugins\zenderx.herdr-navigator\discovery.state`. For Linux and macOS the location was not verified: print `HERDR_PLUGIN_STATE_DIR` from inside a plugin hook. `herdr plugin list` does not show the state directory.

For tests, `HERDR_NAV_STATE_DIR` and `HERDR_NAV_HOME` point the scripts at a scratch state directory and home, `HERDR_NAV_TODAY` fixes the date, and `HERDR_NAV_CLIENT=0|1` simulates the client check (dry runs only; see the smoke test).

### Limits

- A server started outside VS Code with no project markers in the folder never shows the popup.
- The popup is a modal: while another herdr popup is open the request is refused and nothing is queued.
- With no client attached nothing is opened, so a `workspace.created` or `startup` with no client never shows the popup; the next trigger with a client may.
- The measurements below were taken on Windows 11 with herdr 0.9.5 only.

## Measurements

Measured on 2026-10-23 with herdr 0.9.5 on Windows 11, in an isolated named session, with a throwaway plugin linked only for the run. The probe is `scripts/discovery-probe/` (see its README to re-run it). Paths below are shown as `<home>` and `<scratch>`; the probe plugin's hooks exit at once unless `HERDR_SESSION` is the probe session, because a linked plugin is global and also runs in the live session.

### Hook environment (`TERM_PROGRAM`)

A hook sees the environment of the process that started the herdr server, not that of a client attached later. The server was started with `TERM_PROGRAM=vscode`, `TERM_PROGRAM_VERSION=1.105.0`, `VSCODE_INJECTION=1` set explicitly, because a herdr pane overwrites `TERM_PROGRAM` with `herdr` and the measurement ran inside one. That a real VS Code integrated terminal sets the same variables comes from VS Code's source, not from this run.

| Server started with | Event | `TERM_PROGRAM` | `TERM_PROGRAM_VERSION` | `VSCODE_INJECTION` |
|---|---|---|---|---|
| the three variables set | `startup` | `vscode` | `1.105.0` | `1` |
| the three variables set | `workspace.created`, `tab.created` | `vscode` | `1.105.0` | `1` |
| none of them set | `startup`, `workspace.created`, `tab.created` | `(unset)` | `(unset)` | `(unset)` |

Consequence: the signal only fires when the server itself was started from a VS Code terminal. A server started elsewhere never shows it, whatever client attaches later.

Verdict: yes

### Popup from a hook on Windows

Each case ran `herdr --session <name> plugin pane open --plugin <id> --entrypoint <pane>` from a hook. "CLI flags" adds `--placement popup --width 60 --height 8`; "manifest" omits them and relies on `placement = "popup"`, `width = 60`, `height = 8` on the `[[panes]]` entry.

| Trigger | Client attached | Form | Exit | Popup process started |
|---|---|---|---|---|
| `startup`, empty headless server | no | CLI flags | 1, `plugin_pane_open_failed`, `no active workspace` | no |
| `startup`, empty headless server | no | manifest | 1, `plugin_pane_open_failed`, `no active workspace` | no |
| `startup`, server started by a launching client (a startup workspace exists) | yes | manifest | 0, `{"result":{"type":"ok"}}` | yes |
| `workspace.created` | no | manifest | 0 | yes |
| `workspace.created` | yes | manifest, `-File scripts/popup.ps1` (relative) | 0 | yes |
| `workspace.created` | yes | manifest, `-Command` locating the script through `HERDR_PLUGIN_ROOT` | 0 | yes |
| `tab.created` | yes | CLI flags | 0 | yes |

- `herdr plugin pane open --help` lists `overlay, split, tab, zoomed` and no `--width`/`--height`, yet `--placement popup --width 60 --height 8` is accepted and works. The help text is stale; the schema (`herdr api schema --json`) lists `popup`.
- A manifest `placement = "popup"` pane works on Windows with a relative `-File` path; the extended-length plugin cwd did not break it.
- The popup process reported a 57x6 console for the 60x8 request in an 84x29 client, saw `PROBE_OUT` (the server's environment) and had no `HERDR_PANE_ID`.
- `tab.created` also fires for the first tab of every new workspace, so a `workspace.created` and a `tab.created` hook would both run for one new space.
- `workspace.created` and `tab.created` hooks ran with no client attached, and the popup process started there too. Whether such a popup is shown to a client that attaches later was not observed.
- `startup` did not run again when a client attached to the running server (no `env-startup` file after the attach).
- Not measured: `startup` on a server that restores existing workspaces with no client attached (the empty-server failure above is `no active workspace`, not a missing client). Whether the popup is drawn on screen was not observed; only the CLI result and the popup process starting were.

Event JSON (`HERDR_PLUGIN_EVENT_JSON`) carries ids and labels, not the folder:

```
{"event":"workspace_created","data":{"type":"workspace_created","workspace":{"workspace_id":"w3","number":3,"label":"probe-f","focused":false,"pane_count":1,"tab_count":1,"active_tab_id":"w3:t1","agent_status":"unknown"}}}
{"event":"tab_created","data":{"type":"tab_created","tab":{"tab_id":"w3:t1","workspace_id":"w3","number":1,"label":"1","focused":false,"pane_count":1,"agent_status":"unknown"}}}
```

The folder comes from `herdr --session <name> pane list --workspace <id>`, whose panes carry `cwd` (24 ms in this run). `herdr workspace get <id>` has no `cwd` (160 ms). The hook environment has no session flag, so the hook passes `--session $HERDR_SESSION` or relies on `HERDR_SOCKET_PATH`.

Verdict: yes

### Modal refusal

A second popup request while one popup was open, from the CLI and from a raw `plugin.pane.open` request on the API pipe:

```
herdr --session <name> plugin pane open --plugin <id> --entrypoint popup
exit=1  {"error":{"code":"ui_busy","message":"a popup pane is already open"},"id":"cli:plugin"}
{"id":"probe","error":{"code":"ui_busy","message":"a popup pane is already open"}}
```

The refused request was not queued: after the first popup exited, no second popup process started. The Settings and Copy-mode modals could not be tested: the CLI has no command that opens them and the API schema's only related methods are `pane.copy_motion`, `pane.copy_search` and `popup.close`.

Verdict: yes (another popup); not measurable (Settings, Copy mode)

### Console flash

A watcher polled all visible top-level windows about every 20 ms (711 polls over 16 s) and recorded each window handle not seen before. A no-op `powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File` hook was bound to `workspace.focused`, then 20 focus switches were made through the CLI.

| Run | New visible windows |
|---|---|
| positive control (a visible console started on purpose) | 2: `CASCADIA_HOSTING_WINDOW_CLASS` (WindowsTerminal) and `PseudoConsoleWindow` (powershell) |
| idle, 6 s | 0 |
| 20 focus switches, hook ran 21 times per the plugin log | 0 (an unrelated application's window appeared in one earlier run; it is not from herdr) |

The detector sees a deliberate console window, so its silence during the switches is meaningful. A hook process lives roughly 330 ms (plugin log start to finish), far longer than the poll interval. Limits: one machine, one default-terminal setting, and a flash shorter than the poll interval would be missed.

Verdict: no

### Trigger summary

| Event | Result |
|---|---|
| `startup`, with client (server started by a client) | pass |
| `startup`, no client, empty server | fail (`no active workspace`) |
| `workspace.created` | pass, with and without a client |
| `tab.created` | pass with a client; fires for every new workspace too |

### Cleanup

After the final run `herdr session list --json` listed only the `default` session and `herdr plugin list` listed only the plugins that were installed before the run:

```
{"sessions":[{"default":true,"name":"default","running":true,"session_dir":"<home>\\AppData\\Roaming\\herdr","socket_path":"<home>\\AppData\\Roaming\\herdr\\herdr.sock"}]}
1 plugin installed:
- ttt.editor (TTT Editor) enabled [github:eugenioenko/ttt/herdr-plugin@9e3adbbe3330a1764ca737eca575654d754f8ed0]
  config: <home>\AppData\Roaming\herdr\plugins\config\ttt.editor
```

The probe plugin was unlinked, its state and config directories deleted, and the scratch folder removed.
