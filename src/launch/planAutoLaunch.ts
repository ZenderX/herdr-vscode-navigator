import { normalizeCwd } from "../paths";
import { isLeaseLive, type NavigatorLease } from "./navigatorLease";
import type { SessionRecord } from "./sessionState";

/** Longest a recorded takeover stays valid; covers a slow shutdown (save dialogs) before the reload. */
export const PENDING_TAKEOVER_MAX_MS = 120_000;

export interface PlanInput {
  platform: NodeJS.Platform;
  enabled: boolean;
  isNavigatorWindow: boolean;
  record: SessionRecord;
  now: number;
  herdrHostingNow: boolean;
  herdrPath: string | undefined;
  terminals: ReadonlyArray<{ name: string; isInteractedWith: boolean }>;
  terminalName: "herdr";
}

export type NoneReason = "disabled" | "not-navigator" | "not-restored" | "already-hosting" | "herdr-missing";

export type LaunchPlan =
  | { action: "none"; reason: NoneReason }
  | { action: "reuse"; terminalIndex: number; command: "herdr"; focusLabel?: string; focusFolder?: string; cwd?: string }
  | { action: "create"; name: "herdr"; command: "herdr"; cwd?: string; focusLabel?: string; focusFolder?: string };

export function planAutoLaunch(input: PlanInput): LaunchPlan {
  const { platform, enabled, isNavigatorWindow, record, now, herdrHostingNow, herdrPath, terminals, terminalName } = input;
  if (!enabled) return { action: "none", reason: "disabled" };
  if (!isNavigatorWindow) return { action: "none", reason: "not-navigator" };
  if (!record.herdrWasRunning) return { action: "none", reason: "not-restored" };
  if (herdrHostingNow) return { action: "none", reason: "already-hosting" };
  if (herdrPath === undefined) return { action: "none", reason: "herdr-missing" };

  // A pending takeover wins over the remembered space until the caller records `takeoverConsumed`.
  // A takeover whose reload never came (workspace open elsewhere) must not steer a much later launch.
  const pendingTakeoverFolder = now - record.updatedAt <= PENDING_TAKEOVER_MAX_MS ? record.pendingTakeoverFolder : undefined;
  const cwd = normalizeCwd(pendingTakeoverFolder ?? record.lastFolder, platform) ?? undefined;
  const focusLabel = pendingTakeoverFolder === undefined ? record.lastSpaceLabel : undefined;
  const focusFolder = pendingTakeoverFolder;
  const terminalIndex = terminals.findIndex(({ name, isInteractedWith }) => name === terminalName && !isInteractedWith);
  if (terminalIndex >= 0) {
    return { action: "reuse", terminalIndex, command: "herdr", focusLabel, cwd, ...(focusFolder === undefined ? {} : { focusFolder }) };
  }
  return { action: "create", name: "herdr", command: "herdr", cwd, focusLabel, ...(focusFolder === undefined ? {} : { focusFolder }) };
}

/** What the window the user is looking at is, as far as the takeover decision cares. */
export type WindowKind = "single-folder" | "navigator-saved" | "navigator-untitled" | "other";

export interface TakeoverInput {
  enabled: boolean;
  windowKind: WindowKind;
  /** The window's only folder; required for `single-folder` windows. */
  folder: string | undefined;
  record: SessionRecord;
  lease: NavigatorLease | undefined;
  /** Identifies this VS Code launch; shared by all its windows. */
  launchId: string;
  now: number;
}

export type TakeoverPlan =
  | { action: "convert-explicit"; folder: string }
  | { action: "legacy-untitled" }
  | { action: "none"; reason: "disabled" | "not-navigator" | "is-navigator" | "navigator-alive" };

export function planTakeover({ enabled, windowKind, folder, record, lease, launchId, now }: TakeoverInput): TakeoverPlan {
  if (!enabled) return { action: "none", reason: "disabled" };
  if (windowKind === "navigator-untitled") return { action: "legacy-untitled" };
  if (windowKind === "navigator-saved") return { action: "none", reason: "is-navigator" };
  if (windowKind === "other" || folder === undefined) return { action: "none", reason: "not-navigator" };
  if (!record.herdrWasRunning) return { action: "none", reason: "not-navigator" };
  // Only the lease proves a navigator is alive: it expires, whereas a launch id on the record can match forever.
  if (isLeaseLive(lease, launchId, now)) return { action: "none", reason: "navigator-alive" };
  return { action: "convert-explicit", folder };
}
