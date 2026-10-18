import { normalizeCwd } from "../paths";
import type { SessionRecord } from "./sessionState";

export interface PlanInput {
  platform: NodeJS.Platform;
  enabled: boolean;
  isNavigatorWindow: boolean;
  record: SessionRecord;
  herdrHostingNow: boolean;
  herdrPath: string | undefined;
  terminals: ReadonlyArray<{ name: string; isInteractedWith: boolean }>;
  terminalName: "herdr";
}

export type NoneReason = "disabled" | "not-navigator" | "not-restored" | "already-hosting" | "herdr-missing";

export type LaunchPlan =
  | { action: "none"; reason: NoneReason }
  | { action: "reuse"; terminalIndex: number; command: "herdr"; focusLabel?: string; cwd?: string }
  | { action: "create"; name: "herdr"; command: "herdr"; cwd?: string; focusLabel?: string };

export function planAutoLaunch(input: PlanInput): LaunchPlan {
  const { platform, enabled, isNavigatorWindow, record, herdrHostingNow, herdrPath, terminals, terminalName } = input;
  if (!enabled) return { action: "none", reason: "disabled" };
  if (!isNavigatorWindow) return { action: "none", reason: "not-navigator" };
  if (!record.herdrWasRunning) return { action: "none", reason: "not-restored" };
  if (herdrHostingNow) return { action: "none", reason: "already-hosting" };
  if (herdrPath === undefined) return { action: "none", reason: "herdr-missing" };

  const cwd = normalizeCwd(record.lastFolder, platform) ?? undefined;
  const focusLabel = record.lastSpaceLabel;
  const terminalIndex = terminals.findIndex(({ name, isInteractedWith }) => name === terminalName && !isInteractedWith);
  if (terminalIndex >= 0) {
    return { action: "reuse", terminalIndex, command: "herdr", focusLabel, cwd };
  }
  return { action: "create", name: "herdr", command: "herdr", cwd, focusLabel };
}
