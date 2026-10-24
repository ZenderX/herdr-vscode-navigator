import type { PaneInfo } from "../herdr/types";
import { samePath } from "../paths";
import { isSpawnForm } from "./record";

/** Skip reasons in the plugin's evaluation order; `error` is a failed send, reported by the caller. */
export const SKIP_REASONS = ["no-pane", "same", "missing-folder", "agent", "not-ready", "busy", "error"] as const;
export type SkipReason = (typeof SKIP_REASONS)[number];

export interface PlannerPane {
  paneId: string;
  rawCwd: string | null | undefined;
  hasAgent: boolean;
  /** `undefined` means not checked; only `true` skips. */
  busy: boolean | undefined;
}

export interface PlannerInput {
  /** Recorded folders by public pane id. */
  recorded: Readonly<Record<string, string>>;
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
export function cdCommand(folder: string): string {
  return `cd '${folder.replace(/'/g, "'\\''")}'`;
}

function skipReason(pane: PlannerPane | undefined, folder: string, input: PlannerInput): SkipReason | undefined {
  if (!pane) return "no-pane";
  if (samePath(pane.rawCwd, folder, input.platform)) return "same";
  if (input.folderExists(folder) !== true) return "missing-folder";
  if (pane.hasAgent) return "agent";
  if (isSpawnForm(pane.rawCwd)) return "not-ready";
  if (pane.busy === true) return "busy";
  return undefined;
}

/** Decides, per recorded pane, whether to type `cd` into it or which reason skips it. */
export function planReturn(input: PlannerInput): ReturnPlan {
  const byId = new Map(input.panes.map((pane) => [pane.paneId, pane]));
  const plan: ReturnPlan = { actions: [], skips: [] };
  for (const [paneId, folder] of Object.entries(input.recorded)) {
    const reason = skipReason(byId.get(paneId), folder, input);
    if (reason) {
      plan.skips.push({ paneId, reason });
      continue;
    }
    plan.actions.push({ paneId, text: cdCommand(folder) });
  }
  return plan;
}

/** True while some pane that may need a return has not shown its first prompt yet. */
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
