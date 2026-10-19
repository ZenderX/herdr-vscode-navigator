import * as path from "node:path";
import { normalizeCwd, samePath } from "../paths";

/** The anchor is always this directory under the extension's global storage, never a user folder. */
export function anchorDirPath(globalStoragePath: string): string {
  return path.join(globalStoragePath, "anchor");
}

/** The saved navigator workspace lives inside the anchor so its parent folder is the already-trusted anchor. */
export function workspaceFilePath(anchorPath: string): string {
  return path.join(anchorPath, "navigator.code-workspace");
}

const LEGACY_ID_DIR = /^[^\\/]+\.herdr-navigator$/i;

/** True for `<globalStorage parent>/<any id>.herdr-navigator/anchor`: an anchor left by an earlier publisher ID of this extension. */
export function isLegacyAnchor(candidate: string, globalStoragePath: string, platform: NodeJS.Platform): boolean {
  const flavor = platform === "win32" ? path.win32 : path.posix;
  const folder = normalizeCwd(candidate, platform);
  const storage = normalizeCwd(globalStoragePath, platform);
  if (folder === null || storage === null) return false;

  const anchorName = flavor.basename(folder);
  const isAnchorName = platform === "linux" ? anchorName === "anchor" : anchorName.toLowerCase() === "anchor";
  if (!isAnchorName) return false;

  const idDir = flavor.dirname(folder);
  return LEGACY_ID_DIR.test(flavor.basename(idDir)) && samePath(flavor.dirname(idDir), flavor.dirname(storage), platform);
}

export interface AnchorChoice {
  path: string;
  /** True when index 0 is a legacy anchor that this window keeps instead of the extension's own. */
  adopted: boolean;
}

/** Only index 0 can be adopted: changing it restarts the extension host. */
export function selectAnchor(
  firstFolder: string | undefined,
  ownAnchor: string,
  globalStoragePath: string,
  platform: NodeJS.Platform,
): AnchorChoice {
  if (firstFolder === undefined || samePath(firstFolder, ownAnchor, platform)) return { path: ownAnchor, adopted: false };
  if (isLegacyAnchor(firstFolder, globalStoragePath, platform)) return { path: firstFolder, adopted: true };
  return { path: ownAnchor, adopted: false };
}
