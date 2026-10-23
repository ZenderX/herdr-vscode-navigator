# discovery-probe

Measures, on Windows, the herdr behaviour behind the plugin's discovery popup. Findings are in `docs/plugin-discovery.md`.

```
node scripts/discovery-probe/run.mjs
```

The script links the throwaway plugin in `plugin/` (global to the user, so it is linked only for the run), then starts headless and client-launched servers in the named session `navigator-discovery-probe`, with and without `TERM_PROGRAM=vscode` in the server environment. It records what hooks see, whether popups open from `startup`, `workspace.created` and `tab.created`, the `ui_busy` reply to a second popup, and (through `flash-watch.ps1`) whether the `workspace.focused` hook creates a visible window. It prints one JSON document with paths replaced by `<home>`, `<scratch>` and `<user>`, then stops and deletes the session, kills the clients it started, unlinks the plugin and removes the plugin's state and config directories.

Every hook script exits at once unless `HERDR_SESSION` is `navigator-discovery-probe`, so the linked plugin does nothing in your live session. Every herdr call in the script names `--session`; the only calls without it are the read-only `herdr session list --json`, `herdr plugin list` and `herdr api schema`, plus `plugin link`, `plugin unlink` and `plugin config-dir`, which are global by design. Never run a bare `herdr server stop`: it stops the live server. `HERDR_SESSION` is ignored by `herdr workspace`, `pane` and `api`.

The run opens minimized herdr client windows and, for the flash detector's positive control, one short-lived console window. It takes about two minutes. If it is interrupted, run `herdr session stop navigator-discovery-probe`, `herdr session delete navigator-discovery-probe` and `herdr plugin unlink zenderx.discovery-probe`.
