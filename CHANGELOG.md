# Changelog

## Unreleased

- Removed the new-terminal handling added earlier in this release (anchor-folder terminal cwd, the Ctrl+Shift+` command, its consent prompt and terminal diagnostics).
- The extension now follows a `cd` in the focused herdr pane, not only focus changes: it polls the pane's directory every `herdrNavigator.cwdPollMs` milliseconds (new setting, default `1000`, minimum 250, `0` disables) while this window hosts herdr and auto-follow is on. A `pane.updated` or `workspace.created` event from herdr triggers an immediate check.
- `docs/shell-integration.md` recommends the verified OSC 7 snippet for Git Bash on Windows.
- New setting `herdrNavigator.followGitRoot` (default `true`): the followed directory snaps to the root of its Git repository (nearest ancestor with a `.git` file or directory); outside a repository the exact directory is followed.
- New setting `herdrNavigator.followMode` (`workspace` default, or `folder`). `folder` opens the followed directory as the window's single folder in the same window, so Source Control shows only that folder's repository; it reloads the window on every switch (about 850 ms measured) and VS Code closes the integrated terminal each time.
- `workspace` mode keeps the no-reload behaviour, now always with an extension-owned empty anchor folder.
- Removed the `herdrNavigator.anchorFolder` setting; the anchor is always the extension-owned empty directory.
- `folder` mode asks for a one-time modal confirmation ("Switch folder") before the first reload; Cancel abandons that switch and the confirmation reappears until accepted once.

## 0.1.0

- Initial release: follows the focused herdr pane's working directory via an anchor folder plus a replaceable second workspace root.
- Commands: follow now, toggle auto-follow, reconnect; two-step chord keybinding; status bar item.
- Settings: `autoFollow`, `socketPath`, `cwdSource`, `anchorFolder`, `debounceMs`.
- The first switch in a single-folder or empty window restarts extensions once.
