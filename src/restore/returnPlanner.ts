import type { PaneInfo } from "../herdr/types";
import { samePath } from "../paths";
import { isSpawnForm } from "./record";
import type { PaneEntry } from "./record";

/**
 * Skip reasons in the plugin's evaluation order; the caller reports `busy-timeout` (still busy when the readiness window
 * ends) and `error` (a failed send).
 */
const SKIP_REASONS = ["no-pane", "same", "unknown-spawn", "mismatch", "missing-folder", "agent", "not-ready", "busy", "busy-timeout", "error"] as const;
export type SkipReason = (typeof SKIP_REASONS)[number];

export interface PlannerPane {
  paneId: string;
  rawCwd: string | null | undefined;
  /** A Windows Git Bash shell's folder from the MSYS probe; `undefined` for other shells and until its inner shell resolves. */
  live: string | undefined;
  /** The restored shell's spawn folder: its spawn-form reading in this run, else its process-info cwd; `undefined` when neither was seen. */
  spawn: string | undefined;
  hasAgent: boolean;
  /** `undefined` means not checked; only `true` skips. */
  busy: boolean | undefined;
}

export interface PlannerInput {
  /** Recorded entries by public pane id; entries without a folder have nothing to return to. */
  recorded: Readonly<Record<string, PaneEntry>>;
  panes: readonly PlannerPane[];
  /** Only `true` lets a pane through; `undefined` (unchecked) counts as missing. */
  folderExists: (folder: string) => boolean | undefined;
  platform: NodeJS.Platform;
}

export interface ReturnAction {
  paneId: string;
  text: string;
}

export interface ReturnSkip {
  paneId: string;
  reason: SkipReason;
}

export interface ReturnPlan {
  actions: ReturnAction[];
  skips: ReturnSkip[];
}

// Treats a present-but-null key as no agent: herdr omits the keys for plain shells.
export function paneHasAgent(pane: PaneInfo): boolean {
  return (pane.agent !== undefined && pane.agent !== null) || (pane.agent_session !== undefined && pane.agent_session !== null);
}

// One argument for a POSIX shell: '\'' closes, escapes and reopens the quote.
function cdCommand(folder: string): string {
  return `cd '${folder.replace(/'/g, "'\\''")}'`;
}

function skipReason(pane: PlannerPane | undefined, folder: string, spawn: string | undefined, input: PlannerInput): SkipReason | undefined {
  if (!pane) return "no-pane";
  if (samePath(pane.live ?? pane.rawCwd, folder, input.platform)) return "same";
  // Without both spawn folders a reused id cannot be ruled out, so the pane stays in herdr's folder.
  if (spawn === undefined || pane.spawn === undefined) return "unknown-spawn";
  // A reused id: the recorded folder belongs to the pane that held the id before.
  if (!samePath(pane.spawn, spawn, input.platform)) return "mismatch";
  if (input.folderExists(folder) !== true) return "missing-folder";
  if (pane.hasAgent) return "agent";
  // Git Bash takes typed-ahead input once its inner shell exists; other shells are ready once herdr's cwd leaves spawn form.
  if (pane.live === undefined && isSpawnForm(pane.rawCwd)) return "not-ready";
  if (pane.busy === true) return "busy";
  return undefined;
}

/** Decides, per recorded pane, whether to type `cd` into it or which reason skips it. */
export function planReturn(input: PlannerInput): ReturnPlan {
  const byId = new Map(input.panes.map((pane) => [pane.paneId, pane]));
  const plan: ReturnPlan = { actions: [], skips: [] };
  for (const [paneId, { folder, spawn }] of Object.entries(input.recorded)) {
    if (folder === undefined) continue;
    const reason = skipReason(byId.get(paneId), folder, spawn, input);
    if (reason) {
      plan.skips.push({ paneId, reason });
      continue;
    }
    plan.actions.push({ paneId, text: cdCommand(folder) });
  }
  return plan;
}

/** True while some pane that may need a return is not ready for input yet. */
export function anyNotReady(plan: ReturnPlan): boolean {
  return plan.skips.some(({ reason }) => reason === "not-ready");
}

export function summary(actions: readonly ReturnAction[], skips: readonly ReturnSkip[]): string {
  const line = `cwd-return: ${actions.length} panes returned, ${skips.length} skipped`;
  if (skips.length === 0) return line;
  const counts = SKIP_REASONS.map((reason) => [reason, skips.filter((skip) => skip.reason === reason).length] as const)
    .filter(([, count]) => count > 0)
    .map(([reason, count]) => `${reason}=${count}`);
  return `${line} (${counts.join(", ")})`;
}
