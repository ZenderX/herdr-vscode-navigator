# Jump-list repro

Reproduces, in an isolated VS Code instance, what happens when VS Code is started with a folder (the taskbar jump list passes the folder as a command-line argument, like `code <folder>`) after a session in which the navigator ran.

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/jump-list-repro/run.ps1 -Scratch <empty-or-disposable-dir> [-Trust] [-TimeoutSec 90]
```

Run `npm run compile` first: the script copies `package.json` and `out/` into the isolated extensions directory.

Isolation: the script wipes `<Scratch>` and uses `<Scratch>\user-data` and `<Scratch>\extensions` for VS Code, and points `HERDR_SOCKET_PATH`, `HERDR_CLIENT_SOCKET_PATH` and `HERDR_CONFIG_PATH` at `<Scratch>\herdr`, so it starts a private herdr server and never touches your default herdr session or `%APPDATA%\Code`. It kills only the process tree it started and stops its own herdr server at the end. Workspace trust is disabled for the isolated instance unless `-Trust` is given.

A small driver extension (`driver-extension/`) publishes one heartbeat file per window and runs command files dropped by the script (start herdr in a terminal, open a window, create an untitled workspace, quit). Output: `<Scratch>\evidence.txt`, which has per scenario the visible window titles, each window's workspace file and folders, the lease `launchId`, and the matching `Herdr Navigator` log lines.

## Scenarios

The sequence shares one profile, so each scenario builds on the previous one.

- **E, manual start (convert-hosting).** `project-a` opens as a plain folder, herdr is started by hand in a terminal, and its focused pane sits in `project-c` (a pane in the window's own folder plans a no-op and never converts). Expect `auto-launch: convert-hosting`, one reload into the saved navigator workspace, then `auto-launch: create herdr` focused on `project-c`, and a `pending: reconciled after restart` line proving the pending takeover survived the reload.
- **A, jump-list equivalent.** Quit, then launch with `project-b`. Expect exactly one visible window, titled as the navigator, whose workspace file is `navigator.code-workspace` (reopened untouched, so it still lists the previous folder until the pending takeover is applied) and whose folder at index 1 becomes `project-b` (log `mutation: updateWorkspaceFolders(start=1 ...project-b)`); log `auto-launch: convert-explicit` followed by `auto-launch: create herdr` with focus on `project-b`; `<user-data>\Workspaces` empty.
- **B, no regression.** Quit, launch with no arguments. Expect the saved navigator restored (one window) and `auto-launch: create herdr`.
- **C, second window while running.** With the navigator hosting, open `project-a` in a new window. Expect `auto-launch: none navigator-alive` and the window staying a plain folder window; the `navigator file:` line (folders and `window.title`) in the evidence is identical before and after.
- **D, legacy migration.** A plain window is turned into an untitled `[anchor, folder]` workspace the way the previous release did. Expect `auto-launch: legacy-untitled`. The extension's own modal ("Continue") and VS Code's save prompt cannot be answered unattended, so the script only checks detection; do the rest by hand (see `docs/smoke-test.md`).
