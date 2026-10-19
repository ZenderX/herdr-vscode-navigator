import * as fs from "node:fs/promises";
import * as path from "node:path";
import { hasAnchorFirst, navigatorWorkspaceContent } from "../follow/planFolders";

async function readIfPresent(file: string): Promise<string | undefined> {
  try {
    return await fs.readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function writeFileAtomically(file: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  // Other windows may read the file, so it is replaced by rename, never rewritten in place.
  const temp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temp, content, "utf8");
  await fs.rename(temp, file);
}

/**
 * Makes the navigator workspace file exist with the anchor first. A file that already lists the anchor first is left byte-for-byte alone,
 * because another window may have it open and rewriting its folders would change that window; the reloaded navigator applies the target itself.
 * Otherwise only `folders` is replaced and every other key (settings such as `window.title`) is kept.
 */
export async function prepareNavigatorWorkspaceFile(
  file: string,
  anchorPath: string,
  target: string,
  platform: NodeJS.Platform,
): Promise<"kept" | "written"> {
  const existing = await readIfPresent(file);
  if (existing !== undefined && hasAnchorFirst(existing, anchorPath, platform)) return "kept";
  await writeFileAtomically(file, navigatorWorkspaceContent(anchorPath, target, platform, existing));
  return "written";
}
