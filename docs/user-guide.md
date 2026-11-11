# Herdr Navigator user guide

Details that the [README](../README.md) leaves out: how following works, Source Control behaviour, the optional herdr plugin, known limitations, troubleshooting and privacy.

## How it works

Start herdr in the integrated terminal. The window then follows the folder of whichever pane herdr focuses.

The first switch reloads the window once and converts it into a saved navigator workspace. It holds an empty folder owned by the extension and the followed folder. Later switches replace the followed folder in place, with no reload.

Only the window that hosts herdr follows automatically. "Herdr: Follow Focused Pane Now" (`Ctrl+K Ctrl+Alt+H`, `Cmd+K Cmd+Alt+H` on macOS) works in any window. The key binding is a chord because VS Code handles chords even while the herdr terminal has focus; a single key would go to the shell.

The status bar item shows the followed folder, with an open eye when auto-follow is on and a dimmed closed eye when it is off. Click it to launch herdr in an editor tab when herdr is not running in this window, or to toggle auto-follow when it is. When herdr is not installed, the item reads "not installed" and a click opens the [herdr install page](https://herdr.dev/docs/install/).

herdr restores its own panes after a restart; the extension never edits herdr's session state.

herdr 0.9.5 restores each pane in the folder it was spawned in, not the one its shell was in ([herdr issue #5199](https://github.com/herdrdev/herdr/issues/5199)). While the navigator window is connected to herdr, the extension records each pane's live folder whenever herdr sends an event; it does not poll. After a herdr server restart it types `cd '<folder>'` into idle restored shells (no agent, no running program) that came back in a different folder, then logs one `cwd-return:` line in the output channel. No shell configuration is needed. This workaround will be removed once herdr restores pane folders itself.

The full command and settings lists are on the Features tab of the extension's page in VS Code's Extensions view.

## Source Control

Source Control shows one repository at a time: the selected space's repository, the longest open one that equals or contains the followed folder. Every other repository is dropped each time it opens, including one you open by hand; its editor tab stays. The navigator workspace file holds the Git settings this uses, and they override yours in that window only. With `herdrNavigator.followGitRoot` off, the exact folder is followed and its parent repository shows.

A switch opens the new repository first and swaps the folder after, so the Changes view goes straight from the old repository to the new one. Explorer and the window title change a moment later, by 2 seconds at most.

One exception stays: a repository under a folder whose own `.vscode/settings.json` sets `git.enabled: true` is never dropped, because that folder setting outranks the workspace setting. It goes at the next switch to another folder, and the log has `scm: left open`.

A space without Git shows VS Code's built-in "Publish to GitHub" block and Git's own Initialize Repository button. Its folder pick also lists the extension's empty folder, first and selected. Either pick initializes the followed folder, with no reload. A `git init` in the space's terminal shows the new repository within about two seconds, with no switch.

## Optional herdr plugin

A separate, optional [herdr plugin](../plugin/README.md) restores the last focused space when herdr comes back after a crash, forced kill or reboot. The extension does not depend on it, but when the plugin is installed and enabled the extension leaves re-focusing after a launch to it. Install it with:

```sh
herdr plugin install ZenderX/herdr-vscode-navigator/plugin
```

Or click the small plug hint directly to the right of the herdr status bar item, which appears while the plugin is missing or disabled; the hint can be hidden for good.

The plugin also puts each restored pane back in the folder it was last in, for herdr used on its own as well; see the [plugin README](../plugin/README.md#return-panes-to-their-live-folders). When the plugin is installed and enabled, the extension leaves this to the plugin and only logs `cwd-return: deferred to herdr plugin`.

With the plugin, an "Open in VS Code" action jumps from herdr to this extension. See [Open in VS Code](open-in-vscode.md).

## Known limitations

- Focus changes are followed at once. A `cd` inside the focused pane is followed when herdr reports it, which Git Bash's stock prompt does through the terminal title. A prompt that sets no title (starship, a custom `PS1`) fires no event on `cd`, so that `cd` is followed at the next focus, pane or tab change.
- herdr runs one server per user, so every window that hosts herdr follows the same focus.
- The empty folder owned by the extension appears as an extra root.
- Returning panes runs only from the navigator window, and only for a server whose panes that window recorded while connected to it. A busy pane (a login shell still running its profile or prompt commands counts as busy) is checked again every second. A pane not ready within 20 seconds is skipped as `not-ready`, and one still busy then as `busy-timeout`; both keep their recorded folder, so the next VS Code start or herdr server restart returns them. herdr itself restores PowerShell panes in their live folder.
- herdr fires no event on a `cd` or on a server stop, so a pane's folder is recorded at the next event. A `cd` under a prompt that sets no title, followed by a server stop with no other event in between, is missed: the pane returns to its earlier recorded folder or stays in its spawn folder, never in another pane's folder. With the herdr plugin installed this applies to Git Bash's stock prompt too.
- A pane is skipped as `unknown-spawn` when its spawn folder is unknown before or after the restart, and as `mismatch` when herdr gave its id to a pane spawned in a different folder; both stay in the folder herdr chose. Skip reasons, in order: `no-pane`, `same`, `unknown-spawn`, `mismatch`, `missing-folder`, `agent`, `not-ready`, `busy-timeout`, `error`. After upgrading from 0.1.3, let VS Code connect once to the running herdr server before its next restart, or every pane is skipped as `unknown-spawn` that time. Re-ordering spaces, tabs or panes is safe: herdr keeps pane ids.
- Source Control: besides the exception under [Source Control](#source-control), the extension stops dropping a repository Git has brought back after four drops in 10 seconds, logs `scm: left open`, and drops it again at a later event. While the navigator workspace file has unsaved changes, a drop waits for the save. The [changelog](../CHANGELOG.md) lists the smaller limits.

## Troubleshooting

- Open the "Herdr Navigator" output channel (View > Output) for connection and switch logs. It contains local paths, so review it before sharing.
- Run "Herdr Navigator: Show Diagnostics" to see why a directory was chosen. The [smoke test notes](smoke-test.md) explain the log lines.
- Run "Herdr: Reconnect" after restarting herdr.
- If herdr uses a non-default socket, set `herdrNavigator.socketPath` to it. When that setting is empty, the extension uses `HERDR_SOCKET_PATH` from VS Code's environment, then the default location.
- Report problems on the [issue tracker](https://github.com/ZenderX/herdr-vscode-navigator/issues).

## Privacy

The extension talks only to the local herdr socket. It sends read-only requests, plus `workspace.focus` when auto-launch restores the previously selected space, and `pane.send_input` only to type the guarded `cd '<folder>'` into idle shells herdr just restored. It keeps its record of pane folders in VS Code's global storage. Source Control changes go through VS Code's built-in Git extension, on your machine. It collects no telemetry.

## Release notes

See the [changelog](../CHANGELOG.md). To check that a release matches its source, see [Verifying a release](verifying-releases.md).
