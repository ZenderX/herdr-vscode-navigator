# session-restore-probe

Checks, against an isolated named herdr session, how live pane ids map to the panes herdr persists in `session.json`, and which `cwd` herdr's own restore uses for each pane.

```
node scripts/session-restore-probe/probe.mjs
```

It starts a headless `herdr --session navigator-probe server`, creates a workspace and a split pane in scratch folders, runs `cd ..` in one pane, waits for herdr to autosave, prints the join as JSON, then stops and deletes only that named session and removes the scratch folders.

Run it only against the `navigator-probe` scratch session, never the default session. Every mutating or scratch-session call names `navigator-probe`, through `--session` or as the positional name of `herdr session stop` / `session delete`; the only other call is the read-only `herdr session list --json`. Do not rely on `HERDR_SESSION` for the CLI (it is ignored by `herdr workspace`, `herdr pane` and `herdr api`, which then act on the live default session). Never run a bare `herdr server stop`: it stops the live server.
