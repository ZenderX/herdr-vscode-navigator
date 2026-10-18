import * as vscode from "vscode";
import { anchorDirPath } from "./anchorPath";

const README = `This empty folder is the anchor root of a VS Code window managed by Herdr Navigator.
VS Code cannot change the first workspace folder without restarting extensions,
so the first root is pinned and the herdr-followed folder is a second root.
`;

/** Always the extension-owned empty directory. */
export async function resolveAnchor(context: vscode.ExtensionContext): Promise<string> {
  const dir = vscode.Uri.file(anchorDirPath(context.globalStorageUri.fsPath));
  const readme = vscode.Uri.joinPath(dir, "README.txt");
  try {
    await vscode.workspace.fs.stat(readme);
  } catch {
    await vscode.workspace.fs.createDirectory(dir);
    await vscode.workspace.fs.writeFile(readme, new TextEncoder().encode(README));
  }
  return dir.fsPath;
}
