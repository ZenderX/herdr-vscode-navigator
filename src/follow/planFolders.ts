import { samePath } from "../paths";

export interface FolderLike {
  path: string;
}

export type FolderPlan =
  | { kind: "noop"; reason: string }
  | { kind: "convert"; start: number; deleteCount: number; add: string[] }
  | { kind: "replace"; index: number; add: string[] }
  | { kind: "reclaim"; index: number; deleteCount: number; add: string[] }
  | { kind: "append"; index: number; add: string[] }
  | { kind: "remove"; index: number };

export interface PlanInput {
  folders: readonly FolderLike[];
  trackedPath: string | null;
  anchorPath: string;
  target: string;
  isMultiRoot: boolean;
  /** True only on the first follow of a window whose index 0 is a legacy anchor and where this install has never recorded a tracked slot: folders after it are the old install's, so the target takes index 1 and the rest go. */
  adoptedAnchor?: boolean;
  /** Required; selects the path comparison rules (Windows, case-sensitive Linux, case-insensitive macOS). */
  platform: NodeJS.Platform;
}

export interface WorkspaceFileInput {
  folders: readonly FolderLike[];
  /** Scheme of `workspace.workspaceFile`, or undefined when the window has no workspace file. */
  workspaceFileScheme: string | undefined;
  anchorPath: string;
  target: string;
  platform: NodeJS.Platform;
}

export type WorkspaceFilePlan =
  | { action: "write-file-and-open"; content: string }
  | { action: "already-saved-navigator" }
  | { action: "legacy-untitled" }
  | { action: "none" };

function parseObject(text: string | undefined): Record<string, unknown> | null {
  if (text === undefined) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** True when the file text already lists the anchor first, so it can be reopened untouched. */
export function hasAnchorFirst(existing: string, anchorPath: string, platform: NodeJS.Platform): boolean {
  const folders = parseObject(existing)?.folders;
  if (!Array.isArray(folders) || folders.length === 0) return false;
  const first: unknown = folders[0];
  const firstPath = typeof first === "object" && first !== null ? (first as { path?: unknown }).path : undefined;
  return typeof firstPath === "string" && samePath(firstPath, anchorPath, platform);
}

/** Workspace file JSON; the anchor stays first because changing index 0 restarts the extension host. Every other key of an existing file (settings such as `window.title`) is kept. */
export function navigatorWorkspaceContent(anchorPath: string, target: string, platform: NodeJS.Platform, existing?: string): string {
  const paths = samePath(anchorPath, target, platform) ? [anchorPath] : [anchorPath, target];
  return JSON.stringify({ ...parseObject(existing), folders: paths.map((path) => ({ path })) }, null, 2);
}

/** Decides how a window becomes (or already is) the navigator, which is always a saved workspace file. */
export function planWorkspaceFile({ folders, workspaceFileScheme, anchorPath, target, platform }: WorkspaceFileInput): WorkspaceFilePlan {
  if (!anchorPath) throw new Error("anchorPath must be non-empty to plan a navigator workspace");
  const anchorFirst = folders.length > 0 && samePath(folders[0].path, anchorPath, platform);
  if (anchorFirst && workspaceFileScheme === "untitled") return { action: "legacy-untitled" };
  if (anchorFirst && workspaceFileScheme !== undefined) return { action: "already-saved-navigator" };
  if (workspaceFileScheme !== undefined || folders.length > 1) return { action: "none" };
  return { action: "write-file-and-open", content: navigatorWorkspaceContent(anchorPath, target, platform) };
}

/** Index 0 is the anchor and is never a tracked slot: touching it restarts the extension host. */
function findTrackedIndex(folders: readonly FolderLike[], trackedPath: string | null, platform: NodeJS.Platform): number {
  if (trackedPath === null) return -1;
  return folders.findIndex(({ path }, index) => index >= 1 && samePath(path, trackedPath, platform));
}

/** Decides the single updateWorkspaceFolders call that makes the window show the target. */
export function planFolders({ folders, trackedPath, anchorPath, target, isMultiRoot, adoptedAnchor = false, platform }: PlanInput): FolderPlan {
  const trackedIndex = findTrackedIndex(folders, trackedPath, platform);

  // The old install's tracked slot is lost with its workspaceState, so its folders linger after the anchor; this runs once, before anything is recorded.
  // Reclaiming would re-add index 0; the stale folders stay until a different target arrives.
  if (adoptedAnchor && samePath(target, anchorPath, platform)) return { kind: "noop", reason: "target is the adopted anchor" };
  if (adoptedAnchor && folders.length >= 2 && !(folders.length === 2 && samePath(folders[1].path, target, platform))) {
    return { kind: "reclaim", index: 1, deleteCount: folders.length - 1, add: [target] };
  }

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
