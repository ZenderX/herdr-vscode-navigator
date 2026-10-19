import type { Logger } from "../herdr";
import { samePath } from "../paths";
import { activateNavigator } from "./applyFolderPlan";
import type { PendingTakeover, PlanEffects } from "./applyFolderPlan";
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

export interface ResumeDeps {
  /** The persisted pending intent (globalState). */
  pending: unknown;
  /** The tracked slot saved for this workspace. */
  saved: string | undefined;
  /** Live: a takeover edits the open folders before the pending intent is reconciled. */
  folders: () => readonly FolderLike[];
  /** The recorded takeover folder, applied to a saved navigator before the slot is resumed. */
  takeover: {
    record: PendingTakeover;
    savedNavigator: boolean;
    maxAgeMs: number;
    updateFolders: PlanEffects["updateFolders"];
  };
  now: number;
  platform: NodeJS.Platform;
  setTrackedPath: (path: string) => void;
  saveTracked: (path: string) => Promise<void>;
  /** Records that the user already confirmed following in this window. */
  adoptConfirmation: () => Promise<void>;
  clearPending: () => Promise<void>;
  log: Logger;
}

/** Resumes after the one-time extension-host restart: prefers the pending target, else the saved tracked slot. */
export async function resumePending(deps: ResumeDeps): Promise<void> {
  const { pending, saved, takeover, now, platform, log } = deps;
  await activateNavigator(
    {
      takeover: takeover.record,
      savedNavigator: takeover.savedNavigator,
      pendingTarget: isPendingTarget(pending) ? pending.target : undefined,
      savedSlot: saved,
      now,
      maxAgeMs: takeover.maxAgeMs,
      resume: async (slot) => {
        deps.setTrackedPath(slot);
        // The converted window has a new workspaceState scope, so the slot must be saved again here.
        await deps.saveTracked(slot);
      },
    },
    { openFolders: () => deps.folders().map(({ path }) => path), updateFolders: takeover.updateFolders },
    platform,
    log,
  );
  const folders = deps.folders();
  const isOpen = (candidate: string | undefined): candidate is string =>
    candidate !== undefined && folders.slice(1).some(({ path }) => samePath(path, candidate, platform));
  // globalState is shared by all windows: clear only an intent this window consumed, or a stale/malformed one.
  const outcome = reconcilePending(pending, folders, now, platform);
  if (outcome.action !== "none") log("info", `pending: ${outcome.message}`);
  if (outcome.clear) await deps.clearPending();
  if (isPendingTarget(pending) && pending.confirmed === true && isOpen(pending.target)) await deps.adoptConfirmation();
}
