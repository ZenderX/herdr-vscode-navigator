import * as path from "node:path";
import * as vscode from "vscode";
import { openFolderInWindow } from "../follow";
import type { FolderLike, PlanEffects } from "../follow";
import type { Logger } from "../herdr";
import { workspaceFilePath } from "./anchorPath";
import { prepareNavigatorWorkspaceFile } from "./navigatorFile";

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

/** Scheme of the open workspace file (`file` saved, `untitled` legacy), or undefined for a plain folder or empty window. */
export function workspaceFileScheme(): string | undefined {
  return vscode.workspace.workspaceFile?.scheme;
}

/** Reopens this window on the saved navigator workspace, which reloads it and kills the extension host; herdr hosted here is relaunched by the reloaded navigator through the pending takeover. An existing file is reopened as it is (see `prepareNavigatorWorkspaceFile`), so the target reaches the navigator through the pending takeover or its own follow. */
export async function convertToNavigatorWorkspace(anchorPath: string, target: string, log: Logger): Promise<boolean> {
  const file = workspaceFilePath(anchorPath);
  const outcome = await prepareNavigatorWorkspaceFile(file, anchorPath, target, process.platform);
  log("info", `mutation: opening saved navigator workspace ${file} (${outcome}) with target ${target} (this log ends here, the next activation line follows)`);
  await vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(file), { forceReuseWindow: true });
  return true;
}

/** The VS Code binding of the operations a folder plan ends in; resolves true once VS Code reports the change. */
export function workspaceEffects(log: Logger): PlanEffects {
  return {
    openFolders: () => getFolders().map(({ path: open }) => open),
    convert: (anchorPath, target) => convertToNavigatorWorkspace(anchorPath, target, log),
    updateFolders: async (kind, start, deleteCount, add) => {
      const uris = toFolders(add).map(({ uri }) => uri.toString());
      log("info", `mutation: folders before ${folderList()}`);
      log("info", `mutation: updateWorkspaceFolders(start=${start}, deleteCount=${deleteCount}, add=[${uris.join(", ")}])`);
      const count = getFolders().length;
      const changed = nextFoldersChange();
      const accepted = vscode.workspace.updateWorkspaceFolders(start, deleteCount, ...toFolders(add));
      log("info", `mutation: updateWorkspaceFolders returned ${accepted}`);
      if (!accepted) {
        log("warn", `updateWorkspaceFolders rejected: ${kind} at ${start}; ${rejectionReason(start, deleteCount, add.length, count)}`);
        return false;
      }
      log("info", `mutation: ${await changed}; folders after ${folderList()}`);
      return true;
    },
  };
}
