# Open in VS Code

The optional herdr plugin adds an "Open in VS Code" action. Run from a herdr space, it opens a `vscode://` link; the Herdr Navigator extension handles the link by showing a herdr terminal in VS Code and focusing that space.

## Setup

Install the [plugin](https://github.com/ZenderX/herdr-vscode-navigator/blob/main/plugin/README.md) (`herdr plugin install ZenderX/herdr-vscode-navigator/plugin`) and the extension. herdr manifests cannot declare keybindings, so bind the action in your herdr `config.toml`.

Linux and macOS:

```toml
[[keys.command]]
key = "prefix+o"
type = "plugin_action"
command = "zenderx.herdr-navigator.open-in-vscode"
```

Windows uses a separate action id, because herdr rejects two actions with one id:

```toml
[[keys.command]]
key = "prefix+o"
type = "plugin_action"
command = "zenderx.herdr-navigator.open-in-vscode-windows"
```

Then run `herdr server reload-config`. The dotted `command` form follows herdr's documentation; invoking it from a keypress was not measured, because it needs a keypress inside the herdr terminal UI.

To run the action without a keybinding, use the CLI. `invoke` accepts either the full dotted id or the short action id with `--plugin` (both measured):

```sh
herdr plugin action invoke open-in-vscode --plugin zenderx.herdr-navigator
```

On Windows use `open-in-vscode-windows`. The action acts on the focused space of the selected herdr session.

herdr 0.9.5 does not render plugin actions in a space right-click menu, so there is no context menu entry. Use the keybinding or the CLI.

## What happens

1. The action builds the link and hands it to the operating system's `vscode://` handler.
2. VS Code passes the link to the extension. The extension checks it, then shows the terminal named `herdr` (or `herdr (<session>)` for a named session) if the window already has one. Otherwise it opens a new herdr terminal in the editor area. Either way it then runs `herdr workspace focus <space>` against the requested session, retrying for a few seconds while a new herdr server starts.
3. The action shows a herdr notification: "You can detach this terminal with `prefix+q`". Detach yourself; the action never detaches or closes anything. The notification needs an attached herdr client and may not appear (`no_foreground_client`, or `rate_limited` when a recent notification was shown).

The link goes to the active VS Code window, which may not be the one hosting your navigator. VS Code does not itself bring a window forward for the link. Whether the operating system's link handler does depends on the platform. If VS Code stays behind other windows, switch to it yourself.

## Link format

```
vscode://z3nder.herdr-navigator/open?space=<space id>&session=<session name>
```

- `space` is required, once. It must match `[A-Za-z0-9_.:-]{1,128}`; herdr space ids such as `w3` fit.
- `session` is optional, once. It must match `[A-Za-z0-9_.-]{1,64}`. The script derives it from the directory above `herdr.sock` in `HERDR_SOCKET_PATH`; without it the default session is used.
- The path must be `/open`. The extension rejects anything else, shows an error, and does nothing. Values are passed to herdr as separate arguments, never through a shell.

## First use and installation

- The first time a link reaches the extension, VS Code asks "Allow extension to open this URI?". Choosing "Do not ask again" stores the extension in the `extensions.confirmedUriHandlerExtensionIds` setting; remove it there to be asked again.
- If the extension is not installed, VS Code offers to install it and then delivers the link (from VS Code's source; not tested here). A reload prompt may delay delivery.

## Linux notes

- Check that a handler is registered: `xdg-mime query default x-scheme-handler/vscode`. VS Code's package registers it; `xdg-open` has no documented behaviour for unregistered schemes.
- The script tries `xdg-open`, then `gio open`, then `code --open-url`, and shows a herdr notification if none works.
- Snap and Flatpak installs of VS Code were not verified.
- The VS Code Insiders scheme (`vscode-insiders://`) is not supported by the script yet.

## Measured behaviour (herdr 0.9.5)

Measured 2026-10-22 on Windows 11 against herdr 0.9.5, using a throwaway plugin (`zenderx.probe-p2`) and an isolated named session (`probe-p2`) started with `herdr --session probe-p2 server`. The probe plugin, session and state directories were removed afterwards. Paths and user names below are placeholders.

### 1. What an action receives (2026-10-22)

Command: `herdr --session probe-p2 plugin action invoke zenderx.probe-p2.dump` (the action ran `set` and wrote the environment to a file). Re-checked 2026-10-22 in a second throwaway session (`probe-p2b`, plugin `zenderx.probe-p2b`, action `dump`): both `invoke zenderx.probe-p2b.dump` and `invoke dump --plugin zenderx.probe-p2b` exit 0 and run the action (plugin log `succeeded`, `exit_code` 0); `invoke zenderx.probe-p2b.nope` exits 1 with `plugin_action_not_found`, and `invoke dump --plugin zenderx.other` exits 1 with `plugin_not_found`. Both forms are accepted.

- `herdr plugin action invoke` has only a `--plugin <ID>` option; there is no flag to pass a workspace id. The workspace comes from the focused space of the selected session.
- `HERDR_WORKSPACE_ID=w3`, `HERDR_TAB_ID=w3:t1`, `HERDR_PANE_ID=w3:p1` were set.
- `HERDR_PLUGIN_CONTEXT_JSON` was:
  `{"workspace_id":"w3","workspace_label":"<label>","workspace_cwd":"<cwd>","tab_id":"w3:t1","tab_label":"1","focused_pane_id":"w3:p1","focused_pane_cwd":"<cwd>","focused_pane_status":"unknown","invocation_source":"cli","correlation_id":"cli:plugin"}`
- Workspace id format: `w<number>` (`w1`, `w2`, `w3`); pane ids `w3:p1`, tab ids `w3:t1`. All fit `^[A-Za-z0-9_.:-]{1,128}$`.
- `HERDR_SOCKET_PATH=<appdata>\herdr\sessions\probe-p2\herdr.sock`, so the session name is the parent directory of `herdr.sock`.
- `HERDR_SESSION=probe-p2` was also set in the action environment. `HERDR_BIN_PATH` was the full path of `herdr.exe`. Also present: `HERDR_PLUGIN_ID`, `HERDR_PLUGIN_ACTION_ID`, `HERDR_PLUGIN_ROOT`, `HERDR_PLUGIN_STATE_DIR` (`<localappdata>\herdr\plugins\<plugin id>`), `HERDR_PLUGIN_CONFIG_DIR`.
- CLI `--json` output is an envelope: `{"id":"cli:plugin","result":{...}}`; errors are `{"error":{"code":...,"message":...},"id":...}`.
- Invocation from a herdr keybinding: not measured, because it needs a keypress inside the TUI that a script cannot send. Whether a right-click on a space shows plugin actions: not measured for the same reason (manual smoke item).

### 2. Two actions with one id and different `platforms` (2026-10-22)

Command: `herdr plugin link <dir>` with a manifest holding two `[[actions]]` entries `id = "go"`, one `platforms = ["linux", "macos"]`, one `platforms = ["windows"]`.

Result: rejected, exit 1: `{"error":{"code":"duplicate_plugin_action_id","message":"duplicate action id 'go'"},"id":"cli:plugin"}`. A cross-platform plugin needs one distinct action id per OS family. A single action with `platforms = ["windows"]` loads and appears in `herdr plugin list --json` with its `platforms` field.

### 3. Focusing a space from an external process (2026-10-22)

Both flag placements work and select the isolated session:

- `herdr --session probe-p2 workspace focus w3` returned `{"id":"cli:workspace:focus","result":{"type":"workspace_info","workspace":{...,"focused":true,...,"workspace_id":"w3"}}}`.
- `herdr workspace focus w2 --session probe-p2` returned the same shape for `w2`.
- Verified with `herdr --session probe-p2 workspace list`: exactly one workspace had `"focused":true`, the requested one, after each call (with and without an attached client). The server log showed `workspace focused ... workspace_id="w3"` and `tab focused`.
- The CLI picks the session by `--session`, then `HERDR_SOCKET_PATH`, then `HERDR_SESSION`, then the default (measured 2026-10-23); an unknown `HERDR_SESSION` gives `server_not_running` with no fallback. This supersedes the 2026-10-20 note that `HERDR_SESSION` is ignored by `workspace|pane|api` commands, which was likely measured inside a pane whose inherited `HERDR_SOCKET_PATH` outranked it. Pass `--session` on every call anyway.

### 4. Notification from an action (2026-10-22)

Command: `herdr --session probe-p2 notification show "Probe" --body "hello"` with a client attached, from a shell and from inside an action.

Result: `{"id":"cli:notification:show","result":{"reason":"shown","shown":true,"type":"notification_show"}}`. A second call a few seconds later returned `"reason":"rate_limited","shown":false`; after waiting about 15 seconds a call returned `shown` again. A script must treat `rate_limited` as a non-fatal result.

### 5. A second client attaching to a running server (2026-10-22)

The server was started with `herdr --session probe-p2 server`. Running `herdr --session probe-p2` in a second console window (with `HERDR_ENV` and the other `HERDR_*` pane variables removed from its environment) connected to that server: the server log showed `client connected client_id=4 ...` and `herdr session list --json` still listed exactly one `probe-p2` session next to `default`.

- Launching `herdr` from inside a herdr pane is refused by default: `error: nested herdr is disabled by default.` The extension's terminal runs in VS Code, which does not carry the `HERDR_ENV` variable, but a VS Code window started from a herdr pane inherits it; whether that blocks attaching was not measured.
- `herdr session attach probe-p2` was not run; only the `--session <name>` launch form was measured.
- Attaching from a process without a tty fails (`stdin is not a tty` under `winpty`); a real console is required.
