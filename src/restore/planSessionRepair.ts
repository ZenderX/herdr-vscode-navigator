import { normalizeCwd, samePath } from "../paths";
import type { RestoreManifest } from "./manifest";
import type { LoadedSessionFile, SessionData, SessionPane, SessionWorkspace } from "./sessionFile";

export const MANIFEST_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

export interface RepairChange {
  workspaceId: string;
  /** Internal pane id, or null for a workspace identity_cwd change. */
  paneId: string | null;
  from: string;
  to: string;
}

export type LeaveReason = "path-mismatch" | "stale-manifest" | "no-matching-workspace" | "nothing-to-change";

export type RepairPlan =
  | { kind: "rewrite"; session: SessionData; changes: RepairChange[] }
  | { kind: "leave"; reason: LeaveReason };

function separator(platform: NodeJS.Platform): string {
  return platform === "win32" ? "\\" : "/";
}

function isRoot(path: string): boolean {
  return path === "/" || /^[A-Za-z]:\\$/.test(path);
}

// Writes `target` in the surface form of `previous`: slash style and trailing separator.
function mirrorForm(previous: string, target: string, platform: NodeJS.Platform): string | null {
  const normalized = normalizeCwd(target, platform);
  if (normalized === null) return null;
  const forward = platform === "win32" && previous.includes("/") && !previous.includes("\\");
  const body = forward ? normalized.replace(/\\/g, "/") : normalized;
  if (isRoot(normalized)) return body;
  const trailing = /[\\/]$/.test(previous);
  return trailing ? body + (forward ? "/" : separator(platform)) : body;
}

function agentSessionValue(pane: SessionPane): string | undefined {
  const value = pane.agent_session?.["value"];
  return typeof value === "string" ? value : undefined;
}

function repairWorkspace(
  workspace: SessionWorkspace,
  manifestWorkspace: RestoreManifest["workspaces"][number],
  platform: NodeJS.Platform,
  changes: RepairChange[],
): boolean {
  let matched = false;
  for (const tab of workspace.tabs) {
    for (const [paneId, pane] of Object.entries(tab.panes)) {
      const entry = manifestWorkspace.panes.find(
        ({ internalId, spawnCwd }) => internalId === paneId && samePath(spawnCwd, pane.cwd, platform),
      );
      if (!entry) continue;
      const persistedAgent = agentSessionValue(pane);
      if (persistedAgent !== undefined && entry.agentSessionId !== undefined && persistedAgent !== entry.agentSessionId) continue;

      matched = true;
      const next = mirrorForm(pane.cwd, entry.liveCwd, platform);
      if (next === null || next === pane.cwd) continue;
      changes.push({ workspaceId: workspace.id, paneId, from: pane.cwd, to: next });
      pane.cwd = next;
    }
  }
  if (!matched) return false;

  const identity = mirrorForm(workspace.identity_cwd, manifestWorkspace.folder, platform);
  if (identity !== null && identity !== workspace.identity_cwd) {
    changes.push({ workspaceId: workspace.id, paneId: null, from: workspace.identity_cwd, to: identity });
    workspace.identity_cwd = identity;
  }

  // worktree_space is kept: herdr does not re-derive an omitted one, and a linked worktree legitimately lives outside its repo root.
  return true;
}

/**
 * Plans a bounded rewrite of herdr's session file from a restore manifest. Pure: the input file
 * object is never mutated. Any doubt yields "leave".
 */
export function planSessionRepair(
  file: LoadedSessionFile,
  manifest: RestoreManifest,
  platform: NodeJS.Platform,
  now: Date,
): RepairPlan {
  if (!samePath(file.path, manifest.sessionFilePath, platform)) return { kind: "leave", reason: "path-mismatch" };

  const observed = Date.parse(manifest.observedAt);
  if (Number.isNaN(observed) || now.getTime() - observed > MANIFEST_MAX_AGE_MS) {
    return { kind: "leave", reason: "stale-manifest" };
  }

  const session = structuredClone(file.session);
  const changes: RepairChange[] = [];
  let anyMatched = false;
  for (const workspace of session.workspaces) {
    const manifestWorkspace = manifest.workspaces.find(({ id }) => id === workspace.id);
    if (!manifestWorkspace) continue;
    if (repairWorkspace(workspace, manifestWorkspace, platform, changes)) anyMatched = true;
  }

  if (!anyMatched) return { kind: "leave", reason: "no-matching-workspace" };
  if (changes.length === 0) return { kind: "leave", reason: "nothing-to-change" };
  return { kind: "rewrite", session, changes };
}
