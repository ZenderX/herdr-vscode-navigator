export interface SwitchFolderDeps {
  /** Resolves false when the user declines the switch. */
  confirm: () => Promise<boolean>;
  /** False once the mode, auto-follow state or focus changed while confirm was pending. */
  isCurrent: () => boolean;
  /** Persists the last followed path; must settle before the window is replaced. */
  persistLastFollowed: (target: string) => Promise<void>;
  /** Opens the target as the window's single folder; the extension host is killed once VS Code handles it. */
  openFolder: (target: string) => Promise<void>;
}

/** The persisted path is what lets the next activation tell its own reload from a fresh start. Resolves false when nothing was opened. */
export async function switchFolder(deps: SwitchFolderDeps, target: string): Promise<boolean> {
  if (!(await deps.confirm()) || !deps.isCurrent()) return false;
  await deps.persistLastFollowed(target);
  await deps.openFolder(target);
  return true;
}

export interface OpenFolderDeps<Uri> {
  executeCommand: (command: string, ...args: unknown[]) => PromiseLike<unknown>;
  fileUri: (path: string) => Uri;
}

/** Same-window open: forceReuseWindow overrides window.openFoldersInNewWindow. */
export async function openFolderInWindow<Uri>(deps: OpenFolderDeps<Uri>, target: string): Promise<void> {
  await deps.executeCommand("vscode.openFolder", deps.fileUri(target), { forceReuseWindow: true });
}

export const FOLDER_SWITCH_NOTICE =
  "Herdr Navigator follows herdr by opening each folder as this window's single folder, which reloads the window. VS Code closes the integrated terminal, including the herdr client running in it, on every switch; run herdr again afterwards (the herdr session keeps running). Set herdrNavigator.followMode to workspace to avoid reloads.";

/** Accepting is the only way to proceed; Escape or Cancel abandons the switch and the notice is shown again next time. */
export const FOLDER_SWITCH_CONFIRM = "Switch folder";
