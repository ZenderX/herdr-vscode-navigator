import * as path from "node:path";
import * as vscode from "vscode";
import { openFolderInWindow, resolveMutation } from "../follow";
import type { FolderLike, FolderPlan } from "../follow";
import type { Logger } from "../herdr";

const FOLDERS_EVENT_TIMEOUT_MS = 5000;

export function getFolders(): FolderLike[] {
  return (vscode.workspace.workspaceFolders ?? []).map(({ uri }) => ({ path: uri.fsPath }));
}

export function isMultiRoot(): boolean {
  return vscode.workspace.workspaceFile !== undefined;
}

function toFolders(paths: readonly string[]): { uri: vscode.Uri; name: string }[] {
  return paths.map((p) => ({ uri: vscode.Uri.file(p), name: path.basename(p) }));
}

function folderList(): string {
  const folders = vscode.workspace.workspaceFolders ?? [];
  return folders.length === 0 ? "(none)" : folders.map(({ uri }, i) => `[${i}] ${uri.toString()}`).join(" ");
}

/** One-line workspace shape for the activation and diagnostics lines. */
export function describeWorkspace(): string {
  const { name, workspaceFile } = vscode.workspace;
  return `name=${name ?? "none"} workspaceFile=${workspaceFile?.toString() ?? "none"} folders=${folderList()}`;
}

/** Resolves with the change description, or a timeout marker when VS Code fires no event. */
function nextFoldersChange(): Promise<string> {
  return new Promise((resolve) => {
    const timer = setTimeout(
      () => done(`no change event within ${FOLDERS_EVENT_TIMEOUT_MS} ms`),
      FOLDERS_EVENT_TIMEOUT_MS,
    );
    const listener = vscode.workspace.onDidChangeWorkspaceFolders(({ added, removed }) =>
      done(
        `change event added=[${added.map(({ uri }) => uri.toString()).join(", ")}] removed=[${removed.map(({ uri }) => uri.toString()).join(", ")}]`,
      ),
    );
    function done(outcome: string): void {
      clearTimeout(timer);
      listener.dispose();
      resolve(outcome);
    }
  });
}

/** VS Code returns a bare false; this names the likeliest cause from the arguments we passed. */
function rejectionReason(start: number, deleteCount: number, addCount: number, count: number): string {
  if (start < 0 || deleteCount < 0 || start + deleteCount > count) {
    return `range start=${start} deleteCount=${deleteCount} is outside the ${count} open folder(s)`;
  }
  if (deleteCount === 0 && addCount === 0) return "nothing to add or remove";
  return "a previous update is still unconfirmed, the result would contain a folder twice, or nothing would change";
}

/** Replaces this window's content with the target folder; VS Code then kills the extension host, so nothing after this may be relied on. */
export async function openFolder(target: string): Promise<void> {
  await openFolderInWindow(
    { executeCommand: (command, ...args) => vscode.commands.executeCommand(command, ...args), fileUri: (path) => vscode.Uri.file(path) },
    target,
  );
}

/** Applies one plan; resolves true once VS Code reports the change (or false if it rejected the call). */
export async function applyPlan(plan: FolderPlan, log: Logger): Promise<boolean> {
  if (plan.kind === "noop") return true;

  const existing = getFolders();
  const mutation = resolveMutation(plan, existing.map(({ path: open }) => open), process.platform);
  if (mutation === null) {
    log("info", `mutation: already present, nothing to do: ${plan.kind === "remove" ? "" : plan.add.join(", ")}`);
    // A skipped reclaim must not end adoption, so the caller must not record a tracked slot.
    return plan.kind !== "reclaim";
  }
  const { start, deleteCount, add } = mutation;
  if (plan.kind === "convert") {
    void vscode.window.showInformationMessage(
      "Herdr Navigator is adding a folder to this window; extensions restart once; shell terminals are expected to keep running.",
    );
  }

  const uris = toFolders(add).map(({ uri }) => uri.toString());
  log("info", `mutation: folders before ${folderList()}`);
  if (plan.kind === "convert") {
    log(
      "warn",
      `mutation: this window has ${existing.length} folder(s) and no workspace file; adding a folder converts it to an untitled workspace and may restart the extension host (this log ends here, the next activation line follows)`,
    );
  }
  log("info", `mutation: updateWorkspaceFolders(start=${start}, deleteCount=${deleteCount}, add=[${uris.join(", ")}])`);
  const changed = nextFoldersChange();
  // For convert, the extension host may be terminated here; resume happens from globalState on reactivation.
  const accepted = vscode.workspace.updateWorkspaceFolders(start, deleteCount, ...toFolders(add));
  log("info", `mutation: updateWorkspaceFolders returned ${accepted}`);
  if (!accepted) {
    log("warn", `updateWorkspaceFolders rejected: ${plan.kind} at ${start}; ${rejectionReason(start, deleteCount, add.length, existing.length)}`);
    return false;
  }
  log("info", `mutation: ${await changed}; folders after ${folderList()}`);
  return true;
}
