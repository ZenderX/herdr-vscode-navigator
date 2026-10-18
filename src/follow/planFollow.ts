import { samePath } from "../paths";
import type { FollowMode } from "../vscode/followMode";
import type { FolderLike } from "./planFolders";

export type FollowAction =
  | { kind: "workspace" }
  | { kind: "noop"; reason: string }
  | { kind: "openFolder"; target: string };

export interface FollowActionInput {
  mode: FollowMode;
  folders: readonly FolderLike[];
  isMultiRoot: boolean;
  target: string;
  platform: NodeJS.Platform;
}

/** Folder mode switches the single folder; workspace mode defers to planFolders and never opens a folder. */
export function planFollowAction({ mode, folders, isMultiRoot, target, platform }: FollowActionInput): FollowAction {
  if (mode === "workspace") return { kind: "workspace" };

  const [only] = folders;
  const isSingleFolder = folders.length === 1 && !isMultiRoot;
  if (isSingleFolder && only && samePath(only.path, target, platform)) {
    return { kind: "noop", reason: "target is already the single folder" };
  }
  // A multi-root, untitled or empty window always switches: that is also the migration away from the anchor design.
  return { kind: "openFolder", target };
}
