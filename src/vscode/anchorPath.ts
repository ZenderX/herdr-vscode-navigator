import * as path from "node:path";

/** The anchor is always this directory under the extension's global storage, never a user folder. */
export function anchorDirPath(globalStoragePath: string): string {
  return path.join(globalStoragePath, "anchor");
}
