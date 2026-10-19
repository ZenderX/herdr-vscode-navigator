// Throwaway driver: publishes a heartbeat per window and executes command files dropped by run.ps1.
// Commands are claimed by an atomic rename, so exactly one window runs each.
const vscode = require("vscode");
const fs = require("fs");
const path = require("path");

const { PROBE_DIR, PROBE_ANCHOR } = process.env;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pid = process.pid;

function heartbeat() {
  const folders = (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
  const file = vscode.workspace.workspaceFile;
  fs.writeFileSync(
    path.join(PROBE_DIR, `win-${pid}.json`),
    JSON.stringify({
      t: Date.now(),
      sessionId: vscode.env.sessionId,
      vscodePid: process.env.VSCODE_PID ?? null,
      folders,
      workspaceFile: file ? { scheme: file.scheme, path: file.fsPath } : null,
      terminals: vscode.window.terminals.map((t) => t.name),
    }),
  );
}

async function run(cmd) {
  if (cmd.name === "start-herdr") {
    const terminal = vscode.window.createTerminal({ name: "manual-herdr", shellPath: process.env.PROBE_BASH, shellArgs: ["-l"] });
    terminal.show();
    await sleep(2000);
    terminal.sendText(cmd.arg ? `cd "${cmd.arg}" && herdr` : "herdr");
  } else if (cmd.name === "new-window") {
    await vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(cmd.arg), { forceNewWindow: true });
  } else if (cmd.name === "make-untitled") {
    // The previous release's conversion: a single-folder window becomes an untitled [anchor, folder] workspace.
    const [only] = vscode.workspace.workspaceFolders ?? [];
    vscode.workspace.updateWorkspaceFolders(0, 1, { uri: vscode.Uri.file(PROBE_ANCHOR) }, { uri: only.uri });
  } else if (cmd.name === "quit") {
    await vscode.commands.executeCommand("workbench.action.quit");
  }
}

async function poll() {
  for (;;) {
    try {
      heartbeat();
      for (const name of fs.readdirSync(PROBE_DIR).filter((n) => /^cmd-\d+\.json$/.test(n))) {
        const claimed = path.join(PROBE_DIR, `${name}.claimed-${pid}`);
        try {
          fs.renameSync(path.join(PROBE_DIR, name), claimed);
        } catch {
          continue;
        }
        await run(JSON.parse(fs.readFileSync(claimed, "utf8")));
      }
    } catch (e) {
      fs.writeFileSync(path.join(PROBE_DIR, `error-${pid}.txt`), String(e && e.stack));
    }
    await sleep(500);
  }
}

exports.activate = () => {
  void poll();
};
