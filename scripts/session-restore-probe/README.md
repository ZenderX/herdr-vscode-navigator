# session-restore-probe

Checks, against an isolated named herdr session, how live pane ids map to the panes persisted in `session.json`.

```
node scripts/session-restore-probe/probe.mjs
```

It starts a headless `herdr --session navigator-probe server`, creates a workspace and a split pane in scratch folders, runs `cd ..` in one pane, waits for herdr to autosave, prints the join as JSON, then stops and deletes only that named session and removes the scratch folders.

`repair-e2e.mjs` (run `npm run compile` first) checks the pre-launch repair end to end in the same named session: it opens a workspace on a scratch repository, `cd`s the pane into a linked worktree, stops only that session, runs the repair against its `session.json`, restarts it and prints the restored pane `cwd`, workspace label and `worktree_space` state. It takes about two minutes because it waits for herdr's autosave.

The only calls that address the default session are the read-only `herdr workspace list` that `repair-e2e.mjs` runs before and after, to confirm the default session's workspaces are unchanged (`defaultSessionUntouched`), and the read-only `herdr session list --json` (lists every session; `repair-e2e.mjs` uses it to refuse to start when a `navigator-probe` session already exists). Every mutating or scratch-session call names `navigator-probe`, through `--session` or as the positional name of `herdr session stop` / `session delete`; do not rely on `HERDR_SESSION` for the CLI (it is ignored by `herdr workspace`, `herdr pane` and `herdr api`, which then act on the live default session). Never run a bare `herdr server stop`: it stops the live server.
