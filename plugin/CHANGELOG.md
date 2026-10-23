# Changelog

## Unreleased

- New discovery popup that offers the Herdr Navigator VS Code extension when herdr was started from a VS Code terminal, or a new space's folder looks like a VS Code project, and the extension is not installed. It runs on `startup` and `workspace.created`; `tab.created` was measured but left out because it also fires for each new space's first tab. At most three appearances, 30 days apart; "Never" and an installed extension stop it. An appearance counts once the popup opens, answered or not. Before opening, a hook checks that a client is attached with `herdr notification show`, which shows a short "Herdr Navigator" toast, and opens nothing otherwise; if the open then fails, further triggers that day skip the check, so a failing open costs at most one toast a day. Arrow and function keys are ignored; a bare Esc is Not now. Nothing installs without a click in VS Code.
- The manifest description and the first line of this README now mention the pairing with Herdr Navigator for VS Code.
- New "Open in VS Code" action (`open-in-vscode`, and `open-in-vscode-windows` on Windows). It opens a link the Herdr Navigator extension handles and shows a notification about detaching with `prefix+q`.
- Renamed the plugin id from `zenderx.refocus-last-space` to `zenderx.herdr-navigator` and its display name to "Herdr Navigator". Unlink the old id and link or install the plugin again.

## 0.1.0

- First release: records the focused space and focuses it again after herdr restarts.
