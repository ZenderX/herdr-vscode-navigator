# Refocus Last Space

A small herdr plugin that focuses the space you last used when herdr starts again.

herdr restores your spaces after a restart, but it only knows the focused space as of its last save. After a crash, a forced quit, or a reboot that can be an older space. This plugin records the focused space every time you switch and, once herdr has restored the session, focuses the recorded one.

It needs no configuration, sends no keystrokes to panes, and does nothing else.

## Install

```
herdr plugin install ZenderX/herdr-vscode-navigator/plugin
```

For a local checkout:

```
herdr plugin link /path/to/herdr-vscode-navigator/plugin
herdr plugin unlink zenderx.refocus-last-space
```

## Requirements

- herdr 0.9.5 or newer.
- `sh` on Linux and macOS, Windows PowerShell on Windows. Nothing else.

## How it works

- On every `workspace.focused` event the plugin writes the focused space label to its state directory, one file per herdr session.
- In its `startup` hook it reads that file, looks the label up in `herdr workspace list`, and runs `herdr workspace focus` on the match.
- Spaces are matched by label, because space ids change across restarts. If the label no longer exists, or nothing was recorded yet, the hook does nothing.
- On Linux and macOS, labels containing a double quote or backslash are not recorded.

## With the VS Code extension

The Herdr Navigator extension re-focuses its own space on auto-launch and does not need this plugin. Install the plugin if you want the same behaviour for herdr on its own.
