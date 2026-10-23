# Herdr Navigator

Pairs with Herdr Navigator for VS Code.

A small herdr plugin that focuses the space you last used when herdr starts again, and adds an "Open in VS Code" action for the focused space.

herdr restores your spaces after a restart, but it only knows the focused space as of its last save. After a crash, a forced quit, or a reboot that can be an older space. This plugin records the focused space every time you switch and, once herdr has restored the session, focuses the recorded one.

It needs no configuration, sends no keystrokes to panes, and does nothing else.

## Install

```
herdr plugin install ZenderX/herdr-vscode-navigator/plugin
```

For a local checkout:

```
herdr plugin link /path/to/herdr-vscode-navigator/plugin
herdr plugin unlink zenderx.herdr-navigator
```

## Requirements

- herdr 0.9.5 or newer.
- `sh` on Linux and macOS, Windows PowerShell on Windows. Nothing else.

## How it works

- On every `workspace.focused` event the plugin writes the focused space label to its state directory, one file per herdr session.
- In its `startup` hook it reads that file, looks the label up in `herdr workspace list`, and runs `herdr workspace focus` on the match.
- Spaces are matched by label, because space ids change across restarts. If the label no longer exists, or nothing was recorded yet, the hook does nothing.
- On Linux and macOS, labels containing a double quote or backslash are not recorded.

## Open in VS Code

The plugin adds an "Open in VS Code" action for the focused space. It opens a `vscode://z3nder.herdr-navigator/open` link, which the Herdr Navigator extension handles, and shows a herdr notification that you can detach the terminal with `prefix+q`. It never detaches or closes anything itself.

herdr manifests cannot ship keybindings, so bind it in your herdr config (use `zenderx.herdr-navigator.open-in-vscode-windows` on Windows), then run `herdr server reload-config`. It needs the Herdr Navigator extension installed in VS Code. Details are in the [Open in VS Code guide](https://github.com/ZenderX/herdr-vscode-navigator/blob/main/docs/open-in-vscode.md).

```toml
[[keys.command]]
key = "prefix+o"
type = "plugin_action"
command = "zenderx.herdr-navigator.open-in-vscode"
```

## Discovery popup

If you use VS Code but not the extension, the plugin may show a small popup offering to install it (Install, Learn more, Not now, Never). It shows at most three times (counted when it opens), at least 30 days apart, only while a herdr client is attached (the check shows a brief toast; if the popup then cannot open, at most one more toast that day), never once you answer Never or the extension is installed, and it installs nothing by itself. Details are in the [discovery guide](https://github.com/ZenderX/herdr-vscode-navigator/blob/main/docs/plugin-discovery.md).

## With the VS Code extension

The Herdr Navigator extension does not need this plugin, but when it launches herdr it checks once (`herdr plugin list --json`) and, if this plugin is installed and enabled, leaves the re-focus to it; otherwise it re-focuses the remembered space itself. Deferring is safe because the plugin's startup hook runs once per herdr server start, after the session is restored, and not when a client attaches: either the server starts and the hook re-focuses, or it was already running and its focus is current. If your herdr version does not report whether a plugin is enabled, the extension defers whenever the plugin is installed. Install the plugin if you want the same behaviour for herdr on its own.
