import { samePath } from "../paths";
import type { FolderLike } from "./planFolders";

export const PENDING_STALE_MS = 2 * 60_000;

export interface PendingTarget {
  target: string;
  at: number;
  // The new untitled workspace has a fresh workspaceState, so a fallback confirmation travels with the intent.
  confirmed?: boolean;
}

export function isPendingTarget(value: unknown): value is PendingTarget {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as PendingTarget).target === "string" &&
    typeof (value as PendingTarget).at === "number"
  );
}

export interface PendingOutcome {
  action: "none" | "reconciled" | "replan" | "discard";
  /** True when the persisted intent should be removed from globalState. */
  clear: boolean;
  message: string;
}

/** Decides what activation does with the intent persisted before a possible extension-host restart. */
export function reconcilePending(
  pending: unknown,
  folders: readonly FolderLike[],
  now: number,
  platform: NodeJS.Platform,
): PendingOutcome {
  if (pending === undefined) return { action: "none", clear: false, message: "no pending intent" };
  if (!isPendingTarget(pending)) return { action: "discard", clear: true, message: "pending intent malformed; cleared" };

  const open = folders.slice(1).some(({ path }) => samePath(path, pending.target, platform));
  if (open) return { action: "reconciled", clear: true, message: `reconciled after restart: ${pending.target} is open` };

  if (now - pending.at > PENDING_STALE_MS) {
    return { action: "discard", clear: true, message: `pending intent for ${pending.target} is stale; cleared` };
  }
  return { action: "replan", clear: false, message: `pending intent for ${pending.target} not open yet; the next follow cycle re-plans it` };
}
