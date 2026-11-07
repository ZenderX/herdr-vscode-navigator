import * as vscode from "vscode";
import { anchorDirPath } from "./anchorPath";

const README = `This empty folder is the anchor root of a VS Code window managed by Herdr Navigator.
VS Code cannot change the first workspace folder without restarting extensions,
so the first root is pinned and the herdr-followed folder is a second root.
`;

// Keeps Git from opening the anchor as a repository, even after a `git init` there or inside a versioned user data directory.
const ANCHOR_SETTINGS = JSON.stringify({ "git.enabled": false }, null, 2);

async function createIfAbsent(file: vscode.Uri, content: string): Promise<void> {
  try {
    await vscode.workspace.fs.stat(file);
  } catch {
    await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(file, ".."));
    await vscode.workspace.fs.writeFile(file, new TextEncoder().encode(content));
  }
}

/** Always the extension-owned empty directory. */
export async function resolveAnchor(context: vscode.ExtensionContext): Promise<string> {
  const dir = vscode.Uri.file(anchorDirPath(context.globalStorageUri.fsPath));
  await createIfAbsent(vscode.Uri.joinPath(dir, "README.txt"), README);
  await createIfAbsent(vscode.Uri.joinPath(dir, ".vscode", "settings.json"), ANCHOR_SETTINGS);
  return dir.fsPath;
}
