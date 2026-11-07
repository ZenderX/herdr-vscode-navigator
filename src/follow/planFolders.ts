import { samePath } from "../paths";

export interface FolderLike {
  path: string;
  /** The display name VS Code shows; absent means the basename of `path`. */
  name?: string;
}

/** `name`, when present, is the display name of the target, the last `add` path. */
export type FolderPlan =
  | { kind: "noop"; reason: string }
  | { kind: "convert"; start: number; deleteCount: number; add: string[] }
  | { kind: "replace"; index: number; add: string[]; name?: string }
  | { kind: "reclaim"; index: number; deleteCount: number; add: string[]; name?: string }
  | { kind: "append"; index: number; add: string[]; name?: string }
  | { kind: "remove"; index: number; deleteCount: number };

export interface PlanInput {
  folders: readonly FolderLike[];
  trackedPath: string | null;
  anchorPath: string;
  target: string;
  /** The display name the target's slot should show; absent keeps VS Code's default (the basename). */
  targetName?: string;
  isMultiRoot: boolean;
  /** True only on the first follow of a window whose index 0 is a legacy anchor and where this install has never recorded a tracked slot: folders after it are the old install's, so they go even when the target is already in slot 1, and a target equal to that anchor leaves them. */
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

/** Written into the navigator workspace file: workspace settings override the user's. The `git` keys stop every second repository except folder roots, and the `scm` key keeps a newly opened repository out of Changes until the old one goes. */
export const NAVIGATOR_WORKSPACE_SETTINGS = {
  "git.autoRepositoryDetection": false,
  "git.detectSubmodules": false,
  "git.detectWorktrees": false,
  "git.openRepositoryInParentFolders": "always",
  "scm.repositories.selectionMode": "single",
} as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseObject(text: string | undefined): Record<string, unknown> | null {
  if (text === undefined) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    return isRecord(parsed) ? parsed : null;
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

/** Workspace file JSON; the anchor stays first because changing index 0 restarts the extension host. Every other key of an existing file (settings such as `window.title`) is kept, and a setting it already has wins over `NAVIGATOR_WORKSPACE_SETTINGS`. */
export function navigatorWorkspaceContent(anchorPath: string, target: string, platform: NodeJS.Platform, existing?: string): string {
  const paths = samePath(anchorPath, target, platform) ? [anchorPath] : [anchorPath, target];
  const file = parseObject(existing);
  const settings = file?.settings;
  return JSON.stringify(
    {
      ...file,
      folders: paths.map((path) => ({ path })),
      settings: { ...NAVIGATOR_WORKSPACE_SETTINGS, ...(isRecord(settings) ? settings : {}) },
    },
    null,
    2,
  );
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
export function planFolders({ folders, trackedPath, anchorPath, target, targetName, isMultiRoot, adoptedAnchor = false, platform }: PlanInput): FolderPlan {
  const trackedIndex = findTrackedIndex(folders, trackedPath, platform);
  // Spread instead of `name: undefined` so an unnamed plan keeps its exact shape.
  const named = targetName === undefined ? {} : { name: targetName };

  // The old install's tracked slot is lost with its workspaceState, so its folders linger after the anchor until a different target arrives.
  if (adoptedAnchor && samePath(target, anchorPath, platform)) return { kind: "noop", reason: "target is the adopted anchor" };

  // A navigator window shows only the target after the anchor; every other folder goes in one call, so Git sees one folder change.
  if (folders.length >= 2 && samePath(folders[0].path, anchorPath, platform)) {
    if (samePath(target, anchorPath, platform)) return { kind: "remove", index: 1, deleteCount: folders.length - 1 };
    const slotHoldsTarget = samePath(folders[1].path, target, platform);
    // Focus staying in the space already in slot 1 is no switch, so a folder the user added waits for the next one.
    const inPlace = folders.length === 2 ? slotHoldsTarget || trackedIndex === 1 : slotHoldsTarget && !adoptedAnchor;
    if (!inPlace) return { kind: "reclaim", index: 1, deleteCount: folders.length - 1, add: [target], ...named };
  }

  const alreadyOpenIndex = folders.findIndex(({ path }) => samePath(path, target, platform));
  if (alreadyOpenIndex !== -1 && alreadyOpenIndex !== trackedIndex) {
    if (trackedIndex === -1) return { kind: "noop", reason: "target already open" };
    return { kind: "remove", index: trackedIndex, deleteCount: 1 };
  }

  if (alreadyOpenIndex !== -1) {
    if (targetName === undefined || folders[alreadyOpenIndex].name === targetName) return { kind: "noop", reason: "target already in tracked slot" };
    // VS Code renames a folder that is removed and re-added at the same index under a new name; the tracked index is never 0.
    return { kind: "replace", index: alreadyOpenIndex, add: [target], name: targetName };
  }

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

  if (trackedIndex !== -1) return { kind: "replace", index: trackedIndex, add: [target], ...named };

  // Slot 1 is empty in a navigator window here; a multi-root window of the user's own keeps its folders.
  return { kind: "append", index: folders.length, add: [target], ...named };
}
