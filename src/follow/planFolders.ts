import { samePath } from "../paths";

export interface FolderLike {
  path: string;
}

export type FolderPlan =
  | { kind: "noop"; reason: string }
  | { kind: "convert"; start: number; deleteCount: number; add: string[] }
  | { kind: "replace"; index: number; add: string[] }
  | { kind: "append"; index: number; add: string[] }
  | { kind: "remove"; index: number };

export interface PlanInput {
  folders: readonly FolderLike[];
  trackedPath: string | null;
  anchorPath: string;
  target: string;
  isMultiRoot: boolean;
  /** Required; selects the path comparison rules (Windows, case-sensitive Linux, case-insensitive macOS). */
  platform: NodeJS.Platform;
}

/** Index 0 is the anchor and is never a tracked slot: touching it restarts the extension host. */
function findTrackedIndex(folders: readonly FolderLike[], trackedPath: string | null, platform: NodeJS.Platform): number {
  if (trackedPath === null) return -1;
  return folders.findIndex(({ path }, index) => index >= 1 && samePath(path, trackedPath, platform));
}

/** Decides the single updateWorkspaceFolders call that makes the window show the target. */
export function planFolders({ folders, trackedPath, anchorPath, target, isMultiRoot, platform }: PlanInput): FolderPlan {
  const trackedIndex = findTrackedIndex(folders, trackedPath, platform);

  const alreadyOpenIndex = folders.findIndex(({ path }) => samePath(path, target, platform));
  if (alreadyOpenIndex !== -1 && alreadyOpenIndex !== trackedIndex) {
    if (trackedIndex === -1) return { kind: "noop", reason: "target already open" };
    return { kind: "remove", index: trackedIndex };
  }

  if (alreadyOpenIndex !== -1) return { kind: "noop", reason: "target already in tracked slot" };

  if (folders.length === 0) {
    if (!anchorPath) throw new Error("anchorPath must be non-empty for an empty window");
    const add = samePath(anchorPath, target, platform) ? [anchorPath] : [anchorPath, target];
    return { kind: "convert", start: 0, deleteCount: 0, add };
  }

  if (folders.length === 1 && !isMultiRoot) {
    if (!anchorPath) throw new Error("anchorPath must be non-empty to convert a single-folder window");
    // The user's folder is swapped out so the anchor, not their repository, sits at index 0.
    if (samePath(folders[0].path, anchorPath, platform)) return { kind: "convert", start: 1, deleteCount: 0, add: [target] };
    return { kind: "convert", start: 0, deleteCount: 1, add: [anchorPath, target] };
  }

  if (trackedIndex !== -1) return { kind: "replace", index: trackedIndex, add: [target] };

  return { kind: "append", index: folders.length, add: [target] };
}
